import { describe, expect, it } from "vitest";
import { METHODOLOGY_V1 } from "@/core/methodology/v1";
import { OpeningIndexError, loadOpeningIndex, parseOpeningIndex } from "@/infra/openings/load";
import { realOpeningIndex } from "../../helpers/openings";

const COMMIT = METHODOLOGY_V1.openings.commit;

describe("opening index loader", () => {
  it("accepts the generated index built from the pinned commit", () => {
    const index = parseOpeningIndex(JSON.parse(JSON.stringify(realOpeningIndex().json)), COMMIT);
    expect(index.commit).toBe(COMMIT);
    expect(index.name("rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -")).toEqual({ eco: "B20", name: "Sicilian Defense" });
  }, 60_000);

  it("refuses an index built from another dataset commit", () => {
    const json = { ...realOpeningIndex().json, commit: "0".repeat(40) };
    expect(() => parseOpeningIndex(json, COMMIT)).toThrow(OpeningIndexError);
    expect(() => parseOpeningIndex(json, COMMIT)).toThrow(/not 3ba6b20/);
  }, 60_000);

  it("refuses an invalid index", () => {
    expect(() => parseOpeningIndex({ commit: COMMIT }, COMMIT)).toThrow(/invalid/);
    expect(() => parseOpeningIndex(null, COMMIT)).toThrow(OpeningIndexError);
  });

  it("reports an HTTP failure", async () => {
    const fetchImpl = (() => Promise.resolve(new Response("missing", { status: 404 }))) as typeof fetch;
    await expect(loadOpeningIndex("/openings/index.json", COMMIT, fetchImpl)).rejects.toThrow(/HTTP 404/);
  });
});
