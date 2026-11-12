import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Score } from "@/core/engine/types";
import { povCp, povScore, whiteCp, winPercent, winPercentFromCp, winSeries } from "@/core/eval";

const cp = (value: number): Score => ({ kind: "cp", value });
const mate = (moves: number): Score => ({ kind: "mate", moves });
const terminal = (result: "1-0" | "0-1" | "1/2-1/2"): Score => ({ kind: "terminal", result });

describe("Win% curve (methodology §4.1)", () => {
  it.each([
    [0, 50.0],
    [50, 54.6],
    [100, 59.1],
    [150, 63.5],
    [200, 67.6],
    [300, 75.1],
    [500, 86.3],
    [800, 95.0],
    [1000, 97.5],
  ])("cp %i → %f (reference table, 0.1 precision)", (value, expected) => {
    expect(winPercentFromCp(value)).toBeCloseTo(expected, 1);
    expect(winPercentFromCp(-value)).toBeCloseTo(100 - expected, 1);
  });

  it("clamps at ±1000 cp (the Lichess ceiling)", () => {
    expect(winPercentFromCp(1000)).toBe(winPercentFromCp(5000));
    expect(winPercentFromCp(-1000)).toBe(winPercentFromCp(-99_999));
    expect(winPercentFromCp(1000)).toBeCloseTo(97.54, 2);
    expect(winPercentFromCp(-1000)).toBeCloseTo(2.46, 2);
  });

  it("is symmetric, bounded and strictly increasing inside the ceiling (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 999 }), (value) => {
        const w = winPercentFromCp(value);
        expect(w).toBeGreaterThan(0);
        expect(w).toBeLessThan(100);
        expect(winPercentFromCp(value + 1)).toBeGreaterThan(w);
        expect(w + winPercentFromCp(-value)).toBeCloseTo(100, 10);
      }),
    );
  });

  it("rejects invalid input", () => {
    expect(() => winPercentFromCp(Number.NaN)).toThrow(RangeError);
    expect(() => winPercentFromCp(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => winPercent(mate(0), "w")).toThrow(/mate 0/);
    expect(() => winPercent(cp(Number.NaN), "w")).toThrow(RangeError);
    expect(() => winPercent(mate(1.5), "w")).toThrow(RangeError);
  });
});

describe("perspective (methodology §2.2)", () => {
  it("negates cp and mate for Black, both signs", () => {
    expect(povScore(cp(120), "w")).toEqual({ kind: "cp", value: 120 });
    expect(povScore(cp(120), "b")).toEqual({ kind: "cp", value: -120 });
    expect(povScore(cp(-45), "b")).toEqual({ kind: "cp", value: 45 });
    expect(povScore(cp(0), "b")).toEqual({ kind: "cp", value: 0 });
    const zero = povScore(cp(0), "b");
    expect(zero.kind === "cp" && Object.is(zero.value, -0)).toBe(false); // never -0
    expect(povScore(mate(3), "w")).toEqual({ kind: "mate", moves: 3 });
    expect(povScore(mate(3), "b")).toEqual({ kind: "mate", moves: -3 });
    expect(povScore(mate(-2), "b")).toEqual({ kind: "mate", moves: 2 });
  });

  it("turns terminal results into win, loss or draw for each side", () => {
    expect(povScore(terminal("1-0"), "w")).toEqual({ kind: "terminal", outcome: "win" });
    expect(povScore(terminal("1-0"), "b")).toEqual({ kind: "terminal", outcome: "loss" });
    expect(povScore(terminal("0-1"), "w")).toEqual({ kind: "terminal", outcome: "loss" });
    expect(povScore(terminal("0-1"), "b")).toEqual({ kind: "terminal", outcome: "win" });
    expect(povScore(terminal("1/2-1/2"), "b")).toEqual({ kind: "terminal", outcome: "draw" });
  });

  it("maps mate and terminal scores to the ceiling (testing §4.2)", () => {
    // Mate for the mover → 97.54; against → 2.46, for both colours.
    expect(winPercent(mate(4), "w")).toBeCloseTo(97.54, 2);
    expect(winPercent(mate(4), "b")).toBeCloseTo(2.46, 2);
    expect(winPercent(mate(-1), "b")).toBeCloseTo(97.54, 2);
    expect(winPercent(mate(-1), "w")).toBeCloseTo(2.46, 2);
    // Checkmated side to move: 2.46 for it, 97.54 for the winner.
    expect(winPercent(terminal("1-0"), "w")).toBeCloseTo(97.54, 2);
    expect(winPercent(terminal("1-0"), "b")).toBeCloseTo(2.46, 2);
    expect(winPercent(terminal("0-1"), "b")).toBeCloseTo(97.54, 2);
    // A terminal draw is 50 (our rule).
    expect(winPercent(terminal("1/2-1/2"), "w")).toBe(50);
    expect(winPercent(terminal("1/2-1/2"), "b")).toBe(50);
  });

  it("ceiled centipawns for ACPL", () => {
    expect(whiteCp(cp(1500))).toBe(1000);
    expect(whiteCp(cp(-1500))).toBe(-1000);
    expect(whiteCp(mate(-7))).toBe(-1000);
    expect(whiteCp(terminal("1/2-1/2"))).toBe(0);
    expect(povCp(povScore(cp(250), "b"))).toBe(-250);
  });

  it("a position good for White is bad for Black by the same amount (property)", () => {
    const anyScore = fc.oneof(
      fc.integer({ min: -3000, max: 3000 }).map(cp),
      fc.integer({ min: -30, max: 30 }).filter((n) => n !== 0).map(mate),
      fc.constantFrom<Score>(terminal("1-0"), terminal("0-1"), terminal("1/2-1/2")),
    );
    fc.assert(
      fc.property(anyScore, (score) => {
        expect(winPercent(score, "w") + winPercent(score, "b")).toBeCloseTo(100, 10);
      }),
    );
  });
});

describe("winSeries", () => {
  it("is White's Win% per position with null for missing scores", () => {
    expect(winSeries([cp(0), undefined, mate(2)])).toEqual([50, null, expect.closeTo(97.54, 2)]);
  });
});
