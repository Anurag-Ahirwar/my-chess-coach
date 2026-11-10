import { describe, expect, it } from "vitest";
import { formatScore } from "@/ui/format";

describe("formatScore (display only, White's perspective)", () => {
  it.each([
    [{ kind: "cp", value: 124 }, "+1.24"],
    [{ kind: "cp", value: -30 }, "−0.30"],
    [{ kind: "cp", value: 0 }, "0.00"],
    [{ kind: "cp", value: 5 }, "+0.05"],
    [{ kind: "cp", value: -1068 }, "−10.68"],
    [{ kind: "mate", moves: 3 }, "M3"],
    [{ kind: "mate", moves: -2 }, "−M2"],
    [{ kind: "terminal", result: "1-0" }, "1–0"],
    [{ kind: "terminal", result: "0-1" }, "0–1"],
    [{ kind: "terminal", result: "1/2-1/2" }, "½–½"],
  ] as const)("%o -> %s", (score, text) => {
    expect(formatScore(score)).toBe(text);
  });
});
