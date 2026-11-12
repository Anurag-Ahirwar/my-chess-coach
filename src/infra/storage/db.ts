import Dexie, { type DexieOptions, type Table } from "dexie";
import type { RawAnalysis } from "@/core/engine/analysis";
import type { StoredGame } from "@/core/game/types";
import type { GameReview } from "@/core/review";

/** A cached past month of Chess.com games (decision D5): past months never change. */
export interface HttpCacheEntry {
  url: string;
  fetchedAt: number;
  body: unknown;
}

/**
 * A cached GameReview (docs/DATA_MODELS.md §11, Phase 3 decision Q1). Derived data, never
 * authoritative: only reviews of complete analyses are stored, and a configHash mismatch means the
 * review is derived again.
 */
export interface ReviewRecord {
  rawAnalysisId: string;
  methodologyVersion: string;
  gameId: string;
  configHash: string;
  derivedAt: number;
  schemaVersion: 1;
  review: GameReview;
}

export const DATABASE_NAME = "chess-coach";

/**
 * IndexedDB schema (docs/DATA_MODELS.md §11, decision D1). Version 1 declares only the tables
 * Phase 2 uses; later phases add tables with a version bump. Migrations never drop user data.
 * Version 2 (Phase 3) adds `reviews`.
 */
export class AppDatabase extends Dexie {
  games!: Table<StoredGame, string>;
  rawAnalyses!: Table<RawAnalysis, string>;
  httpCache!: Table<HttpCacheEntry, string>;
  reviews!: Table<ReviewRecord, [string, string]>;

  constructor(name: string = DATABASE_NAME, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      games: "id, playedAt, createdAt",
      rawAnalyses: "id, gameId, completedAt",
      httpCache: "url, fetchedAt",
    });
    // Version 2 (Phase 3): adds only the review cache. The v1 tables are unchanged, so opening an
    // existing v1 database needs no data migration and touches no stored record.
    this.version(2).stores({
      reviews: "[rawAnalysisId+methodologyVersion], gameId",
    });
  }
}
