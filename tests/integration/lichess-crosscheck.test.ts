import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { PHASES, acpl, gameAccuracy, lichessPair, phaseAccuracy, type Phase } from "@/core/accuracy";
import type { Score } from "@/core/engine/types";
import { LICHESS_ACCURACY_V1 } from "@/core/methodology/v1";
import { readJsonFixture } from "../helpers/fixtures";

/**
 * Lichess compatibility, layer 3 (docs/TESTING_STRATEGY.md §4.5): Lichess's own per-ply evals of
 * 50 real games, fed into our accuracy code in lichessCompat mode, must reproduce Lichess's
 * reported accuracy (±1 after rounding) and ACPL (±1, decision D5: an internal validation).
 * Phase accuracy with Lichess's own division is reported only (decision D7).
 *
 * Inputs exactly as Lichess has them: position 0 is the legacy cp +15 (the export has no initial
 * eval), positions 1..k are `analysis[0..k-1]`. Games ending in checkmate have no eval for the
 * final position, so their series is one shorter, as in Lichess's own computation.
 * Set LICHESS_REPORT=<file> to write the per-game comparison as JSON.
 */

interface LichessSide {
  name: string;
  analysis: { accuracy?: number; acpl?: number; phases?: Partial<Record<Phase, number>> } | null;
}
interface LichessGame {
  id: string;
  status: string;
  winner: "white" | "black" | null;
  windowSize: number;
  division: { middle?: number; end?: number } | null;
  players: { white: LichessSide; black: LichessSide };
  moves: string;
  analysis: { eval?: number; mate?: number }[];
}

const { games } = readJsonFixture<{ games: LichessGame[] }>("lichess-evals", "games.json");

/**
 * Lichess's evals as our scores. Lichess writes a checkmated final position as `mate: 0`; we never
 * store mate 0 (methodology §2.1) but a rules-based terminal score, and §4.1 maps Lichess's Mate(0)
 * to exactly that (−1000 for the mated side, +1000 for the winner).
 */
function scoresOf(game: LichessGame): (Score | undefined)[] {
  return [
    { kind: "cp", value: LICHESS_ACCURACY_V1.legacyInitialCp },
    ...game.analysis.map((entry, i): Score | undefined => {
      if (entry.mate === 0) {
        if (game.status !== "mate" || i !== game.analysis.length - 1 || !game.winner) {
          throw new Error(`${game.id}: mate 0 that is not the final checkmate`);
        }
        return { kind: "terminal", result: game.winner === "white" ? "1-0" : "0-1" };
      }
      if (entry.eval !== undefined) return { kind: "cp", value: entry.eval };
      if (entry.mate !== undefined) return { kind: "mate", moves: entry.mate };
      return undefined;
    }),
  ];
}

function phasesOf(game: LichessGame, positions: number): Phase[] {
  const middle = game.division?.middle;
  const end = game.division?.end;
  return Array.from({ length: positions }, (_, k): Phase => {
    if (end !== undefined && k >= end) return "endgame";
    if (middle !== undefined && k >= middle) return "middlegame";
    return "opening";
  });
}

interface Row {
  id: string;
  status: string;
  plies: number;
  windowSize: number;
  accuracy: { ours: [number | null, number | null]; lichess: [number | null, number | null] };
  acpl: { ours: [number | null, number | null]; lichess: [number | null, number | null] };
  phases: { phase: Phase; color: "white" | "black"; ours: number; lichess: number }[];
}
const rows: Row[] = [];

describe("Lichess cross-check (50 games)", () => {
  it("has 50 pseudonymised games covering window sizes 2 to 8", () => {
    expect(games).toHaveLength(50);
    expect(new Set(games.map((g) => g.windowSize))).toEqual(new Set([2, 3, 4, 5, 6, 7, 8]));
    for (const game of games) {
      expect(game.players.white.name).toMatch(/^player-\d{2,3}$/);
      expect(game.players.black.name).toMatch(/^player-\d{2,3}$/);
    }
  });

  it.each(games.map((g) => [g.id, g] as const))("%s: accuracy (±1, rounded), ACPL (±1) and phase accuracy (±1) match Lichess", (_id, game) => {
    const scores = scoresOf(game);
    const ours = gameAccuracy({ scores, startColor: "w", mode: "lichessCompat" });
    const pair = lichessPair(ours);
    const theirs = { white: game.players.white.analysis?.accuracy, black: game.players.black.analysis?.accuracy };
    const ourAcpl = acpl(scores, "w");
    const theirAcpl = { white: game.players.white.analysis?.acpl, black: game.players.black.analysis?.acpl };

    const phaseRows: Row["phases"] = [];
    const phases = phaseAccuracy({ scores, startColor: "w", mode: "lichessCompat" }, phasesOf(game, scores.length));
    for (const phase of PHASES) {
      for (const color of ["white", "black"] as const) {
        const lichess = game.players[color].analysis?.phases?.[phase];
        const value = phases[phase]?.[color].accuracy;
        // Decision D7: reported first (240 of 240 exact on 2026-11-13), so it is now a gate too.
        if (lichess !== undefined) {
          expect(value, `${phase} ${color}: Lichess reports a phase accuracy and ours is undefined`).toBeDefined();
          expect(Math.abs(Math.round(value!) - lichess), `${phase} ${color} phase accuracy`).toBeLessThanOrEqual(1);
        }
        if (lichess !== undefined && value !== undefined) phaseRows.push({ phase, color, ours: value, lichess });
      }
    }
    rows.push({
      id: game.id,
      status: game.status,
      plies: game.moves.split(" ").length,
      windowSize: game.windowSize,
      accuracy: { ours: [pair?.white ?? null, pair?.black ?? null], lichess: [theirs.white ?? null, theirs.black ?? null] },
      acpl: { ours: [ourAcpl.white ?? null, ourAcpl.black ?? null], lichess: [theirAcpl.white ?? null, theirAcpl.black ?? null] },
      phases: phaseRows,
    });

    // Undefined exactly when Lichess's is undefined.
    expect(pair === undefined).toBe(theirs.white === undefined || theirs.black === undefined);
    if (pair) {
      expect(Math.abs(Math.round(pair.white) - theirs.white!)).toBeLessThanOrEqual(1);
      expect(Math.abs(Math.round(pair.black) - theirs.black!)).toBeLessThanOrEqual(1);
    }
    for (const color of ["white", "black"] as const) {
      if (theirAcpl[color] === undefined) continue;
      expect(ourAcpl[color], `our ${color} ACPL is undefined but Lichess reports one`).toBeDefined();
      expect(Math.abs(ourAcpl[color]! - theirAcpl[color])).toBeLessThanOrEqual(1);
    }
  });

  afterAll(() => {
    const path = process.env["LICHESS_REPORT"];
    if (path) writeFileSync(path, JSON.stringify(rows, null, 1));
  });
});
