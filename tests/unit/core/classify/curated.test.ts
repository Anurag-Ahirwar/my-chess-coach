import { Chess } from "chess.js";
import { describe, expect, it } from "vitest";
import { replayUciLine } from "@/core/chess/position";
import { SPECIAL_RULES, classifyMove, type Label, type MoveInput, type PositionEval, type Severity } from "@/core/classify";
import { METHODOLOGY_V1, withConfig } from "@/core/methodology/v1";
import { readJsonFixture } from "../../../helpers/fixtures";

interface Case {
  id: string;
  rule: string;
  preset?: "quick" | "standard";
  fen: string;
  uci: string;
  previousSeverity?: Severity;
  previousMove?: { uci: string; capture: boolean };
  before: PositionEval;
  after: PositionEval;
  expect: { label?: Label; notLabel?: Label; severity?: Severity; reasons?: string[] };
}

const { cases } = readJsonFixture<{ cases: Case[] }>("classify", "positions", "curated.json");

function inputOf(c: Case): MoveInput {
  const chess = new Chess(c.fen);
  const multiPv = c.preset === "quick" ? 1 : 2;
  return {
    color: chess.turn(),
    uci: c.uci,
    fenBefore: c.fen,
    legalMoves: chess.moves().length,
    bookChain: false,
    before: c.before,
    after: c.after,
    previousSeverity: c.previousSeverity,
    previousMove: c.previousMove,
    analysis: { multiPv, allowsSpecialLabels: c.preset !== "quick" },
  };
}

describe("curated classification positions (tests/fixtures/classify/positions)", () => {
  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    // Every move and line in the fixture is legal (testing §3).
    const played = replayUciLine(c.fen, [c.uci]);
    expect(played.illegalAt, `${c.id}: played move`).toBeUndefined();
    const fenAfter = played.moves[0]!.fenAfter;
    for (const line of c.before.lines) expect(replayUciLine(c.fen, line.pv).illegalAt, `${c.id}: line before`).toBeUndefined();
    for (const line of c.after.lines) expect(replayUciLine(fenAfter, line.pv).illegalAt, `${c.id}: line after`).toBeUndefined();

    const verdict = classifyMove(inputOf(c), METHODOLOGY_V1, SPECIAL_RULES);
    if (c.expect.label) expect(verdict.label, c.rule).toBe(c.expect.label);
    if (c.expect.notLabel) expect(verdict.label, c.rule).not.toBe(c.expect.notLabel);
    if (c.expect.severity) expect(verdict.severity).toBe(c.expect.severity);
    for (const reason of c.expect.reasons ?? []) expect(verdict.reasons).toContain(reason);
  });

  it("the experimental flags switch Great and Brilliant off", () => {
    const off = withConfig(METHODOLOGY_V1, { great: { enabled: false }, brilliant: { enabled: false } });
    for (const id of ["brilliant-accepted-greek-gift", "brilliant-exchange-sacrifice", "great-only-move"]) {
      const c = cases.find((x) => x.id === id)!;
      expect(classifyMove(inputOf(c), off, SPECIAL_RULES).label).toBe("best");
    }
  });

  it("Brilliant takes precedence over Great", () => {
    const c = cases.find((x) => x.id === "brilliant-accepted-greek-gift")!;
    // Make the second line much worse so Great would also apply.
    const input = inputOf({ ...c, before: { ...c.before, lines: [c.before.lines[0]!, { ...c.before.lines[1]!, score: { kind: "cp", value: -400 } }] } });
    expect(classifyMove(input, METHODOLOGY_V1, SPECIAL_RULES).label).toBe("brilliant");
  });
});
