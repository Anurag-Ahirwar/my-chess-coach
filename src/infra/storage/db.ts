import Dexie, { type DexieOptions, type Table } from "dexie";
import type { RawAnalysis } from "@/core/engine/analysis";
import type { StoredGame } from "@/core/game/types";

/** A cached past month of Chess.com games (decision D5): past months never change. */
export interface HttpCacheEntry {
  url: string;
  fetchedAt: number;
  body: unknown;
}

export const DATABASE_NAME = "chess-coach";

/**
 * IndexedDB schema (docs/DATA_MODELS.md §11, decision D1). Version 1 declares only the tables
 * Phase 2 uses; later phases add tables with a version bump. Migrations never drop user data.
 */
export class AppDatabase extends Dexie {
  games!: Table<StoredGame, string>;
  rawAnalyses!: Table<RawAnalysis, string>;
  httpCache!: Table<HttpCacheEntry, string>;

  constructor(name: string = DATABASE_NAME, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      games: "id, playedAt, createdAt",
      rawAnalyses: "id, gameId, completedAt",
      httpCache: "url, fetchedAt",
    });
  }
}
