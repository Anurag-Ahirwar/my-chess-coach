import { describe, expect, it } from "vitest";
import { STANDARD_START_FEN } from "@/core/chess/position";
import type { EngineLine } from "@/core/engine/types";
import { resultFromOutcome, type EngineOutcome } from "@/core/engine/validate";

const line = (rank: number, pv: string[], value = 20): EngineLine => ({ rank, score: { kind: "cp", value }, depth: 12, nodes: 1000, pv });
const outcome = (overrides: Partial<EngineOutcome> = {}): EngineOutcome => ({
  lines: [line(1, ["e2e4", "e7e5", "g1f3"]), line(2, ["d2d4", "d7d5"], 15)],
  bestMove: "e2e4",
  timeMs: 42,
  anomalies: [],
  ...overrides,
});

describe("resultFromOutcome", () => {
  it("records a valid result as done", () => {
    expect(resultFromOutcome(0, STANDARD_START_FEN, 2, outcome())).toEqual({
      positionIndex: 0,
      status: "done",
      lines: outcome().lines,
      bestMove: "e2e4",
      timeMs: 42,
    });
  });

  it("accepts a best move that differs from the last exact top line (decision D16)", () => {
    const result = resultFromOutcome(0, STANDARD_START_FEN, 2, outcome({ bestMove: "c2c4" }));
    expect(result).toMatchObject({ status: "done", bestMove: "c2c4" });
  });

  it("accepts fewer lines than MultiPV (e.g. only one legal move)", () => {
    expect(resultFromOutcome(0, STANDARD_START_FEN, 2, outcome({ lines: [line(1, ["e2e4"])] })).status).toBe("done");
  });

  it.each([
    ["anomalies", { anomalies: ["engine reported mate 0"] }, "Engine anomaly: engine reported mate 0"],
    ["no lines", { lines: [] }, "no evaluation"],
    ["too many lines", {}, "returned 2 lines for MultiPV 1"],
    ["no top line", { lines: [line(2, ["d2d4"])] }, "no top line"],
    ["no best move", { bestMove: null }, "no best move"],
    ["illegal best move", { bestMove: "e2e5" }, "best move e2e5 is illegal"],
    ["empty PV", { lines: [line(1, [])] }, "Line 1 has an empty PV"],
    ["illegal PV move", { lines: [line(1, ["e2e4", "e7e5", "e4e5"])] }, "Line 1 has an illegal move e4e5 at PV ply 3"],
    ["illegal move in line 2", { lines: [line(1, ["e2e4"]), line(2, ["d2d5"])] }, "Line 2 has an illegal move d2d5 at PV ply 1"],
  ] as const)("marks %s as failed", (_name, overrides, message) => {
    const multiPv = _name === "too many lines" ? 1 : 2;
    const result = resultFromOutcome(5, STANDARD_START_FEN, multiPv, outcome(overrides as Partial<EngineOutcome>));
    expect(result.status).toBe("failed");
    expect(result.positionIndex).toBe(5);
    expect(result.lines).toEqual([]);
    expect(result.status === "failed" && result.error).toContain(message);
  });
});
