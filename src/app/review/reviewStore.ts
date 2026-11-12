import { create } from "zustand";
import { isAnalysisComplete, type RawAnalysis } from "@/core/engine/analysis";
import type { GameRecord } from "@/core/game/types";
import type { GameReview } from "@/core/review";
import { startReviewWorker } from "@/infra/review/browserWorker";
import { ReviewWorkerClient, type ReviewTiming } from "@/infra/review/reviewWorkerClient";
import { useAnalysis, type AnalysisView } from "../analysis/analysisStore";
import { useGames } from "../games";
import { getRepositories, reportStorageError } from "../storage";
import { loadReview, type ReviewDeriver } from "./reviewService";

/**
 * The review shown for the current game and analysis (Phase 3, Stage 2). It follows the analysis
 * store: a saved or finished analysis is reviewed at once (from the cache when possible); while an
 * analysis runs, the partial review is refreshed at most every REFRESH_MS, the latest update
 * winning. Partial reviews are never cached and carry no final numbers (core/review).
 */

export interface ReviewTimings extends Partial<ReviewTiming> {
  /** loadReview from start to result (cache read, or Worker round trip and cache write). */
  totalMs: number;
}

export interface ReviewState {
  analysisId: string | undefined;
  status: "idle" | "loading" | "ready" | "error";
  review: GameReview | undefined;
  source: "cache" | "derived" | undefined;
  error: string | undefined;
  timings: ReviewTimings | undefined;
}

const REFRESH_MS = 500;

export const useReview = create<ReviewState>(() => ({
  analysisId: undefined,
  status: "idle",
  review: undefined,
  source: undefined,
  error: undefined,
  timings: undefined,
}));

let lastTiming: ReviewTiming | undefined;
let client: ReviewWorkerClient | undefined;
const workerDeriver = (): ReviewDeriver => {
  client ??= new ReviewWorkerClient(startReviewWorker, { onTiming: (t) => (lastTiming = t) });
  return client;
};

let controller: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastStart = 0;

/** Starts (or replaces) the review of `raw`; the previous request is cancelled. */
export async function requestReview(game: GameRecord, raw: RawAnalysis, deriver: ReviewDeriver = workerDeriver()): Promise<void> {
  controller?.abort();
  const own = new AbortController();
  controller = own;
  lastStart = performance.now();
  const keepShowing = useReview.getState().analysisId === raw.id;
  useReview.setState({ analysisId: raw.id, status: "loading", error: undefined, ...(keepShowing ? {} : { review: undefined, source: undefined }) });
  const start = performance.now();
  lastTiming = undefined;
  try {
    const result = await loadReview(game, raw, { reviews: async () => (await getRepositories()).reviews, deriver, onStorageError: reportStorageError }, own.signal);
    if (controller !== own) return;
    useReview.setState({
      status: "ready",
      review: result.review,
      source: result.source,
      timings: { totalMs: performance.now() - start, ...(result.source === "derived" && lastTiming ? lastTiming : {}) },
    });
  } catch (error) {
    if (controller !== own || (error instanceof DOMException && error.name === "AbortError")) return;
    useReview.setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }
}

export function clearReview(): void {
  controller?.abort();
  controller = undefined;
  clearTimeout(timer);
  useReview.setState({ analysisId: undefined, status: "idle", review: undefined, source: undefined, error: undefined, timings: undefined });
}

/** Reacts to one analysis view: immediately when the analysis is at rest, throttled while it runs. */
function onAnalysisView(view: AnalysisView | undefined): void {
  const raw = view?.analysis;
  const game = view ? useGames.getState().byId[view.gameId] : undefined;
  if (!view || !raw || !game || raw.completedCount === 0) {
    if (useReview.getState().analysisId !== undefined && useReview.getState().analysisId !== raw?.id) clearReview();
    return;
  }
  clearTimeout(timer);
  const running = view.status === "running" || view.status === "pending";
  const wait = running && !isAnalysisComplete(raw) ? Math.max(0, REFRESH_MS - (performance.now() - lastStart)) : 0;
  timer = setTimeout(() => void requestReview(game, raw, syncDeriver ?? workerDeriver()), wait);
}

let unsubscribe: (() => void) | undefined;
let syncDeriver: ReviewDeriver | undefined;

/**
 * Keeps the review in step with the analysis store. Call once; later calls do nothing.
 * `deriver` replaces the Worker (tests).
 */
export function startReviewSync(options: { deriver?: ReviewDeriver } = {}): void {
  if (unsubscribe) return;
  syncDeriver = options.deriver;
  unsubscribe = useAnalysis.subscribe((state, previous) => {
    if (state.view?.analysis !== previous.view?.analysis || state.view?.analysisId !== previous.view?.analysisId) onAnalysisView(state.view);
  });
  onAnalysisView(useAnalysis.getState().view);
}

/** For tests: stop following the analysis store and forget everything. */
export function stopReviewSyncForTests(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  syncDeriver = undefined;
  lastStart = Number.NEGATIVE_INFINITY;
  clearReview();
}
