import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawAnalysis } from "@/core/engine/analysis";
import type { GameRecord } from "@/core/game/types";
import { METHODOLOGY_V1 } from "@/core/methodology/v1";
import { EMPTY_OPENING_INDEX } from "@/core/openings";
import { deriveReview } from "@/core/review";
import type { DeriveRequest, DeriveResponse } from "@/infra/review/protocol";
import { ReviewWorkerClient, type ReviewTiming, type WorkerLike } from "@/infra/review/reviewWorkerClient";
import { gameFromUci } from "../../helpers/games";
import { rawFromScores } from "../../helpers/review";

/** A scripted Worker: requests are held until the test answers them. */
class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: DeriveResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  requests: DeriveRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(message: DeriveRequest): void {
    this.requests.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Answers a request the way the real Worker does. */
  answer(request = this.requests.at(-1)!): void {
    const review = deriveReview({ game: request.game, raw: request.raw, index: EMPTY_OPENING_INDEX, config: METHODOLOGY_V1 });
    this.onmessage?.({ data: { type: "result", id: request.id, review, deriveMs: 12, indexMs: 3 } });
  }
  fail(request = this.requests.at(-1)!): void {
    this.onmessage?.({ data: { type: "error", id: request.id, kind: "derive", message: "bad input" } });
  }
}

async function sample(): Promise<{ game: GameRecord; raw: RawAnalysis }> {
  const game = await gameFromUci(["e2e4", "e7e5"]);
  return { game, raw: rawFromScores(game, [0, 20, 25].map((value) => ({ score: { kind: "cp" as const, value } }))) };
}

afterEach(() => {
  FakeWorker.all = [];
  vi.useRealTimers();
});

describe("ReviewWorkerClient", () => {
  it("starts the Worker lazily, sends one request and resolves with its review and timing", async () => {
    const timings: ReviewTiming[] = [];
    let clock = 100;
    const client = new ReviewWorkerClient(() => new FakeWorker(), { onTiming: (t) => timings.push(t), now: () => clock });
    expect(FakeWorker.all).toHaveLength(0);
    const { game, raw } = await sample();
    const promise = client.derive(game, raw);
    const worker = FakeWorker.all[0]!;
    expect(worker.requests).toHaveLength(1);
    clock = 160;
    worker.answer();
    const review = await promise;
    expect(review.moves).toHaveLength(2);
    expect(timings).toEqual([{ deriveMs: 12, indexMs: 3, roundTripMs: 60 }]);
  });

  it("keeps one request in the Worker; only the latest waiting request is sent next (latest wins)", async () => {
    const client = new ReviewWorkerClient(() => new FakeWorker());
    const { game, raw } = await sample();
    const first = client.derive(game, raw);
    const second = client.derive(game, raw);
    const third = client.derive(game, raw);
    const worker = FakeWorker.all[0]!;
    expect(worker.requests).toHaveLength(1);
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    worker.answer();
    await expect(first).resolves.toBeDefined();
    expect(worker.requests).toHaveLength(2); // the third, never the second
    worker.answer();
    await expect(third).resolves.toBeDefined();
  });

  it("cancels a waiting request, and ignores the late answer of an in-flight one", async () => {
    const client = new ReviewWorkerClient(() => new FakeWorker());
    const { game, raw } = await sample();
    const inFlight = new AbortController();
    const first = client.derive(game, raw, inFlight.signal);
    const waiting = new AbortController();
    const second = client.derive(game, raw, waiting.signal);
    waiting.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    inFlight.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const worker = FakeWorker.all[0]!;
    worker.answer(); // late answer: ignored, no unhandled rejection
    const third = client.derive(game, raw);
    expect(worker.requests).toHaveLength(2);
    worker.answer();
    await expect(third).resolves.toBeDefined();
    await expect(client.derive(game, raw, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with the Worker's error message when derivation fails, and keeps the Worker", async () => {
    const client = new ReviewWorkerClient(() => new FakeWorker());
    const { game, raw } = await sample();
    const promise = client.derive(game, raw);
    FakeWorker.all[0]!.fail();
    await expect(promise).rejects.toMatchObject({ name: "ReviewWorkerError", kind: "derive", message: "bad input" });
    const next = client.derive(game, raw);
    expect(FakeWorker.all).toHaveLength(1);
    FakeWorker.all[0]!.answer();
    await expect(next).resolves.toBeDefined();
  });

  it("replaces a crashed Worker and sends the waiting request to the new one", async () => {
    const client = new ReviewWorkerClient(() => new FakeWorker());
    const { game, raw } = await sample();
    const first = client.derive(game, raw);
    const second = client.derive(game, raw);
    const crashed = FakeWorker.all[0]!;
    crashed.onerror?.({ message: "script error" });
    await expect(first).rejects.toMatchObject({ kind: "crash" });
    await expect(first).rejects.toThrow(/script error/);
    expect(crashed.terminated).toBe(true);
    const fresh = FakeWorker.all[1]!;
    expect(fresh.requests).toHaveLength(1);
    fresh.answer();
    await expect(second).resolves.toBeDefined();
  });

  it("treats a request that never answers as a hung Worker: terminates it after the timeout", async () => {
    vi.useFakeTimers();
    const client = new ReviewWorkerClient(() => new FakeWorker(), { timeoutMs: 1000 });
    const { game, raw } = await sample();
    const promise = client.derive(game, raw);
    const rejection = expect(promise).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(FakeWorker.all[0]!.terminated).toBe(true);
  });

  it("dispose() terminates the Worker and rejects everything outstanding", async () => {
    const client = new ReviewWorkerClient(() => new FakeWorker());
    const { game, raw } = await sample();
    const first = client.derive(game, raw);
    const second = client.derive(game, raw);
    client.dispose();
    await expect(first).rejects.toMatchObject({ kind: "disposed" });
    await expect(second).rejects.toMatchObject({ kind: "disposed" });
    expect(FakeWorker.all[0]!.terminated).toBe(true);
  });

  it("reports a Worker that can't even be started as a crash", async () => {
    const client = new ReviewWorkerClient(() => {
      throw new Error("Worker is not supported");
    });
    const { game, raw } = await sample();
    await expect(client.derive(game, raw)).rejects.toMatchObject({ kind: "crash" });
  });
});
