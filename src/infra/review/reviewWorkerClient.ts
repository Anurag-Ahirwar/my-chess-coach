import type { RawAnalysis } from "@/core/engine/analysis";
import type { GameRecord } from "@/core/game/types";
import type { GameReview } from "@/core/review";
import type { DeriveRequest, DeriveResponse } from "./protocol";

/** The parts of a Worker the client uses (a fake in unit tests). */
export interface WorkerLike {
  postMessage(message: DeriveRequest): void;
  terminate(): void;
  onmessage: ((event: { data: DeriveResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface ReviewTiming {
  /** deriveReview inside the Worker. */
  deriveMs: number;
  /** Waiting for the opening index (0 after the first request). */
  indexMs: number;
  /** postMessage → result received on the main thread, including the two above. */
  roundTripMs: number;
}

export class ReviewWorkerError extends Error {
  override name = "ReviewWorkerError";
  constructor(
    readonly kind: "index" | "derive" | "crash" | "timeout" | "disposed",
    message: string,
  ) {
    super(message);
  }
}

const abortError = (reason: string) => new DOMException(reason, "AbortError");

interface Pending {
  id: number;
  game: GameRecord;
  raw: RawAnalysis;
  resolve: (review: GameReview) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort?: () => void;
  settled: boolean;
  startedAt?: number;
}

export interface ReviewWorkerClientOptions {
  /** A derivation taking longer is treated as a hung Worker: it is terminated and replaced. */
  timeoutMs?: number;
  onTiming?: (timing: ReviewTiming) => void;
  now?: () => number;
}

/**
 * Main-thread client of the review Worker:
 * - at most ONE request is in the Worker; while it runs, only the latest new request waits
 *   ("latest wins": an older waiting request is rejected with an AbortError), so frequent updates
 *   during an analysis never pile up;
 * - an aborted request is rejected at once; if it is already in the Worker its result is ignored;
 * - a Worker error or a timeout terminates the Worker, rejects the request in it, and the next
 *   request starts a new Worker;
 * - dispose() terminates the Worker and rejects everything outstanding.
 */
export class ReviewWorkerClient {
  private worker: WorkerLike | undefined;
  private inFlight: Pending | undefined;
  private waiting: Pending | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly createWorker: () => WorkerLike,
    private readonly options: ReviewWorkerClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? (() => performance.now());
  }

  derive(game: GameRecord, raw: RawAnalysis, signal?: AbortSignal): Promise<GameReview> {
    if (signal?.aborted) return Promise.reject(abortError("The review was cancelled."));
    return new Promise<GameReview>((resolve, reject) => {
      const pending: Pending = { id: this.nextId++, game, raw, resolve, reject, signal, settled: false };
      if (signal) {
        pending.onAbort = () => this.cancel(pending);
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      if (this.waiting) this.settle(this.waiting, { error: abortError("Superseded by a newer review request.") });
      this.waiting = pending;
      this.pump();
    });
  }

  /** Terminates the Worker and rejects every outstanding request. */
  dispose(): void {
    for (const pending of [this.inFlight, this.waiting]) {
      if (pending) this.settle(pending, { error: new ReviewWorkerError("disposed", "The review worker was closed.") });
    }
    this.inFlight = undefined;
    this.waiting = undefined;
    this.stopWorker();
  }

  private pump(): void {
    if (this.inFlight || !this.waiting) return;
    const pending = this.waiting;
    this.waiting = undefined;
    this.inFlight = pending;
    pending.startedAt = this.now();
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
      worker.postMessage({ type: "derive", id: pending.id, game: pending.game, raw: pending.raw });
    } catch (error) {
      this.crash(error);
      return;
    }
    this.timer = setTimeout(() => this.crash(new ReviewWorkerError("timeout", `The review took longer than ${this.timeoutMs} ms.`)), this.timeoutMs);
  }

  private ensureWorker(): WorkerLike {
    if (!this.worker) {
      const worker = this.createWorker();
      worker.onmessage = (event) => this.onMessage(event.data);
      worker.onerror = (event) => this.crash(event);
      this.worker = worker;
    }
    return this.worker;
  }

  private onMessage(response: DeriveResponse): void {
    const pending = this.inFlight;
    if (!pending || response.id !== pending.id) return; // a late answer for a request already given up
    clearTimeout(this.timer);
    this.inFlight = undefined;
    if (response.type === "result") {
      this.options.onTiming?.({ deriveMs: response.deriveMs, indexMs: response.indexMs, roundTripMs: this.now() - pending.startedAt! });
      this.settle(pending, { review: response.review });
    } else {
      this.settle(pending, { error: new ReviewWorkerError(response.kind, response.message) });
    }
    this.pump();
  }

  private cancel(pending: Pending): void {
    if (this.waiting === pending) this.waiting = undefined;
    // In the Worker: reject now; its answer will be ignored when it arrives.
    this.settle(pending, { error: abortError("The review was cancelled.") });
  }

  private crash(event: unknown): void {
    clearTimeout(this.timer);
    const error =
      event instanceof ReviewWorkerError
        ? event
        : new ReviewWorkerError("crash", `The review worker failed: ${event instanceof Error ? event.message : ((event as { message?: string } | null)?.message ?? "unknown error")}`);
    this.stopWorker();
    const pending = this.inFlight;
    this.inFlight = undefined;
    if (pending) this.settle(pending, { error });
    this.pump(); // a waiting request gets a new Worker
  }

  private stopWorker(): void {
    clearTimeout(this.timer);
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = undefined;
    }
  }

  private settle(pending: Pending, outcome: { review: GameReview } | { error: unknown }): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
    if ("review" in outcome) pending.resolve(outcome.review);
    else pending.reject(outcome.error);
  }
}
