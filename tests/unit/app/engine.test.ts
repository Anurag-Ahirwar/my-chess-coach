import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePoolSize } from "@/app/analysis/engine";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolvePoolSize", () => {
  it("uses a fixed preference as is", () => {
    expect(resolvePoolSize(1)).toBe(1);
    expect(resolvePoolSize(3)).toBe(3);
  });

  it.each([
    [12, 4],
    [4, 3],
    [2, 1],
    [1, 1],
  ])("auto with %d logical cores -> %d engines (spec D7)", (cores, size) => {
    vi.stubGlobal("navigator", { hardwareConcurrency: cores });
    expect(resolvePoolSize("auto")).toBe(size);
  });

  it("auto without navigator falls back to the minimum safe default", () => {
    vi.stubGlobal("navigator", undefined);
    expect(resolvePoolSize("auto")).toBe(1);
  });
});
