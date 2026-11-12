// Records the RawAnalysis inputs of the regression snapshots (docs/TESTING_STRATEGY.md §3
// `review/raw/`, Phase 3 decision Q3) with the real engine, through the app's own analyzeGame.
//   RECORD_REVIEW_FIXTURES=record npm run test:engine -- recordReviews   (writes the files)
//   RECORD_REVIEW_FIXTURES=verify npm run test:engine -- recordReviews   (re-runs two games, compares)
// Timestamps are fixed at 0 and timeMs is set to 0, so the files only change when the engine's
// output changes. Skipped unless RECORD_REVIEW_FIXTURES is set.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeGame } from "@/app/analysis/analyzeGame";
import { PRESETS, type RawAnalysis } from "@/core/engine/analysis";
import { EnginePool } from "@/infra/engine/enginePool";
import { readFixture } from "../helpers/fixtures";
import { gameFromPgn } from "../helpers/games";
import { nodeEngineFleet } from "./nodeTransport";

const MODE = process.env["RECORD_REVIEW_FIXTURES"];
export const REGRESSION_GAMES = ["06-blitz", "19-rapid", "10-bullet", "12-blitz", "14-blitz", "23-daily", "07-bullet", "02-blitz", "16-rapid", "21-daily"];
const OUT = join(import.meta.dirname, "..", "fixtures", "review", "raw");

function normalise(raw: RawAnalysis): RawAnalysis {
  return {
    ...raw,
    startedAt: 0,
    ...(raw.completedAt !== undefined ? { completedAt: 0 } : {}),
    positions: raw.positions.map((p) => (p?.status === "done" ? { ...p, timeMs: 0 } : p)),
  };
}

let pool: EnginePool;
beforeAll(() => {
  if (MODE) pool = new EnginePool(nodeEngineFleet().factory, { size: 4 });
});
afterAll(async () => {
  await pool?.shutdown();
});

describe.skipIf(!MODE)("record the regression RawAnalyses (Standard preset)", () => {
  const games = MODE === "verify" ? ["23-daily", "07-bullet"] : REGRESSION_GAMES;
  it.each(games)("%s", { timeout: 1_800_000 }, async (name) => {
    const game = await gameFromPgn(readFixture("pgn", "chesscom", `${name}.pgn`));
    const run = await analyzeGame(game, PRESETS.standard, { searcher: pool, now: () => 0 });
    expect(run.status).toBe("completed");
    const raw = normalise(run.analysis);
    const file = join(OUT, `${name}.standard.json`);
    if (MODE === "verify") {
      const stored = JSON.parse(readFileSync(file, "utf8")) as RawAnalysis;
      expect(raw).toEqual(stored);
    } else {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(file, `${JSON.stringify(raw)}\n`);
    }
  });
});
