import { mergeAnalyses, type RawAnalysis } from "@/core/engine/analysis";
import type { GameRecord, StoredGame } from "@/core/game/types";
import type { PastMonthCache } from "@/infra/chesscom";
import type { AppDatabase } from "./db";
import { StorageError, classifyStorageError, type StorageProblemKind } from "./errors";
import { HttpCacheEntrySchema, RawAnalysisSchema, StoredGameSchema } from "./schemas";

export interface GameRepository {
  /** Saves a game by id: a re-import updates it (keeping createdAt), never duplicates it. */
  put(game: GameRecord, now: number): Promise<StoredGame>;
  get(id: string): Promise<StoredGame | undefined>;
  /** Most recently imported first. Records that fail validation are reported and skipped. */
  list(): Promise<StoredGame[]>;
}

export interface AnalysisRepository {
  get(id: string): Promise<RawAnalysis | undefined>;
  /** Merges with any stored version of the same analysis (never losing a result) and returns what was stored. */
  save(analysis: RawAnalysis, now: number): Promise<RawAnalysis>;
  listForGame(gameId: string): Promise<RawAnalysis[]>;
}

export interface Repositories {
  games: GameRepository;
  analyses: AnalysisRepository;
  pastMonths: PastMonthCache;
}

/** Called for problems found while reading (e.g. an invalid record that is skipped). */
export type ProblemReporter = (kind: StorageProblemKind, detail: string) => void;

function toStored(game: GameRecord, existing: StoredGame | undefined, now: number): StoredGame {
  const { createdAt: _c, updatedAt: _u, schemaVersion: _s, ...record } = game as Partial<StoredGame> & GameRecord;
  return { ...record, schemaVersion: 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
}

const newestFirst = (a: StoredGame, b: StoredGame) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;

/** Runs a storage operation, converting any failure into a StorageError with a kind. */
async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(classifyStorageError(error), error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------- IndexedDB (Dexie)

export function dexieRepositories(db: AppDatabase, report: ProblemReporter): Repositories {
  const readGame = (row: unknown, key: string): StoredGame | undefined => {
    const parsed = StoredGameSchema.safeParse(row);
    if (parsed.success) return parsed.data;
    report("invalid_record", `games/${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return undefined;
  };
  const readAnalysis = (row: unknown, key: string): RawAnalysis | undefined => {
    const parsed = RawAnalysisSchema.safeParse(row);
    if (parsed.success) return parsed.data;
    report("invalid_record", `rawAnalyses/${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return undefined;
  };

  const games: GameRepository = {
    put: (game, now) =>
      guard(() =>
        db.transaction("rw", db.games, async () => {
          const row = await db.games.get(game.id);
          const existing = row === undefined ? undefined : readGame(row, game.id);
          if (row !== undefined && existing === undefined) {
            throw new StorageError("invalid_record", `The saved copy of game ${game.id} can't be read, so it was not overwritten.`);
          }
          const stored = toStored(game, existing, now);
          await db.games.put(stored);
          return stored;
        }),
      ),
    get: (id) => guard(async () => {
      const row = await db.games.get(id);
      return row === undefined ? undefined : readGame(row, id);
    }),
    list: () => guard(async () => {
      const rows = await db.games.toArray();
      return rows.flatMap((row) => readGame(row, String((row as { id?: unknown }).id)) ?? []).sort(newestFirst);
    }),
  };

  const analyses: AnalysisRepository = {
    get: (id) => guard(async () => {
      const row = await db.rawAnalyses.get(id);
      return row === undefined ? undefined : readAnalysis(row, id);
    }),
    save: (analysis, now) =>
      guard(() =>
        db.transaction("rw", db.rawAnalyses, async () => {
          const row = await db.rawAnalyses.get(analysis.id);
          let next = analysis;
          if (row !== undefined) {
            const stored = readAnalysis(row, analysis.id);
            if (!stored) {
              throw new StorageError("invalid_record", `The saved analysis ${analysis.id} can't be read, so it was not overwritten.`);
            }
            next = mergeAnalyses(stored, analysis, now);
          }
          await db.rawAnalyses.put(next);
          return next;
        }),
      ),
    listForGame: (gameId) => guard(async () => {
      const rows = await db.rawAnalyses.where("gameId").equals(gameId).toArray();
      return rows.flatMap((row) => readAnalysis(row, row.id) ?? []);
    }),
  };

  const pastMonths: PastMonthCache = {
    get: async (url) => {
      const row = await db.httpCache.get(url);
      if (row === undefined) return undefined;
      const parsed = HttpCacheEntrySchema.safeParse(row);
      if (!parsed.success) {
        report("invalid_record", `httpCache/${url}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
        return undefined; // refetched; the bad row is left as it is
      }
      return parsed.data.body;
    },
    set: async (url, body) => {
      await db.httpCache.put({ url, fetchedAt: Date.now(), body });
    },
  };

  return { games, analyses, pastMonths };
}

// ---------------------------------------------------------------- In memory (fallback)

/** Same behaviour as the Dexie repositories, kept for this tab only (used when IndexedDB fails). */
export function memoryRepositories(): Repositories {
  const gameRows = new Map<string, StoredGame>();
  const analysisRows = new Map<string, RawAnalysis>();
  const monthRows = new Map<string, unknown>();
  const copy = <T>(value: T): T => structuredClone(value);

  return {
    games: {
      put: (game, now) => {
        const stored = toStored(game, gameRows.get(game.id), now);
        gameRows.set(game.id, copy(stored));
        return Promise.resolve(stored);
      },
      get: (id) => Promise.resolve(gameRows.has(id) ? copy(gameRows.get(id)!) : undefined),
      list: () => Promise.resolve([...gameRows.values()].map(copy).sort(newestFirst)),
    },
    analyses: {
      get: (id) => Promise.resolve(analysisRows.has(id) ? copy(analysisRows.get(id)!) : undefined),
      save: (analysis, now) => {
        const stored = analysisRows.get(analysis.id);
        const next = stored ? mergeAnalyses(stored, analysis, now) : analysis;
        analysisRows.set(analysis.id, copy(next));
        return Promise.resolve(next);
      },
      listForGame: (gameId) => Promise.resolve([...analysisRows.values()].filter((a) => a.gameId === gameId).map(copy)),
    },
    pastMonths: {
      get: (url) => Promise.resolve(monthRows.get(url)),
      set: (url, body) => {
        monthRows.set(url, body);
        return Promise.resolve();
      },
    },
  };
}
