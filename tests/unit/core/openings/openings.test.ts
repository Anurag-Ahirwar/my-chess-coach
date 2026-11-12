import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { positionsOf } from "@/core/chess/position";
import { METHODOLOGY_V1 } from "@/core/methodology/v1";
import { EMPTY_OPENING_INDEX, bookChainLength, openingOf } from "@/core/openings";
import { OPENINGS_DIR, PINNED, buildOpeningIndex, readDataset } from "../../../../scripts/build-openings.mjs";
import { gameFromPgn, gameFromUci } from "../../../helpers/games";
import { realOpeningIndex } from "../../../helpers/openings";

const { json, index } = realOpeningIndex();
const fensOf = async (moves: string[], startFen?: string) => {
  const game = await gameFromUci(moves, startFen);
  return positionsOf(game.startFen, game.plies);
};

describe("opening index build (scripts/build-openings.mjs)", () => {
  it("uses the dataset commit pinned in the methodology config", () => {
    expect(PINNED.commit).toBe(METHODOLOGY_V1.openings.commit);
    expect(json.commit).toBe(METHODOLOGY_V1.openings.commit);
    expect(json.licence).toBe("CC0-1.0");
  });

  it("covers every named line of the pinned dataset", () => {
    expect(json.lines).toBe(3865);
    expect(json.named).toBe(3865);
    expect(json.positions).toBe(7982);
    expect(json.book.length + Object.keys(json.names).length).toBe(json.positions);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildOpeningIndex(readDataset()))).toBe(JSON.stringify(json));
  }, 60_000); // building the index takes seconds (more under coverage)

  it("refuses a dataset that differs from the pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "openings-"));
    try {
      for (const file of Object.keys(PINNED.files)) copyFileSync(join(OPENINGS_DIR, file), join(dir, file));
      expect(readDataset(dir)).toHaveLength(3865); // an exact copy is accepted
      writeFileSync(join(dir, "c.tsv"), readFileSync(join(dir, "c.tsv"), "utf8").replace("Sicilian", "Sicillian"));
      expect(() => readDataset(dir)).toThrow(/c\.tsv does not match the pinned dataset/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("opening names and the book chain (methodology §5.8)", () => {
  it("names the deepest named position", async () => {
    expect(openingOf(await fensOf(["e2e4", "c7c5"]), index)).toEqual({ eco: "B20", name: "Sicilian Defense", ply: 2 });
    expect(openingOf(await fensOf(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"]), index)).toMatchObject({ eco: "C60", ply: 5 });
    // A later out-of-book move keeps the deepest named position's name.
    expect(openingOf(await fensOf(["e2e4", "c7c5", "h2h4", "h7h5", "a2a4"]), index)?.name).toMatch(/^Sicilian Defense/);
  });

  it("finds transpositions by position, not by move order", async () => {
    const a = openingOf(await fensOf(["d2d4", "d7d5", "g1f3"]), index);
    const b = openingOf(await fensOf(["g1f3", "d7d5", "d2d4"]), index);
    expect(a).toBeDefined();
    expect(a?.name).toBe(b?.name);
    expect(bookChainLength(await fensOf(["g1f3", "d7d5", "d2d4"]), index)).toBe(3);
  });

  it("finds positions with an en passant square through the app's own import (same EPD rule as the build)", async () => {
    // E63 Blockade Line ends after 10...e5 with d5xe6 en passant available: the EPD has "e6".
    const game = await gameFromPgn("1. d4 Nf6 2. c4 g6 3. Nf3 Bg7 4. g3 O-O 5. Bg2 d6 6. O-O Nc6 7. Nc3 a6 8. d5 Na5 9. Nd2 c5 10. Qc2 e5 *");
    const fens = positionsOf(game.startFen, game.plies);
    expect(fens[20]!.split(" ")[3]).toBe("e6");
    expect(openingOf(fens, index)).toEqual({ eco: "E63", name: "King's Indian Defense: Fianchetto Variation, Panno Variation, Blockade Line", ply: 20 });
    expect(bookChainLength(fens, index)).toBe(20);
    expect(Object.keys(json.names).filter((epd) => epd.split(" ")[3] !== "-")).toHaveLength(15);
  });

  it("the chain stops at the first position outside the index and never restarts", async () => {
    const fens = await fensOf(["e2e4", "e7e5", "a2a3", "a7a6", "g1f3", "b8c6"]);
    expect(bookChainLength(fens, index)).toBeLessThan(4);
    const game = await fensOf(["e2e4", "h7h5", "e4e5", "h5h4"]);
    expect(bookChainLength(game, index)).toBeLessThanOrEqual(2);
  });

  it("gives no name to an unknown position and no book moves with the empty index", async () => {
    const fens = await fensOf(["a2a3", "h7h6", "h2h3", "a7a6", "b2b3", "g7g6", "g2g3"]);
    expect(openingOf(fens.slice(0, 1), index)).toBeUndefined();
    expect(openingOf(fens, EMPTY_OPENING_INDEX)).toBeUndefined();
    expect(bookChainLength(fens, EMPTY_OPENING_INDEX)).toBe(0);
  });
});
