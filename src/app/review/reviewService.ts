import { isAnalysisComplete, type RawAnalysis } from "@/core/engine/analysis";
import type { GameRecord } from "@/core/game/types";
import { METHODOLOGY_V1, configHash, type MethodologyConfig } from "@/core/methodology/v1";
import type { GameReview } from "@/core/review";
import type { ReviewRepository } from "@/infra/storage/repositories";
import { STORAGE_WAIT_MS, isSlowStorage, withinStorageWait } from "../storage";

/** Derives a review from a raw analysis (in the browser: the review Worker). */
export interface ReviewDeriver {
  derive(game: GameRecord, raw: RawAnalysis, signal?: AbortSignal): Promise<GameReview>;
}

export interface ReviewServiceDeps {
  reviews: () => Promise<ReviewRepository>;
  deriver: ReviewDeriver;
  /** The config the deriver uses; the cache is checked against it. */
  config?: MethodologyConfig;
  onStorageError?: (error: unknown) => void;
  now?: () => number;
  /** The limit on waiting for the cache; after it the review is derived / shown without it. */
  storageWaitMs?: number;
}

export interface LoadedReview {
  review: GameReview;
  /** "cache": read from IndexedDB with no derivation; "derived": computed now. */
  source: "cache" | "derived";
  /** Whether this review is (now) stored in the cache. */
  cached: boolean;
}

/**
 * Gets the review of a raw analysis (docs/DATA_MODELS.md §6, §11; Phase 3 decisions Q1, B6):
 * - only COMPLETE analyses are cached; a partial review is derived again every time;
 * - a cached review is used only if its methodology version (part of the key), config hash and
 *   game match; anything else is derived again and the cache entry replaced;
 * - storage problems never block a review: it is derived in memory and the problem reported. Storage
 *   that is merely slow isn't reported here, because a review is derived data and nothing is lost;
 * - the raw analysis is only read, never written (reviews are derived, never authoritative).
 */
export async function loadReview(game: GameRecord, raw: RawAnalysis, deps: ReviewServiceDeps, signal?: AbortSignal): Promise<LoadedReview> {
  const config = deps.config ?? METHODOLOGY_V1;
  const hash = configHash(config);
  const complete = isAnalysisComplete(raw);
  const waitMs = deps.storageWaitMs ?? STORAGE_WAIT_MS;
  const report = (error: unknown) => {
    if (!isSlowStorage(error)) deps.onStorageError?.(error);
  };
  let repository: ReviewRepository | undefined;

  if (complete) {
    try {
      const { opened, record } = await withinStorageWait(
        deps.reviews().then(async (r) => ({ opened: r, record: await r.get(raw.id, config.version) })),
        waitMs,
      );
      repository = opened;
      if (record && record.configHash === hash && record.gameId === game.id && record.review.coverage.complete) {
        return { review: record.review, source: "cache", cached: true };
      }
    } catch (error) {
      report(error);
    }
  }

  signal?.throwIfAborted();
  const review = await deps.deriver.derive(game, raw, signal);
  signal?.throwIfAborted();

  if (complete && review.coverage.complete && repository) {
    try {
      const put = repository.put({
        rawAnalysisId: raw.id,
        methodologyVersion: config.version,
        gameId: game.id,
        configHash: hash,
        derivedAt: (deps.now ?? Date.now)(),
        schemaVersion: 1,
        review,
      });
      await withinStorageWait(put, waitMs);
      return { review, source: "derived", cached: true };
    } catch (error) {
      report(error);
    }
  }
  return { review, source: "derived", cached: false };
}
