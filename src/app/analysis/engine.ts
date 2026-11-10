import { EnginePool, defaultPoolSize } from "@/infra/engine/enginePool";
import { workerTransportFactory } from "@/infra/engine/transport";
import type { WorkerCountPreference } from "../prefs";

/** The engine count for a preference: "auto" is the spec D7 default for this machine. */
export function resolvePoolSize(preference: WorkerCountPreference): number {
  if (preference !== "auto") return preference;
  return defaultPoolSize(typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency);
}

let pool: EnginePool | undefined;

/**
 * The app's engine pool (browser Workers), created on first use. A different size replaces the
 * pool; the analysis controller only asks for it when no analysis is running.
 */
export function getEnginePool(size: number): EnginePool {
  if (pool && pool.size === size) return pool;
  void pool?.shutdown();
  pool = new EnginePool(workerTransportFactory(), { size });
  return pool;
}
