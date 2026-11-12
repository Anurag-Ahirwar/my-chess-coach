import { describe, expect, it } from "vitest";
import { LABELS, type Label } from "@/core/classify";
import { DISPLAY_ORDER, LABEL_INFO, displayCounts, displayLabel, reasonTexts } from "@/ui/review/presentation";

const counts = (values: Partial<Record<Label, number>>): Record<Label, number> =>
  Object.fromEntries(LABELS.map((l) => [l, values[l] ?? 0])) as Record<Label, number>;

describe("label presentation (display only)", () => {
  it("has a name and a symbol for every label, and lists every label once", () => {
    for (const label of LABELS) {
      expect(LABEL_INFO[label].name).not.toBe("");
      expect(LABEL_INFO[label].symbol).not.toBe("");
    }
    expect([...DISPLAY_ORDER].sort()).toEqual([...LABELS].sort());
    expect(LABELS.filter((l) => LABEL_INFO[l].experimental).sort()).toEqual(["brilliant", "great"]);
  });

  it("shows Great and Brilliant as Best when experimental labels are hidden, and as themselves when shown", () => {
    expect(displayLabel("great", false)).toBe("best");
    expect(displayLabel("brilliant", false)).toBe("best");
    expect(displayLabel("great", true)).toBe("great");
    expect(displayLabel("brilliant", true)).toBe("brilliant");
    for (const label of LABELS.filter((l) => !LABEL_INFO[l].experimental)) {
      expect(displayLabel(label, false)).toBe(label);
      expect(displayLabel(label, true)).toBe(label);
    }
    expect(displayLabel(undefined, true)).toBeUndefined();
  });

  it("folds Great and Brilliant counts into Best when hidden; the total never changes", () => {
    const stored = counts({ brilliant: 1, great: 3, best: 20, excellent: 5, blunder: 2 });
    const hidden = displayCounts(stored, false);
    expect(hidden.map((c) => c.label)).not.toContain("great");
    expect(hidden.map((c) => c.label)).not.toContain("brilliant");
    expect(hidden.find((c) => c.label === "best")!.count).toBe(24);
    const shown = displayCounts(stored, true);
    expect(shown.find((c) => c.label === "great")!.count).toBe(3);
    expect(shown.find((c) => c.label === "brilliant")!.count).toBe(1);
    expect(shown.find((c) => c.label === "best")!.count).toBe(20);
    const total = (list: { count: number }[]) => list.reduce((s, c) => s + c.count, 0);
    expect(total(hidden)).toBe(31);
    expect(total(shown)).toBe(31);
    // The stored counts are not modified.
    expect(stored.great).toBe(3);
    expect(stored.best).toBe(20);
  });

  it("puts reasons in plain words and leaves out hidden experimental reasons", () => {
    const move = { labelReasons: ["mate:lost", "band:best", "engine:best", "mate:minimum:inaccuracy"], winLoss: 0 };
    expect(reasonTexts(move, false)).toEqual([
      "A forced mate was available and is no longer.",
      "Winning chances lost: 0.0% (Best range).",
      "The engine's top move.",
      "The mate rules make this at least Inaccuracy.",
    ]);
    const great = { labelReasons: ["band:best", "great", "great:gap:17.0"], winLoss: 0.2 };
    expect(reasonTexts(great, false)).toEqual(["Winning chances lost: 0.2% (Best range)."]);
    expect(reasonTexts(great, true)).toContain("The second-best move keeps 17.0% less winning chance.");
    expect(reasonTexts({ labelReasons: ["missing:eval"] }, true)[0]).toMatch(/not graded/);
    expect(reasonTexts({ labelReasons: ["brilliant", "brilliant:sacrifice:h7", "brilliant:mate-exception"] }, true)).toHaveLength(3);
  });
});

describe("numberedLine", () => {
  it("numbers a line from either side to move", async () => {
    const { numberedLine } = await import("@/ui/review/presentation");
    expect(numberedLine("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", ["e4", "e5", "Nf3"])).toBe("1. e4 e5 2. Nf3");
    expect(numberedLine("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 12", ["c5", "Nf3"])).toBe("12... c5 13. Nf3");
    expect(numberedLine("8/8/8/8/8/8/8/8 w - - 0 1", [])).toBe("");
  });
});
