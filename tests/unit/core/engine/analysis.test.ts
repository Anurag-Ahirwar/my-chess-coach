import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LITE_SINGLE_ENGINE,
  PRESETS,
  analysisId,
  applyPositionResult,
  createRawAnalysis,
  engineKey,
  isAnalysisComplete,
  pendingPositions,
  settingsHash,
  type PositionResult,
} from "@/core/engine/analysis";

const done = (positionIndex: number): PositionResult => ({
  positionIndex,
  status: "done",
  lines: [{ rank: 1, score: { kind: "cp", value: 10 }, depth: 10, nodes: 100, pv: ["e2e4"] }],
  bestMove: "e2e4",
  timeMs: 5,
});
const failed = (positionIndex: number): PositionResult => ({ positionIndex, status: "failed", error: "x", lines: [] });
const terminal = (positionIndex: number): PositionResult => ({
  positionIndex,
  status: "terminal",
  terminal: { kind: "terminal", result: "1-0" },
  lines: [],
});

describe("engine identity and presets", () => {
  it("matches the installed stockfish package version", () => {
    const pkg = JSON.parse(readFileSync("node_modules/stockfish/package.json", "utf8")) as { version: string };
    expect(LITE_SINGLE_ENGINE).toEqual({ name: "stockfish", version: pkg.version, flavour: "lite-single" });
    expect(engineKey(LITE_SINGLE_ENGINE)).toBe("stockfish-19.0.1-lite-single");
  });

  it("uses the spec D8 presets (provisional until benchmarked)", () => {
    expect(PRESETS.quick).toMatchObject({ nodes: 150_000, maxDepth: 18, multiPv: 1 });
    expect(PRESETS.standard).toMatchObject({ nodes: 600_000, maxDepth: 22, multiPv: 2 });
    expect(PRESETS.deep).toMatchObject({ nodes: 2_500_000, maxDepth: 30, multiPv: 2 });
    for (const preset of Object.values(PRESETS)) expect(preset).toMatchObject({ hashMb: 16, freshHashPerPosition: true });
  });
});

describe("settingsHash", () => {
  it("is 16 hex characters and stable across runs", async () => {
    const a = await settingsHash(PRESETS.quick);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await settingsHash({ ...PRESETS.quick })).toBe(a);
  });

  it("does not depend on key order", async () => {
    const reordered = Object.fromEntries(Object.entries(PRESETS.standard).reverse()) as typeof PRESETS.standard;
    expect(await settingsHash(reordered)).toBe(await settingsHash(PRESETS.standard));
  });

  it("differs whenever any setting differs, so presets never collide", async () => {
    const hashes = await Promise.all([
      settingsHash(PRESETS.quick),
      settingsHash(PRESETS.standard),
      settingsHash(PRESETS.deep),
      settingsHash({ ...PRESETS.quick, nodes: 150_001 }),
      settingsHash({ ...PRESETS.quick, preset: "custom" }),
    ]);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("builds the analysis id from game, engine key and settings hash", async () => {
    const hash = await settingsHash(PRESETS.quick);
    expect(analysisId("pgn:abc", LITE_SINGLE_ENGINE, hash)).toBe(`pgn:abc|stockfish-19.0.1-lite-single|${hash}`);
  });
});

describe("RawAnalysis", () => {
  const create = () => createRawAnalysis({ gameId: "g1", positionCount: 3, engine: LITE_SINGLE_ENGINE, settings: PRESETS.quick, now: 1000 });

  it("starts with one empty slot per position (dense, never sparse)", async () => {
    const analysis = await create();
    expect(analysis).toMatchObject({ schemaVersion: 1, gameId: "g1", completedCount: 0, totalCount: 3, startedAt: 1000 });
    expect(analysis.positions).toEqual([null, null, null]);
    expect(Object.keys(analysis.positions)).toEqual(["0", "1", "2"]);
    expect(analysis.completedAt).toBeUndefined();
    expect(isAnalysisComplete(analysis)).toBe(false);
  });

  it("counts done and terminal positions, not failed ones", async () => {
    let analysis = await create();
    analysis = applyPositionResult(analysis, done(0), 2000);
    analysis = applyPositionResult(analysis, failed(1), 2001);
    analysis = applyPositionResult(analysis, terminal(2), 2002);
    expect(analysis.completedCount).toBe(2);
    expect(analysis.completedAt).toBeUndefined();
    expect(pendingPositions(analysis)).toEqual([1]);
  });

  it("is complete only when every position is done or terminal", async () => {
    let analysis = await create();
    for (const result of [done(0), done(1), terminal(2)]) analysis = applyPositionResult(analysis, result, 3000);
    expect(analysis.completedCount).toBe(3);
    expect(analysis.completedAt).toBe(3000);
    expect(isAnalysisComplete(analysis)).toBe(true);
    expect(pendingPositions(analysis)).toEqual([]);
  });

  it("does not modify the input", async () => {
    const analysis = await create();
    const next = applyPositionResult(analysis, done(1), 2000);
    expect(analysis.positions).toEqual([null, null, null]);
    expect(next.positions[1]).toEqual(done(1));
  });

  it("clears completedAt if a position is later replaced by a failure", async () => {
    let analysis = await create();
    for (const result of [done(0), done(1), done(2)]) analysis = applyPositionResult(analysis, result, 3000);
    analysis = applyPositionResult(analysis, failed(1), 4000);
    expect(analysis.completedAt).toBeUndefined();
    expect(isAnalysisComplete(analysis)).toBe(false);
  });

  it("rejects a position index outside the game", async () => {
    const analysis = await create();
    expect(() => applyPositionResult(analysis, done(3), 1)).toThrow(RangeError);
    expect(() => applyPositionResult(analysis, done(-1), 1)).toThrow(RangeError);
  });
});
