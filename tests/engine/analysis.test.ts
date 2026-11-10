// @engine: Stage 2 scenarios through analyzeGame + EnginePool with the real Stockfish 19.0.1
// lite single-threaded build (npm, Node child processes).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeGame } from "@/app/analysis/analyzeGame";
import { PRESETS, type PositionResult, type RawAnalysis } from "@/core/engine/analysis";
import type { Score } from "@/core/engine/types";
import type { GameRecord } from "@/core/game/types";
import { EnginePool } from "@/infra/engine/enginePool";
import { readFixture, readJsonFixture } from "../helpers/fixtures";
import { gameFromPgn, gameFromUci } from "../helpers/games";
import { nodeEngineFleet } from "./nodeTransport";

interface FixturePosition {
  id: string;
  startFen: string;
  moves: string[];
  sideToMove: "w" | "b";
}
const fixtures = new Map(readJsonFixture<{ positions: FixturePosition[] }>("engine", "positions.json").positions.map((p) => [p.id, p]));

/** Every `position …` command any engine received, to prove what was (not) sent. */
const positionCommands: string[] = [];
let pool: EnginePool;

beforeAll(() => {
  const fleet = nodeEngineFleet({
    onCommand: (command) => {
      if (command.startsWith("position ")) positionCommands.push(command);
    },
  });
  pool = new EnginePool(fleet.factory, { size: 2 });
});
afterAll(async () => {
  await pool.shutdown();
});

/** A game whose LAST position is the fixture position (history included), analysed in full. */
async function analyseFixture(id: string, preset = PRESETS.quick) {
  const fixture = fixtures.get(id)!;
  const game = await gameFromUci(fixture.moves, fixture.startFen);
  const run = await analyzeGame(game, preset, { searcher: pool });
  const last = run.analysis.positions[game.plies.length]!;
  return { game, run, last };
}

const topScore = (result: PositionResult): Score => {
  if (result.status !== "done") throw new Error(`position ${result.positionIndex} is ${result.status}`);
  return result.lines[0]!.score;
};
const whiteIsWinning = (score: Score) =>
  (score.kind === "cp" && score.value > 400) || (score.kind === "mate" && score.moves > 0);
const done = (result: PositionResult | null) => {
  if (result?.status !== "done") throw new Error(`expected done, got ${JSON.stringify(result)}`);
  return result;
};

describe("@engine analysis: evaluation sign for both sides to move (White's perspective)", () => {
  it.each(["equal-white-to-move", "equal-black-to-move"])("%s is roughly equal", async (id) => {
    const { last, run } = await analyseFixture(id);
    const score = topScore(last);
    expect(score.kind).toBe("cp");
    expect(Math.abs((score as { value: number }).value)).toBeLessThan(100);
    expect(run.status).toBe("completed");
  });

  it.each(["white-queen-up-white-to-move", "white-queen-up-black-to-move"])("%s: White's advantage is positive", async (id) => {
    const score = topScore((await analyseFixture(id)).last);
    expect(whiteIsWinning(score)).toBe(true);
  });
});

describe("@engine analysis: forced mates, signs checked", () => {
  it.each([
    ["white-mates-in-1", 1, "d1d8"],
    ["black-gets-mated-in-1", 1, "a8b8"],
    ["black-mates-in-1", -1, "h7h1"],
    ["white-gets-mated-in-1", -1, "a8b8"],
  ] as const)("%s: mate %d for White's perspective, best move %s", async (id, moves, best) => {
    const result = done((await analyseFixture(id)).last);
    expect(result.lines[0]!.score).toEqual({ kind: "mate", moves });
    expect(result.bestMove).toBe(best);
  });
});

describe("@engine analysis: forced (single legal) moves", () => {
  it.each([
    ["forced-black", "h8g8"],
    ["forced-white", "h1g1"],
  ] as const)("%s: the only legal move is returned", async (id, only) => {
    const { last } = await analyseFixture(id);
    const result = done(last);
    expect(result.bestMove).toBe(only);
    expect(result.lines[0]!.pv[0]).toBe(only);
  });
});

describe("@engine analysis: the move history reaches the engine", () => {
  it("evaluates the threefold-repetition move as a draw only when the history is part of the game", async () => {
    const withHistory = await analyseFixture("repetition-with-history");
    expect(positionCommands).toContain(
      "position fen 4k3/8/8/8/8/8/8/3QK3 w - - 0 1 moves d1d2 e8f8 d2d1 f8e8 d1d2 e8f8 d2d1",
    );
    expect(done(withHistory.last).bestMove).toBe("f8e8");
    expect(topScore(withHistory.last)).toEqual({ kind: "cp", value: 0 });

    // The same board position, sent as a bare FEN with no history:
    const bare = await analyseFixture("repetition-without-history");
    expect(fixtures.get("repetition-without-history")!.startFen).toBe(withHistory.game.plies.at(-1)!.fenAfter);
    expect(done(bare.last).bestMove).not.toBe("f8e8");
    expect(whiteIsWinning(topScore(bare.last))).toBe(true);
  });
});

describe("@engine analysis: terminal positions are resolved by rules and never sent", () => {
  it.each([
    ["checkmate-white-wins.pgn", "1-0"],
    ["checkmate-black-wins.pgn", "0-1"],
    ["stalemate.pgn", "1/2-1/2"],
  ])("%s", async (file, result) => {
    const game: GameRecord = await gameFromPgn(readFixture("pgn", "rules", file));
    const before = positionCommands.length;
    const run = await analyzeGame(game, PRESETS.quick, { searcher: pool });
    const sent = positionCommands.slice(before);
    const finalMoves = game.plies.map((p) => p.uci).join(" ");
    expect(sent.some((command) => command.endsWith(finalMoves))).toBe(false);
    expect(sent).toHaveLength(game.plies.length);
    expect(run.analysis.positions.at(-1)).toMatchObject({ status: "terminal", terminal: { kind: "terminal", result } });
    expect(run.status).toBe("completed");
  });
});

describe("@engine analysis: determinism", () => {
  const strip = (analysis: RawAnalysis) =>
    analysis.positions.map((p) => (p?.status === "done" ? { ...p, timeMs: 0 } : p));

  it("gives identical results for the same game, settings and build, across separate pools", async () => {
    const game = await gameFromPgn(readFixture("pgn", "rules", "castling-both-sides.pgn"));
    const settings = { ...PRESETS.standard, nodes: 100_000, maxDepth: 16 };
    const first = await analyzeGame(game, settings, { searcher: pool });
    const otherFleet = nodeEngineFleet();
    const otherPool = new EnginePool(otherFleet.factory, { size: 3 });
    try {
      const second = await analyzeGame(game, settings, { searcher: otherPool });
      expect(second.analysis.id).toBe(first.analysis.id);
      expect(strip(second.analysis)).toEqual(strip(first.analysis));
      expect(first.analysis.positions.every((p) => p?.status === "done")).toBe(true);
      // MultiPV 2 produced two lines wherever there was a second move to consider.
      expect(first.analysis.positions.every((p) => p?.status === "done" && p.lines.length === 2)).toBe(true);
    } finally {
      await otherPool.shutdown();
    }
  });
});
