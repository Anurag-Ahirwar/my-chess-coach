import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { STANDARD_START_FEN } from "@/core/chess/position";
import type { Color } from "@/core/chess/types";
import { bandFor, classifyMove, mateRule, worse, type MoveInput, type PositionEval, type SpecialLabelRule } from "@/core/classify";
import type { Score } from "@/core/engine/types";
import { povScore } from "@/core/eval";
import { METHODOLOGY_V1 } from "@/core/methodology/v1";

const C = METHODOLOGY_V1;

/** A mover-POV score expressed as the stored White-POV score. */
type Pov = { cp: number } | { mate: number } | { terminal: "win" | "loss" | "draw" };
function white(pov: Pov, mover: Color): Score {
  const s = mover === "w" ? 1 : -1;
  if ("cp" in pov) return { kind: "cp", value: s * pov.cp + 0 };
  if ("mate" in pov) return { kind: "mate", moves: s * pov.mate };
  if (pov.terminal === "draw") return { kind: "terminal", result: "1/2-1/2" };
  const whiteWins = (pov.terminal === "win") === (mover === "w");
  return { kind: "terminal", result: whiteWins ? "1-0" : "0-1" };
}
const evalOf = (score: Score, bestMove = "a2a3"): PositionEval => ({ score, lines: [], bestMove });

function move(before: Pov, after: Pov, mover: Color = "w", extra: Partial<MoveInput> = {}): MoveInput {
  return {
    color: mover,
    uci: "e2e4",
    fenBefore: STANDARD_START_FEN,
    legalMoves: 20,
    bookChain: false,
    before: evalOf(white(before, mover)),
    after: evalOf(white(after, mover === "w" ? "w" : "b")),
    analysis: { multiPv: 2, allowsSpecialLabels: true },
    ...extra,
  };
}

describe("severity bands (methodology §5.3)", () => {
  it.each([
    [0, "best"],
    [0.5, "best"],
    [0.51, "excellent"],
    [1.99, "excellent"],
    [2, "good"],
    [4.99, "good"],
    [5, "inaccuracy"],
    [9.99, "inaccuracy"],
    [10, "mistake"],
    [19.99, "mistake"],
    [20, "blunder"],
    [80, "blunder"],
  ] as const)("Win%% loss %f → %s", (loss, expected) => {
    expect(bandFor(loss, false, C.bands)).toBe(expected);
  });

  it("the engine's best move is Best whatever the (noisy) loss", () => {
    expect(bandFor(3, true, C.bands)).toBe("best");
    expect(bandFor(-0.1 + 0.1, true, C.bands)).toBe("best");
    expect(() => bandFor(-1, false, C.bands)).toThrow(RangeError);
  });

  // The worked examples of §5.3 (mover POV), for both colours.
  for (const mover of ["w", "b"] as const) {
    it.each([
      [0, -100, 9.1, "inaccuracy"],
      [0, -200, 17.6, "mistake"],
      [0, -300, 25.1, "blunder"],
      [150, -150, 26.9, "blunder"],
      [800, 500, 8.7, "inaccuracy"],
      [-800, -1000, 2.5, "good"],
      [1000, 0, 47.5, "blunder"],
    ] as const)(`${mover === "w" ? "White" : "Black"} moves: %i → %i cp loses %f Win%% → %s`, (b, a, loss, label) => {
      const verdict = classifyMove(move({ cp: b }, { cp: a }, mover), C);
      expect(verdict.winLoss).toBeCloseTo(loss, 1);
      expect(verdict.label).toBe(label);
      expect(verdict.severity).toBe(label);
      expect(verdict.reasons).toContain(`band:${label}`);
    });
  }

  it("clamps a negative loss (search noise) to 0", () => {
    const verdict = classifyMove(move({ cp: 20 }, { cp: 35 }), C);
    expect(verdict.winLoss).toBe(0);
    expect(verdict.label).toBe("best");
  });

  it("labels the engine's move Best even when the second search disagrees a little", () => {
    const input = move({ cp: 100 }, { cp: 40 }, "w", { uci: "a2a3" });
    const verdict = classifyMove(input, C);
    expect(verdict.label).toBe("best");
    expect(verdict.reasons).toEqual(["band:best", "engine:best"]);
  });
});

describe("mate rules (methodology §5.4)", () => {
  for (const mover of ["w", "b"] as const) {
    describe(mover === "w" ? "White moves" : "Black moves", () => {
      it.each([
        // Mate allowed: cp at P, mate against at P′.
        [{ cp: -1001 }, { mate: -3 }, "allowed", "inaccuracy"],
        [{ cp: -1000 }, { mate: -3 }, "allowed", "inaccuracy"],
        [{ cp: -999 }, { mate: -3 }, "allowed", "mistake"],
        [{ cp: -701 }, { mate: -1 }, "allowed", "mistake"],
        [{ cp: -700 }, { mate: -1 }, "allowed", "blunder"],
        [{ cp: 300 }, { mate: -2 }, "allowed", "blunder"],
        // Mate lost: mate for at P, not at P′.
        [{ mate: 2 }, { cp: 1500 }, "lost", "inaccuracy"],
        [{ mate: 2 }, { cp: 1000 }, "lost", "inaccuracy"],
        [{ mate: 2 }, { cp: 999 }, "lost", "mistake"],
        [{ mate: 2 }, { cp: 701 }, "lost", "mistake"],
        [{ mate: 2 }, { cp: 700 }, "lost", "blunder"],
        [{ mate: 2 }, { cp: 0 }, "lost", "blunder"],
        [{ mate: 2 }, { mate: -1 }, "lost", "blunder"],
        [{ mate: 2 }, { terminal: "draw" }, "lost", "blunder"], // M7: stalemating while mating
      ] as const)("%j → %j: mate %s, at least %s", (before, after, rule, minimum) => {
        const verdict = classifyMove(move(before, after, mover), C);
        expect(verdict.reasons).toContain(`mate:${rule}`);
        // The worse of the band and the rule's minimum.
        expect(verdict.severity).toBe(worse(bandFor(verdict.winLoss!, false, C.bands), minimum));
      });
    });
  }

  it("applies the worse of the band and the mate minimum", () => {
    // cp −1000 → mate against: L = 0, band Best, minimum Inaccuracy → Inaccuracy.
    const allowed = classifyMove(move({ cp: -1000 }, { mate: -3 }), C);
    expect(allowed.severity).toBe("inaccuracy");
    expect(allowed.reasons).toEqual(["mate:allowed", "band:best", "mate:minimum:inaccuracy"]);
    // Mate in 2 → +10.00 cp: L = 0, minimum Inaccuracy.
    expect(classifyMove(move({ mate: 2 }, { cp: 1000 }), C).severity).toBe("inaccuracy");
    // Mate in 2 → +8.00: L = 2.5 (Good) but minimum Mistake → Mistake.
    expect(classifyMove(move({ mate: 2 }, { cp: 800 }), C).severity).toBe("mistake");
  });

  it("mate delayed sets no minimum; delivering mate triggers no rule", () => {
    const delayed = classifyMove(move({ mate: 2 }, { mate: 3 }), C);
    expect(delayed.reasons).toContain("mate:delayed");
    expect(delayed.label).toBe("best");
    expect(classifyMove(move({ mate: 2 }, { mate: 2 }), C).reasons).toContain("mate:delayed");
    expect(classifyMove(move({ mate: 2 }, { mate: 1 }), C).reasons).not.toContain("mate:delayed");
    const delivered = classifyMove(move({ mate: 1 }, { terminal: "win" }), C);
    expect(delivered.reasons).toEqual(["band:best"]);
    expect(delivered.label).toBe("best");
  });

  it("no rule while already being mated or when nobody mates", () => {
    expect(mateRule(povScore({ kind: "mate", moves: -3 }, "w"), povScore({ kind: "mate", moves: -2 }, "w"), C.mate)).toBeUndefined();
    expect(mateRule(povScore({ kind: "cp", value: 30 }, "w"), povScore({ kind: "cp", value: -400 }, "w"), C.mate)).toBeUndefined();
  });

  it("the three rules never fire together, and each fires only on its own conditions (property)", () => {
    const pov = fc.oneof(
      fc.integer({ min: -2000, max: 2000 }).map((cp) => ({ kind: "cp" as const, value: cp })),
      fc.integer({ min: -20, max: 20 }).filter((n) => n !== 0).map((moves) => ({ kind: "mate" as const, moves })),
      fc.constantFrom({ kind: "terminal" as const, outcome: "win" as const }, { kind: "terminal" as const, outcome: "draw" as const }),
    );
    fc.assert(
      fc.property(pov, pov, (before, after) => {
        if (before.kind === "terminal") return; // P always has a next move
        const result = mateRule(before, after, C.mate);
        if (!result) return;
        if (result.rule === "allowed") {
          expect(before.kind).toBe("cp");
          expect(after.kind === "mate" && after.moves < 0).toBe(true);
        } else {
          expect(before.kind === "mate" && before.moves > 0).toBe(true);
          if (result.rule === "delayed") expect(after.kind === "mate" && after.moves > 0).toBe(true);
          else expect(after.kind === "mate" && after.moves > 0).toBe(false);
        }
      }),
    );
  });
});

describe("Miss (methodology §5.5, M8)", () => {
  it("opponent blundered, the mover didn't take it → Miss, severity kept", () => {
    const verdict = classifyMove(move({ cp: 400 }, { cp: 0 }, "w", { previousSeverity: "blunder" }), C);
    expect(verdict.label).toBe("miss");
    expect(verdict.severity).toBe("blunder");
    expect(verdict.reasons).toEqual(["band:blunder", "miss"]);
  });

  it("an opportunity measured by Wprev counts too (Black to move)", () => {
    const verdict = classifyMove(move({ cp: 400 }, { cp: 200 }, "b", { winPrev: 50 }), C); // L = 13.7
    expect(verdict.label).toBe("miss");
    expect(verdict.severity).toBe("mistake");
  });

  it("an opponent move labelled Miss still counts through its severity", () => {
    expect(classifyMove(move({ cp: 400 }, { cp: 0 }, "w", { previousSeverity: "mistake" }), C).label).toBe("miss");
  });

  it("a triggered Mate lost counts even when the band is mild", () => {
    const verdict = classifyMove(move({ mate: 3 }, { cp: 1200 }, "w", { previousSeverity: "blunder" }), C);
    expect(verdict.label).toBe("miss");
    expect(verdict.severity).toBe("inaccuracy");
  });

  it.each([
    ["the opponent's mistake was small", { previousSeverity: "inaccuracy" as const, winPrev: 75 }, { cp: 400 }, { cp: 0 }],
    ["the mover's move was only an inaccuracy", { previousSeverity: "blunder" as const }, { cp: 400 }, { cp: 250 }],
    ["there was nothing to take (Wb < 60)", { previousSeverity: "blunder" as const }, { cp: 100 }, { cp: -200 }],
    ["no information about the previous move (first move)", {}, { cp: 400 }, { cp: 0 }],
  ])("not a Miss when %s", (_name, extra, before, after) => {
    const verdict = classifyMove(move(before, after, "w", extra), C);
    expect(verdict.label).not.toBe("miss");
  });
});

describe("Forced, Book and missing evaluations (§5.2, §5.8, §5.9, §6.4)", () => {
  it("the only legal move is Forced, whatever it loses, with no severity", () => {
    const verdict = classifyMove(move({ cp: 0 }, { cp: -600 }, "w", { legalMoves: 1 }), C);
    expect(verdict).toMatchObject({ label: "forced", reasons: ["forced"] });
    expect(verdict.severity).toBeUndefined();
    expect(verdict.winLoss).toBeGreaterThan(20);
  });

  it("an in-book move is Book (no severity); Forced comes first", () => {
    expect(classifyMove(move({ cp: 20 }, { cp: 15 }, "w", { bookChain: true }), C)).toMatchObject({ label: "book", reasons: ["book"] });
    expect(classifyMove(move({ cp: 20 }, { cp: 15 }, "w", { bookChain: true, legalMoves: 1 }), C).label).toBe("forced");
    expect(classifyMove(move({ cp: 20 }, { cp: 15 }, "w", { bookChain: true }), C).severity).toBeUndefined();
  });

  it("a missing evaluation on either side leaves the move unlabelled, even if Forced or Book (M6)", () => {
    for (const side of ["before", "after"] as const) {
      const verdict = classifyMove(move({ cp: 0 }, { cp: 0 }, "w", { [side]: undefined, legalMoves: 1, bookChain: true }), C);
      expect(verdict).toEqual({ reasons: ["missing:eval"] });
    }
  });
});

describe("experimental labels hook (§5.2: tried only for Best)", () => {
  const always: SpecialLabelRule = { label: "great", evaluate: () => ["great:test"] };
  it("is tried only when the severity is Best", () => {
    expect(classifyMove(move({ cp: 50 }, { cp: 50 }), C, [always])).toMatchObject({ label: "great", severity: "best" });
    expect(classifyMove(move({ cp: 50 }, { cp: -200 }), C, [always]).label).toBe("blunder"); // L = 22.2
    expect(classifyMove(move({ cp: 50 }, { cp: 50 }, "w", { bookChain: true }), C, [always]).label).toBe("book");
  });
});
