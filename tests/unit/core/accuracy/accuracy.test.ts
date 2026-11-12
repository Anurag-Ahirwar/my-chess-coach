import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  acpl,
  gameAccuracy,
  lichessPair,
  moveAccuracy,
  phaseAccuracy,
  populationSd,
  volatilityWindows,
  windowSize,
  type Phase,
} from "@/core/accuracy";
import type { Color } from "@/core/chess/types";
import type { Score } from "@/core/engine/types";
import { winPercentFromCp } from "@/core/eval";
import { LICHESS_ACCURACY_V1 } from "@/core/methodology/v1";

const cp = (value: number): Score => ({ kind: "cp", value });

/** Like lila's test helper: the legacy initial eval (cp +15) followed by the evals after each ply. */
function compute(cps: readonly number[], startColor: Color = "w") {
  return gameAccuracy({ scores: [LICHESS_ACCURACY_V1.legacyInitialCp, ...cps].map(cp), startColor, mode: "lichessCompat" });
}
const alternating = (moves: number, a: number, b: number) => Array.from({ length: moves }, (_, i) => (i % 2 === 0 ? a : b));

describe("move accuracy (methodology §6.1)", () => {
  it.each([
    [0, 100],
    [0.5, 98.8],
    [1, 96.6],
    [2, 92.4],
    [5, 80.8],
    [10, 64.6],
    [15, 51.5],
    [20, 41.0],
    [30, 25.8],
    [50, 9.5],
  ])("Win%% loss %f → %f", (loss, expected) => {
    expect(moveAccuracy(60, 60 - loss)).toBeCloseTo(expected, 1);
  });

  it("is 100 for a gain, clamped to [0, 100] after the +1 bonus, and decreasing (property)", () => {
    expect(moveAccuracy(40, 70)).toBe(100);
    expect(moveAccuracy(100, 0)).toBe(0);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 99, noNaN: true }), fc.double({ min: 0.01, max: 1, noNaN: true }), (loss, step) => {
        const a = moveAccuracy(100, 100 - loss);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(100);
        expect(moveAccuracy(100, 100 - loss - step)).toBeLessThanOrEqual(a);
      }),
    );
  });

  it("matches the §5.3 example table's accuracy column", () => {
    const acc = (before: number, after: number) => Math.round(moveAccuracy(winPercentFromCp(before), winPercentFromCp(after)));
    expect([acc(0, -100), acc(0, -200), acc(0, -300), acc(150, -150), acc(800, 500), acc(-800, -1000), acc(1000, 0)]).toEqual([
      // +8.00 → +5.00 is 68.47 → 68. The document said 69 until 2026-11-13 (a rounding slip in the table).
      67, 46, 32, 30, 68, 90, 11,
    ]);
  });
});

describe("Lichess compatibility, layer 1: lila's AccuracyPercentTest scenarios (re-expressed)", () => {
  it("an empty game and a single move give no accuracy", () => {
    expect(lichessPair(compute([]))).toBeUndefined();
    expect(lichessPair(compute([15]))).toBeUndefined();
  });

  it("two good moves → 100 / 100 (±1)", () => {
    const pair = lichessPair(compute([15, 15]))!;
    expect(pair.white).toBeCloseTo(100, 0);
    expect(pair.black).toBeCloseTo(100, 0);
  });

  it("a White blunder on move 1 → ≈10 (±5) / 100 (±1)", () => {
    const pair = lichessPair(compute([-900, -900]))!;
    expect(Math.abs(pair.white - 10)).toBeLessThanOrEqual(5);
    expect(Math.abs(pair.black - 100)).toBeLessThanOrEqual(1);
  });

  it("a Black blunder on move 1 → 100 / ≈10", () => {
    const pair = lichessPair(compute([15, 900]))!;
    expect(Math.abs(pair.white - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(pair.black - 10)).toBeLessThanOrEqual(5);
  });

  it("20 perfect moves plus one White blunder → ≈50 (±5) for White", () => {
    const pair = lichessPair(compute([...Array.from({ length: 20 }, () => 15), -900]))!;
    expect(Math.abs(pair.white - 50)).toBeLessThanOrEqual(5);
    expect(Math.abs(pair.black - 100)).toBeLessThanOrEqual(1);
  });

  it.each([
    ["5 average moves each (65 cpl)", 10, -50, 76],
    ["50 average moves each (65 cpl)", 100, -50, 76],
    ["50 mediocre moves each (150 cpl)", 100, -135, 54],
    ["50 terrible moves each (500 cpl)", 100, -485, 20],
  ])("%s → ≈%i (±8) for both", (_name, plies, low, expected) => {
    const pair = lichessPair(compute(alternating(plies, low, 15)))!;
    // White's moves go 15 → low and Black's low → 15: both lose the same centipawns each move.
    expect(Math.abs(pair.white - expected)).toBeLessThanOrEqual(8);
    expect(Math.abs(pair.black - expected)).toBeLessThanOrEqual(8);
  });

  it("the Black-to-move-first variants mirror the White ones", () => {
    // Black moves first and blunders: from 15 to +900 (good for White).
    const pair = lichessPair(compute([900, 900], "b"))!;
    expect(Math.abs(pair.black - 10)).toBeLessThanOrEqual(5);
    expect(Math.abs(pair.white - 100)).toBeLessThanOrEqual(1);
    // Average moves, Black first: Black's moves go 15 → 80, White's 80 → 15.
    const avg = lichessPair(compute(alternating(100, 80, 15), "b"))!;
    expect(Math.abs(avg.black - 76)).toBeLessThanOrEqual(8);
    expect(Math.abs(avg.white - 76)).toBeLessThanOrEqual(8);
  });

  it("phase accuracy uses the previous phase's eval (the boundary position is in both slices)", () => {
    // 30 plies: positions 0..15 opening, 16..30 middlegame. Positions 0..16 are +0.15, then −6.00:
    // White blunders on move 16→17, inside the middlegame.
    const cps = Array.from({ length: 30 }, (_, i) => (i < 16 ? 15 : -600));
    const scores = [15, ...cps].map(cp);
    const phases: Phase[] = scores.map((_, k) => (k < 16 ? "opening" : "middlegame"));
    const result = phaseAccuracy({ scores, startColor: "w", mode: "lichessCompat" }, phases);
    // The middlegame slice starts at position 15, the opening's last position (its eval is reused).
    expect(result.opening!.slice).toEqual([0, 15]);
    expect(result.middlegame!.slice).toEqual([15, 30]);
    // So the boundary move 15→16 (Black's) is counted in the middlegame: Black has 8 moves there.
    expect(result.middlegame!.black.countedMoves).toBe(8);
    expect(result.middlegame!.white.countedMoves).toBe(7);
    expect(result.opening!.white.accuracy!).toBeCloseTo(100, 5);
    expect(result.middlegame!.white.accuracy!).toBeLessThan(90);
    expect(result.endgame).toBeUndefined();
  });
});

describe("Lichess compatibility, layer 2: algorithm edge cases", () => {
  it.each([
    [19, 2],
    [20, 2],
    [29, 2],
    [80, 8],
    [81, 8],
    [200, 8],
    [45, 4],
  ])("window size at n = %i plies is %i", (plies, expected) => {
    expect(windowSize(plies + 1)).toBe(expected);
  });

  it("lead windows then trailing windows, move by move (n = 25 and n = 45)", () => {
    const w25 = volatilityWindows(26);
    expect(w25).toHaveLength(25);
    w25.forEach((window, i) => expect(window).toEqual([i, i + 1]));
    const w45 = volatilityWindows(46); // ws = 4, lead = 2
    expect(w45).toHaveLength(45);
    expect(w45[0]).toEqual([0, 1, 2, 3]);
    expect(w45[1]).toEqual([0, 1, 2, 3]);
    for (let i = 2; i < 45; i++) expect(w45[i]).toEqual([i - 2, i - 1, i, i + 1]); // ends at the position after the move
    // A series shorter than ws is one window.
    expect(volatilityWindows(2)).toEqual([[0, 1]]);
    expect(volatilityWindows(1)).toEqual([]);
  });

  it("uses the population standard deviation", () => {
    expect(populationSd([0, 10])).toBe(5); // a sample SD would be 7.07
    expect(populationSd([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });

  it("clamps weights to [0.5, 12]", () => {
    const flat = gameAccuracy({ scores: [cp(15), cp(15), cp(15)], startColor: "w", mode: "lichessCompat" });
    expect(flat.moves.map((m) => m.weight)).toEqual([0.5, 0.5]);
    const wild = gameAccuracy({ scores: [cp(1000), cp(-1000), cp(1000)], startColor: "w", mode: "lichessCompat" });
    expect(wild.moves.map((m) => m.weight)).toEqual([12, 12]);
  });

  it("floors a 0% move at 1 in the harmonic mean", () => {
    const result = gameAccuracy({ scores: [cp(1000), cp(-1000), cp(-1000), cp(-1000)], startColor: "w", mode: "lichessCompat" });
    expect(result.moves[0]!.accuracy).toBe(0);
    // White: moves 0 (0%) and 2 (100%): harmonic = 2 / (1/1 + 1/100).
    expect(result.white.harmonic).toBeCloseTo(2 / (1 + 1 / 100), 10);
  });

  it("drops exactly the right moves for a missing eval in the middle, first and last position (§6.4)", () => {
    const scores = (missing: number) => Array.from({ length: 31 }, (_, k) => (k === missing ? undefined : cp(15 + (k % 3) * 20)));
    // n = 30 → ws = 3, lead = 1. Move i's window: i = 0 → [0,1,2]; i ≥ 1 → [i−1, i, i+1].
    const middle = gameAccuracy({ scores: scores(10), startColor: "w", mode: "lichessCompat" });
    expect(middle.moves.flatMap((m, i) => (m.accuracy === undefined ? [i] : []))).toEqual([9, 10]);
    expect(middle.moves.flatMap((m, i) => (m.weight === undefined ? [i] : []))).toEqual([9, 10, 11]);
    expect(middle.moves.flatMap((m, i) => (m.counts ? [] : [i]))).toEqual([9, 10, 11]);
    expect(middle.white.excludedMissing + middle.black.excludedMissing).toBe(3);

    const first = gameAccuracy({ scores: scores(0), startColor: "w", mode: "lichessCompat" });
    expect(first.moves.flatMap((m, i) => (m.accuracy === undefined ? [i] : []))).toEqual([0]);
    expect(first.moves.flatMap((m, i) => (m.weight === undefined ? [i] : []))).toEqual([0, 1]);

    const last = gameAccuracy({ scores: scores(30), startColor: "w", mode: "lichessCompat" });
    expect(last.moves.flatMap((m, i) => (m.accuracy === undefined ? [i] : []))).toEqual([29]);
    expect(last.moves.flatMap((m, i) => (m.weight === undefined ? [i] : []))).toEqual([29]);
  });

  it("handles a game starting with Black to move", () => {
    const result = gameAccuracy({ scores: [cp(15), cp(-900), cp(-900)], startColor: "b", mode: "lichessCompat" });
    expect(result.moves.map((m) => m.color)).toEqual(["b", "w"]);
    expect(result.black.accuracy).toBe(100);
    expect(result.white.accuracy).toBe(100);
    const blunder = gameAccuracy({ scores: [cp(15), cp(900), cp(900)], startColor: "b", mode: "lichessCompat" });
    expect(Math.abs(blunder.black.accuracy! - 10)).toBeLessThanOrEqual(5);
  });

  it("maps mate scores and terminal positions to the ceiling", () => {
    const viaMate = gameAccuracy({ scores: [cp(15), { kind: "mate", moves: -2 }, cp(-1000)], startColor: "w", mode: "lichessCompat" });
    const viaCp = gameAccuracy({ scores: [cp(15), cp(-1000), cp(-1000)], startColor: "w", mode: "lichessCompat" });
    expect(viaMate.white.accuracy).toBe(viaCp.white.accuracy);
    const terminal = gameAccuracy({ scores: [cp(400), { kind: "terminal", result: "1-0" }], startColor: "w", mode: "lichessCompat" });
    expect(terminal.moves[0]!.accuracy).toBe(100);
  });
});

describe("default mode: Forced moves (methodology §6.3)", () => {
  // White's Forced move (index 6) loses: −2.90 → −6.00.
  const scores = [15, 40, -20, 60, -300, -280, -290, -600, 0, 5, -5].map(cp);
  const forced = [false, false, false, true, false, false, true, false, false, false];

  it("leaves Forced moves out of both means in default mode, and keeps them in lichessCompat", () => {
    const def = gameAccuracy({ scores, startColor: "w", forced, mode: "default" });
    const compat = gameAccuracy({ scores, startColor: "w", forced, mode: "lichessCompat" });
    expect(def.black.excludedForced).toBe(1); // move 3
    expect(def.white.excludedForced).toBe(1); // move 6
    expect(def.white.countedMoves).toBe(compat.white.countedMoves - 1);
    expect(compat.white.excludedForced + compat.black.excludedForced).toBe(0);
    expect(def.white.accuracy).not.toBe(compat.white.accuracy);
  });

  it("never changes another move's weight (windows are built over the full series) — property", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1500, max: 1500 }), { minLength: 2, maxLength: 120 }),
        fc.array(fc.boolean(), { maxLength: 120 }),
        fc.constantFrom<Color>("w", "b"),
        (values, flags, startColor) => {
          const s = values.map(cp);
          const def = gameAccuracy({ scores: s, startColor, forced: flags, mode: "default" });
          const compat = gameAccuracy({ scores: s, startColor, forced: flags, mode: "lichessCompat" });
          expect(def.moves.map((m) => m.weight)).toEqual(compat.moves.map((m) => m.weight));
          expect(def.moves.map((m) => m.accuracy)).toEqual(compat.moves.map((m) => m.accuracy));
        },
      ),
    );
  });
});

describe("ACPL (methodology §6.6)", () => {
  it("averages each player's centipawn loss, ceiled at ±1000, rounded", () => {
    // White: 15 → −50 (65), −50 → ... ; Black: −50 → 15 (65).
    expect(acpl([15, -50, 15, -50, 15].map(cp), "w")).toEqual({ white: 65, black: 65 });
    // A mate counts as ±1000; a gain is 0 loss.
    expect(acpl([cp(0), { kind: "mate", moves: -3 }, cp(-1000)], "w")).toEqual({ white: 1000, black: 0 });
    // Clamped: +3000 → −3000 is a loss of 2000 at most.
    expect(acpl([cp(3000), cp(-3000)], "w")).toEqual({ white: 2000 });
    // Missing evaluations are skipped; a player with no moves has no ACPL.
    expect(acpl([cp(15), undefined, cp(15)], "w")).toEqual({});
    // Black first.
    expect(acpl([cp(15), cp(115)], "b")).toEqual({ black: 100 });
    // Rounding to the nearest integer.
    // White loses 1 and 2 (mean 1.5 → 2); Black's −0.01 → 0.00 loses 1.
    expect(acpl([cp(0), cp(-1), cp(0), cp(-2)], "w")).toEqual({ white: 2, black: 1 });
  });
});
