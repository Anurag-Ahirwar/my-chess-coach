import { describe, expect, it } from "vitest";
import { PRESETS } from "@/core/engine/analysis";
import { defaultSearchTimeoutMs } from "@/infra/engine/engineWorker";

// Slowest single search per preset in the Phase 2 benchmark (docs/BENCHMARKS.md, Chromium, one engine).
const MEASURED_MAX_MS = { quick: 466, standard: 1253, deep: 4765 };

describe("defaultSearchTimeoutMs (calibrated in Phase 2, Stage 4)", () => {
  it.each([
    ["quick", 13_000],
    ["standard", 22_000],
    ["deep", 60_000],
  ] as const)("%s: %d ms", (preset, expected) => {
    expect(defaultSearchTimeoutMs(PRESETS[preset].nodes)).toBe(expected);
  });

  it("leaves at least 10x headroom over the slowest measured search for every preset", () => {
    for (const preset of ["quick", "standard", "deep"] as const) {
      expect(defaultSearchTimeoutMs(PRESETS[preset].nodes)).toBeGreaterThanOrEqual(10 * MEASURED_MAX_MS[preset]);
    }
  });
});
