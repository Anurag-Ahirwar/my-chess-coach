import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LITE_SINGLE_ENGINE,
  PRESETS,
  applyPositionResult,
  createRawAnalysis,
  type PositionResult,
  type RawAnalysis,
} from "@/core/engine/analysis";
import type { AppDatabase } from "@/infra/storage/db";
import { StorageError, classifyStorageError } from "@/infra/storage/errors";
import { dexieRepositories, memoryRepositories, type Repositories } from "@/infra/storage/repositories";
import { gameFromUci } from "../../../helpers/games";
import { testDatabase } from "../../../helpers/storage";

const opened: AppDatabase[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function dexie(name?: string) {
  const db = testDatabase(name);
  opened.push(db);
  const report = vi.fn();
  return { db, report, repos: dexieRepositories(db, report) };
}

const done = (positionIndex: number, value = 10): PositionResult => ({
  positionIndex,
  status: "done",
  lines: [{ rank: 1, score: { kind: "cp", value }, depth: 10, nodes: 100, pv: ["e2e4"] }],
  bestMove: "e2e4",
  timeMs: 1,
});
const failed = (positionIndex: number): PositionResult => ({ positionIndex, status: "failed", error: "timeout", lines: [] });

async function analysisFor(gameId: string, positions: number, preset = PRESETS.quick) {
  return createRawAnalysis({ gameId, positionCount: positions, engine: LITE_SINGLE_ENGINE, settings: preset, now: 100 });
}

/** The same behaviour is required of the IndexedDB and the in-memory repositories. */
const implementations: [string, () => Repositories][] = [
  ["IndexedDB (Dexie)", () => dexie().repos],
  ["memory fallback", () => memoryRepositories()],
];

describe.each(implementations)("%s repositories", (_name, make) => {
  it("saves a game and reads it back with schema version and timestamps", async () => {
    const repos = make();
    const game = await gameFromUci(["e2e4", "e7e5"]);
    const stored = await repos.games.put(game, 1000);
    expect(stored).toMatchObject({ id: game.id, schemaVersion: 1, createdAt: 1000, updatedAt: 1000 });
    expect(await repos.games.get(game.id)).toEqual(stored);
    expect(await repos.games.get("missing")).toBeUndefined();
  });

  it("does not duplicate a re-imported game, keeps createdAt, and keeps its analyses linked", async () => {
    const repos = make();
    const game = await gameFromUci(["e2e4"]);
    await repos.games.put(game, 1000);
    await repos.analyses.save(applyPositionResult(await analysisFor(game.id, 2), done(0), 1), 1);
    const again = await repos.games.put({ ...game, warnings: ["re-imported"] }, 2000);
    expect(again).toMatchObject({ createdAt: 1000, updatedAt: 2000, warnings: ["re-imported"] });
    expect(await repos.games.list()).toHaveLength(1);
    expect(await repos.analyses.listForGame(game.id)).toHaveLength(1);
  });

  it("lists games newest import first", async () => {
    const repos = make();
    const a = await gameFromUci(["e2e4"]);
    const b = await gameFromUci(["d2d4"]);
    await repos.games.put(a, 1000);
    await repos.games.put(b, 2000);
    expect((await repos.games.list()).map((g) => g.id)).toEqual([b.id, a.id]);
  });

  it("keeps analyses with different settings for the same game apart", async () => {
    const repos = make();
    const quick = applyPositionResult(await analysisFor("g", 2, PRESETS.quick), done(0, 11), 1);
    const standard = applyPositionResult(await analysisFor("g", 2, PRESETS.standard), done(0, 22), 1);
    expect(quick.id).not.toBe(standard.id);
    await repos.analyses.save(quick, 1);
    await repos.analyses.save(standard, 1);
    expect(await repos.analyses.listForGame("g")).toHaveLength(2);
    expect((await repos.analyses.get(quick.id))!.positions[0]).toEqual(done(0, 11));
    expect((await repos.analyses.get(standard.id))!.positions[0]).toEqual(done(0, 22));
  });

  it("merges saves so no analysed position is ever lost or downgraded", async () => {
    const repos = make();
    const empty = await analysisFor("g", 3);
    await repos.analyses.save(applyPositionResult(applyPositionResult(empty, done(0), 1), done(1), 1), 1);
    // Another writer only has position 2, plus a failure for position 1:
    const other = applyPositionResult(applyPositionResult(empty, failed(1), 2), done(2), 2);
    const merged = await repos.analyses.save(other, 3);
    expect(merged.positions.map((p) => p?.status)).toEqual(["done", "done", "done"]);
    expect(merged.completedCount).toBe(3);
    expect(merged.completedAt).toBe(3);
    expect(await repos.analyses.get(empty.id)).toEqual(merged);
  });

  it("returns copies, so callers can't change stored data by accident", async () => {
    const repos = make();
    const game = await gameFromUci(["e2e4"]);
    await repos.games.put(game, 1);
    const read = (await repos.games.get(game.id))!;
    read.plies.length = 0;
    expect((await repos.games.get(game.id))!.plies).toHaveLength(1);
  });

  it("caches past months by URL", async () => {
    const repos = make();
    const url = "https://api.chess.com/pub/player/x/games/2026/09";
    expect(await repos.pastMonths.get(url)).toBeUndefined();
    await repos.pastMonths.set(url, { games: [{ a: 1 }] });
    expect(await repos.pastMonths.get(url)).toEqual({ games: [{ a: 1 }] });
  });
});

describe("IndexedDB-specific behaviour", () => {
  it("keeps games, analyses and cached months across a close and reopen (a page reload)", async () => {
    const name = `reload-${Date.now()}`;
    const first = dexie(name);
    const game = await gameFromUci(["e2e4", "e7e5"]);
    await first.repos.games.put(game, 1);
    const analysis = applyPositionResult(await analysisFor(game.id, 3), done(0), 1);
    await first.repos.analyses.save(analysis, 1);
    await first.repos.pastMonths.set("https://api.chess.com/pub/player/x/games/2026/01", { games: [] });
    first.db.close();

    const second = dexie(name);
    expect((await second.repos.games.get(game.id))?.plies).toHaveLength(2);
    expect(await second.repos.analyses.get(analysis.id)).toEqual(analysis);
    expect(await second.repos.pastMonths.get("https://api.chess.com/pub/player/x/games/2026/01")).toEqual({ games: [] });
  });

  it("reports an invalid game record, skips it, and refuses to overwrite it", async () => {
    const { db, repos, report } = dexie();
    const broken = { id: "pgn:broken", schemaVersion: 99, plies: "not an array" };
    await db.games.put(broken as never);
    expect(await repos.games.get("pgn:broken")).toBeUndefined();
    expect(await repos.games.list()).toEqual([]);
    expect(report).toHaveBeenCalledWith("invalid_record", expect.stringContaining("games/pgn:broken"));

    const game = { ...(await gameFromUci(["e2e4"])), id: "pgn:broken" };
    const error = await repos.games.put(game, 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).kind).toBe("invalid_record");
    expect(await db.games.get("pgn:broken")).toEqual(broken); // untouched
  });

  it("refuses to overwrite an analysis record it can't read", async () => {
    const { db, repos } = dexie();
    const analysis = await analysisFor("g", 2);
    const broken = { ...analysis, positions: "garbage" };
    await db.rawAnalyses.put(broken as never);
    await expect(repos.analyses.save(analysis, 1)).rejects.toMatchObject({ kind: "invalid_record" });
    expect(await db.rawAnalyses.get(analysis.id)).toEqual(broken);
  });

  it("rejects a stored analysis that contains a mate-0 score or a mismatched slot", async () => {
    const { db, repos, report } = dexie();
    const base = await analysisFor("g", 2);
    const mateZero: RawAnalysis = {
      ...base,
      positions: [
        {
          positionIndex: 0,
          status: "done",
          lines: [{ rank: 1, score: { kind: "mate", moves: 0 }, depth: 1, nodes: 1, pv: ["e2e4"] }],
          bestMove: "e2e4",
          timeMs: 1,
        },
        null,
      ],
    };
    await db.rawAnalyses.put(mateZero);
    expect(await repos.analyses.get(base.id)).toBeUndefined();
    expect(report).toHaveBeenCalled();
  });

  it("ignores an invalid cached month and leaves it in place", async () => {
    const { db, repos, report } = dexie();
    await db.httpCache.put({ url: "not a url", fetchedAt: 1, body: {} });
    expect(await repos.pastMonths.get("not a url")).toBeUndefined();
    expect(report).toHaveBeenCalledWith("invalid_record", expect.stringContaining("httpCache/"));
    expect(await db.httpCache.count()).toBe(1);
  });

  it("wraps storage failures as StorageError with a kind", async () => {
    const { db, repos } = dexie();
    db.close();
    const error = await repos.games.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).kind).toBe("closed");
  });
});

describe("classifyStorageError", () => {
  it.each([
    [{ name: "QuotaExceededError" }, "quota"],
    [{ name: "AbortError", inner: { name: "QuotaExceededError" } }, "quota"],
    [{ name: "MissingAPIError" }, "unavailable"],
    [{ name: "OpenFailedError", inner: { name: "InvalidStateError" } }, "unavailable"],
    [{ name: "SecurityError" }, "unavailable"],
    [{ name: "DatabaseClosedError" }, "closed"],
    [{ name: "VersionError" }, "blocked"],
    [new StorageError("invalid_record", "x"), "invalid_record"],
    [new Error("?"), "unknown"],
    ["text", "unknown"],
    [null, "unknown"],
  ] as const)("%o -> %s", (error, kind) => {
    expect(classifyStorageError(error)).toBe(kind);
  });
});
