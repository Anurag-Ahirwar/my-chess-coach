import type { WorkerLike } from "./reviewWorkerClient";

/** Starts the real review Worker (bundled by Vite as a module Worker). */
export function startReviewWorker(): WorkerLike {
  return new Worker(new URL("./review.worker.ts", import.meta.url), { type: "module", name: "review" }) as unknown as WorkerLike;
}
