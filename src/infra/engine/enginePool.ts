import { EngineError } from "./errors";
import {
  EngineWorker,
  type EngineInfo,
  type EngineWorkerOptions,
  type SearchOutcome,
  type SearchRequest,
} from "./engineWorker";
import type { EngineTransportFactory } from "./transport";

export type JobPriority = "interactive" | "review" | "batch";
const PRIORITY_ORDER: readonly JobPriority[] = ["interactive", "review", "batch"];

export interface EnginePoolOptions {
  /** Number of single-threaded engines (docs/TECHNICAL_ARCHITECTURE.md D7). */
  size: number;
  worker?: EngineWorkerOptions;
  /** Engines that fail to start in a row before every queued job is rejected as unavailable. */
  maxConsecutiveStartFailures?: number;
}

/** D7 default: one engine per spare core, between 1 and 4. Adjusted from benchmarks in Stage 4. */
export function defaultPoolSize(hardwareConcurrency: number | undefined): number {
  const cores = hardwareConcurrency && hardwareConcurrency > 0 ? hardwareConcurrency : 2;
  return Math.min(4, Math.max(1, cores - 1));
}

interface Job {
  priority: JobPriority;
  request: SearchRequest;
  signal: AbortSignal | undefined;
  attempts: number;
  resolve: (outcome: SearchOutcome) => void;
  reject: (error: Error) => void;
  detach: () => void;
}

interface Slot {
  engine: EngineWorker;
  busy: boolean;
}

/** Errors after which a job is retried once on a fresh engine. */
const RETRYABLE = new Set(["timeout", "crashed"]);

/**
 * A pool of single-threaded engines (docs/TECHNICAL_ARCHITECTURE.md §6.1): a FIFO queue per
 * priority, jobs assigned to idle engines, engines started lazily up to `size`. An engine
 * that fails is discarded and replaced; its job is retried once, then rejected so the
 * position can be marked failed. Cancelled jobs are never retried.
 */
export class EnginePool {
  private readonly slots = new Set<Slot>();
  private readonly queues: Record<JobPriority, Job[]> = { interactive: [], review: [], batch: [] };
  private starting = 0;
  private startFailures = 0;
  private closed = false;
  private engineInfo: EngineInfo | undefined;
  readonly size: number;
  private readonly maxStartFailures: number;

  constructor(
    private readonly factory: EngineTransportFactory,
    private readonly options: EnginePoolOptions,
  ) {
    if (!Number.isInteger(options.size) || options.size < 1) throw new RangeError(`Invalid pool size: ${options.size}`);
    this.size = options.size;
    this.maxStartFailures = options.maxConsecutiveStartFailures ?? 3;
  }

  /** Identity reported by the first engine that started. */
  get info(): EngineInfo | undefined {
    return this.engineInfo;
  }

  get stats(): { engines: number; busy: number; starting: number; queued: number } {
    return {
      engines: this.slots.size,
      busy: [...this.slots].filter((slot) => slot.busy).length,
      starting: this.starting,
      queued: PRIORITY_ORDER.reduce((sum, p) => sum + this.queues[p].length, 0),
    };
  }

  submit(request: SearchRequest, options: { priority?: JobPriority; signal?: AbortSignal } = {}): Promise<SearchOutcome> {
    const { priority = "review", signal } = options;
    if (this.closed) return Promise.reject(new EngineError("quit", "The engine pool has been shut down."));
    if (signal?.aborted) return Promise.reject(new EngineError("cancelled", "The search was cancelled."));
    return new Promise<SearchOutcome>((resolve, reject) => {
      const job: Job = { priority, request, signal, attempts: 0, resolve, reject, detach: () => undefined };
      const onAbort = () => {
        // A queued job (including one waiting for its retry) is removed here; a running one is stopped by its engine.
        const queue = this.queues[job.priority];
        const index = queue.indexOf(job);
        if (index >= 0) {
          queue.splice(index, 1);
          job.detach();
          reject(new EngineError("cancelled", "The search was cancelled."));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      job.detach = () => signal?.removeEventListener("abort", onAbort);
      this.queues[priority].push(job);
      this.dispatch();
    });
  }

  /** Rejects every queued and running job with `quit` and ends all engines. */
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const priority of PRIORITY_ORDER) {
      for (const job of this.queues[priority].splice(0)) {
        job.detach();
        job.reject(new EngineError("quit", "The engine pool has been shut down."));
      }
    }
    await Promise.all([...this.slots].map((slot) => slot.engine.quit()));
    this.slots.clear();
  }

  private nextJob(): Job | undefined {
    for (const priority of PRIORITY_ORDER) {
      const job = this.queues[priority].shift();
      if (job) return job;
    }
    return undefined;
  }

  private hasQueuedJobs(): boolean {
    return PRIORITY_ORDER.some((priority) => this.queues[priority].length > 0);
  }

  private dispatch(): void {
    if (this.closed) return;
    while (this.hasQueuedJobs()) {
      const idle = [...this.slots].find((slot) => !slot.busy && slot.engine.state === "ready");
      if (idle) {
        this.run(idle, this.nextJob()!);
        continue;
      }
      // Start just enough engines for the waiting jobs, up to the pool size.
      // After repeated start failures, stop starting engines (no tight retry loop) and keep using the healthy ones.
      const queued = PRIORITY_ORDER.reduce((sum, p) => sum + this.queues[p].length, 0);
      const canStart = this.startFailures < this.maxStartFailures;
      if (canStart && this.slots.size + this.starting < this.size && this.starting < queued) {
        this.startEngine();
        continue;
      }
      return;
    }
  }

  private startEngine(): void {
    this.starting++;
    const engine = new EngineWorker(this.factory, this.options.worker);
    engine.start().then(
      (info) => {
        this.starting--;
        this.startFailures = 0;
        this.engineInfo ??= info;
        if (this.closed) {
          void engine.quit();
          return;
        }
        this.slots.add({ engine, busy: false });
        this.dispatch();
      },
      (error: unknown) => {
        this.starting--;
        void engine.quit();
        if (this.closed) return;
        this.startFailures++;
        if (this.startFailures >= this.maxStartFailures && this.slots.size === 0 && this.starting === 0) {
          // No engine can run: fail the waiting jobs, and allow a fresh attempt for the next submit.
          const reason = error instanceof Error ? error.message : String(error);
          this.rejectAllQueued(new EngineError("unavailable", `The engine could not be started: ${reason}`));
          this.startFailures = 0;
          return;
        }
        this.dispatch();
      },
    );
  }

  private run(slot: Slot, job: Job): void {
    slot.busy = true;
    job.attempts++;
    slot.engine.search(job.request, job.signal).then(
      (outcome) => {
        slot.busy = false;
        job.detach();
        job.resolve(outcome);
        this.dispatch();
      },
      (error: unknown) => {
        slot.busy = false;
        if (slot.engine.state === "failed" || slot.engine.state === "terminated") {
          this.slots.delete(slot);
          void slot.engine.quit();
        }
        const engineError = error instanceof EngineError ? error : undefined;
        if (engineError && RETRYABLE.has(engineError.kind) && job.attempts < 2 && !this.closed && !job.signal?.aborted) {
          // Retry once, at the front of its queue, on a healthy or fresh engine.
          this.queues[job.priority].unshift(job);
        } else {
          job.detach();
          job.reject(
            engineError && RETRYABLE.has(engineError.kind)
              ? new EngineError(engineError.kind, `${engineError.message} (failed again after one retry)`)
              : error instanceof Error
                ? error
                : new Error(String(error)),
          );
        }
        this.dispatch();
      },
    );
  }

  private rejectAllQueued(error: EngineError): void {
    for (const priority of PRIORITY_ORDER) {
      for (const job of this.queues[priority].splice(0)) {
        job.detach();
        job.reject(error);
      }
    }
  }
}
