import { readFileSync } from "node:fs";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { loadReview, type ReviewDeriver } from "@/app/review/reviewService";
import type { RawAnalysis } from "@/core/engine/analysis";
import type { GameRecord } from "@/core/game/types";
import { METHODOLOGY_V1, configHash, withConfig } from "@/core/methodology/v1";
import { EMPTY_OPENING_INDEX } from "@/core/openings";
import { deriveReview } from "@/core/review";
import { AppDatabase, type ReviewRecord } from "@/infra/storage/db";
import { dexieRepositories, memoryRepositories, type Repositories } from "@/infra/storage/repositories";
import { readFixture } from "../../helpers/fixtures";
import { gameFromPgn, gameFromUci } from "../../helpers/games";
import { rawFromScores } from "../../helpers/review";
import { testDatabase } from "../../helpers/storage";

const RAW = new URL("../../fixtures/review/raw/23-daily.standard.json", import.meta.url);
const loadFixture = async () => ({
  game: await gameFromPgn(readFixture("pgn", "chesscom", "23-daily.pgn")),
  raw: JSON.parse(readFileSync(RAW, "utf8")) as RawAnalysis,
});

function countingDeriver(config = METHODOLOGY_V1) {
  const calls: string[] = [];
  const deriver: ReviewDeriver = {
    derive: (game, raw) => {
      calls.push(raw.id);
      return Promise.resolve(deriveReview({ game, raw, index: EMPTY_OPENING_INDEX, config }));
    },
  };
  return { deriver, calls };
}

const problems: string[] = [];
const repos = (db = testDatabase()): Repositories => dexieRepositories(db, (kind, detail) => problems.push(`${kind}: ${detail}`));

describe("Dexie schema v2 (docs/DATA_MODELS.md §11)", () => {
  it("opens a version 1 database with all its records intact and adds an empty reviews table", async () => {
    const name = `v1-to-v2-${Date.now()}`;
    // A version 1 database exactly as Phase 2 created it.
    const v1 = new Dexie(name, { indexedDB, IDBKeyRange });
    v1.version(1).stores({ games: "id, playedAt, createdAt", rawAnalyses: "id, gameId, completedAt", httpCache: "url, fetchedAt" });
    const { game, raw } = await loadFixture();
    const stored = { ...game, schemaVersion: 1 as const, createdAt: 1, updatedAt: 2 };
    await v1.table("games").put(stored);
    await v1.table("rawAnalyses").put(raw);
    await v1.table("httpCache").put({ url: "https://api.chess.com/pub/player/x/games/2026/09", fetchedAt: 3, body: { games: [] } });
    v1.close();

    const v2 = new AppDatabase(name, { indexedDB, IDBKeyRange });
    await v2.open();
    expect(v2.verno).toBe(2);
    expect(v2.tables.map((t) => t.name).sort()).toEqual(["games", "httpCache", "rawAnalyses", "reviews"]);
    const r = repos(v2);
    expect(await r.games.get(game.id)).toEqual(stored);
    expect(await r.analyses.get(raw.id)).toEqual(raw);
    expect(await r.pastMonths.get("https://api.chess.com/pub/player/x/games/2026/09")).toEqual({ games: [] });
    expect(await v2.reviews.count()).toBe(0);
    v2.close();
  });
});

describe.each([
  ["IndexedDB", () => repos()],
  ["memory", () => memoryRepositories()],
])("reviews repository (%s)", (_name, make) => {
  it("stores by raw analysis id and methodology version, validates on save, lists per game", async () => {
    const r = make();
    const { game, raw } = await loadFixture();
    const review = deriveReview({ game, raw, index: EMPTY_OPENING_INDEX, config: METHODOLOGY_V1 });
    const record: ReviewRecord = { rawAnalysisId: raw.id, methodologyVersion: "1.0.0", gameId: game.id, configHash: review.configHash, derivedAt: 5, schemaVersion: 1, review };
    await r.reviews.put(record);
    expect(await r.reviews.get(raw.id, "1.0.0")).toEqual(record);
    expect(await r.reviews.get(raw.id, "1.0.1")).toBeUndefined();
    expect(await r.reviews.listForGame(game.id)).toHaveLength(1);
    // A record whose keys don't match its review is refused.
    await expect(r.reviews.put({ ...record, methodologyVersion: "9.9.9" })).rejects.toMatchObject({ kind: "invalid_record" });
    // Returned copies can't change what is stored.
    const copy = (await r.reviews.get(raw.id, "1.0.0"))!;
    copy.review.moves.length = 0;
    expect((await r.reviews.get(raw.id, "1.0.0"))!.review.moves.length).toBe(20);
  });
});

describe("loadReview: the review cache (decisions Q1, B6)", () => {
  it("derives and stores on a miss, then reuses the stored review with no derivation", async () => {
    const r = repos();
    const { game, raw } = await loadFixture();
    const { deriver, calls } = countingDeriver();
    const deps = { reviews: () => Promise.resolve(r.reviews), deriver, now: () => 7 };
    const first = await loadReview(game, raw, deps);
    expect(first).toMatchObject({ source: "derived", cached: true });
    const second = await loadReview(game, raw, deps);
    expect(second).toMatchObject({ source: "cache", cached: true });
    expect(second.review).toEqual(first.review);
    expect(calls).toHaveLength(1);
    expect((await r.reviews.get(raw.id, "1.0.0"))!.derivedAt).toBe(7);
  });

  it("derives again under a different methodology version (another key), keeping the old record", async () => {
    const r = repos();
    const { game, raw } = await loadFixture();
    const old = deriveReview({ game, raw, index: EMPTY_OPENING_INDEX, config: METHODOLOGY_V1 });
    await r.reviews.put({ rawAnalysisId: raw.id, methodologyVersion: "0.9.0", gameId: game.id, configHash: old.configHash, derivedAt: 1, schemaVersion: 1, review: { ...old, methodologyVersion: "0.9.0" } });
    const { deriver, calls } = countingDeriver();
    expect(await loadReview(game, raw, { reviews: () => Promise.resolve(r.reviews), deriver })).toMatchObject({ source: "derived" });
    expect(calls).toHaveLength(1);
    expect((await r.reviews.listForGame(game.id)).map((x) => x.methodologyVersion).sort()).toEqual(["0.9.0", "1.0.0"]);
  });

  it("derives again and replaces the record when the config hash differs (e.g. a flag changed)", async () => {
    const r = repos();
    const { game, raw } = await loadFixture();
    const flagsOff = withConfig(METHODOLOGY_V1, { great: { enabled: false } });
    await loadReview(game, raw, { reviews: () => Promise.resolve(r.reviews), deriver: countingDeriver(flagsOff).deriver, config: flagsOff });
    expect((await r.reviews.get(raw.id, "1.0.0"))!.configHash).toBe(configHash(flagsOff));
    const { deriver, calls } = countingDeriver();
    expect(await loadReview(game, raw, { reviews: () => Promise.resolve(r.reviews), deriver })).toMatchObject({ source: "derived", cached: true });
    expect(calls).toHaveLength(1);
    expect((await r.reviews.get(raw.id, "1.0.0"))!.configHash).toBe(configHash(METHODOLOGY_V1));
    expect(await r.reviews.listForGame(game.id)).toHaveLength(1);
  });

  it("never caches a partial analysis: it is derived every time", async () => {
    const r = repos();
    const game = await gameFromUci(["e2e4", "e7e5", "g1f3"]);
    const raw = rawFromScores(game, [{ score: { kind: "cp", value: 20 } }, { score: { kind: "cp", value: 25 } }]);
    expect(raw.completedAt).toBeUndefined();
    const { deriver, calls } = countingDeriver();
    const deps = { reviews: () => Promise.resolve(r.reviews), deriver };
    expect(await loadReview(game, raw, deps)).toMatchObject({ source: "derived", cached: false });
    expect(await loadReview(game, raw, deps)).toMatchObject({ source: "derived", cached: false });
    expect(calls).toHaveLength(2);
    expect(await r.reviews.listForGame(game.id)).toEqual([]);
  });

  it("reports an unreadable cached review, derives again and replaces it (derived data, B6)", async () => {
    const db = testDatabase();
    const r = repos(db);
    const { game, raw } = await loadFixture();
    problems.length = 0;
    await db.reviews.put({ rawAnalysisId: raw.id, methodologyVersion: "1.0.0", gameId: game.id, configHash: "nonsense", review: {} } as unknown as ReviewRecord);
    const { deriver, calls } = countingDeriver();
    expect(await loadReview(game, raw, { reviews: () => Promise.resolve(r.reviews), deriver })).toMatchObject({ source: "derived", cached: true });
    expect(calls).toHaveLength(1);
    expect(problems.some((p) => p.startsWith("invalid_record: reviews/"))).toBe(true);
    expect((await r.reviews.get(raw.id, "1.0.0"))!.configHash).toBe(configHash(METHODOLOGY_V1));
  });

  it("still returns a review when storage fails, and reports the problem", async () => {
    const { game, raw } = await loadFixture();
    const onStorageError = vi.fn();
    const { deriver } = countingDeriver();
    const result = await loadReview(game, raw, { reviews: () => Promise.reject(new Error("quota")), deriver, onStorageError });
    expect(result).toMatchObject({ source: "derived", cached: false });
    expect(onStorageError).toHaveBeenCalledTimes(1);
  });

  it("never writes the raw analysis", async () => {
    const db = testDatabase();
    const r = repos(db);
    const { game, raw } = await loadFixture();
    await r.analyses.save(raw, 1);
    const before = await db.rawAnalyses.get(raw.id);
    const save = vi.spyOn(r.analyses, "save");
    const { deriver } = countingDeriver();
    await loadReview(game, (await r.analyses.get(raw.id))!, { reviews: () => Promise.resolve(r.reviews), deriver });
    await loadReview(game, (await r.analyses.get(raw.id))!, { reviews: () => Promise.resolve(r.reviews), deriver });
    expect(save).not.toHaveBeenCalled();
    expect(await db.rawAnalyses.get(raw.id)).toEqual(before);
  });

  it("stops when aborted and stores nothing", async () => {
    const r = repos();
    const { game, raw } = await loadFixture();
    const controller = new AbortController();
    controller.abort();
    const { deriver, calls } = countingDeriver();
    await expect(loadReview(game, raw, { reviews: () => Promise.resolve(r.reviews), deriver }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
    expect(await r.reviews.listForGame(game.id)).toEqual([]);
  });

  it("refuses a game that doesn't match the analysis", async () => {
    const { raw } = await loadFixture();
    const other: GameRecord = await gameFromUci(["e2e4"]);
    const { deriver } = countingDeriver();
    await expect(loadReview(other, raw, { reviews: () => Promise.resolve(memoryRepositories().reviews), deriver })).rejects.toThrow(/another game/);
  });
});
