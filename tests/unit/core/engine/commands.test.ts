import { describe, expect, it } from "vitest";
import { STANDARD_START_FEN } from "@/core/chess/position";
import { goCommand, positionCommand } from "@/core/engine/commands";

describe("positionCommand", () => {
  it("uses startpos for the standard start", () => {
    expect(positionCommand(STANDARD_START_FEN, [])).toBe("position startpos");
    expect(positionCommand(STANDARD_START_FEN, ["e2e4", "e7e5"])).toBe("position startpos moves e2e4 e7e5");
  });

  it("uses the game's start FEN plus the full move history for custom starts", () => {
    const fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    expect(positionCommand(fen, [])).toBe(`position fen ${fen}`);
    expect(positionCommand(fen, ["e7e5", "g1f3"])).toBe(`position fen ${fen} moves e7e5 g1f3`);
  });
});

describe("goCommand", () => {
  it("is node-limited with a depth cap", () => {
    expect(goCommand(150_000, 18)).toBe("go nodes 150000 depth 18");
  });

  it.each([
    [0, 18],
    [-1, 18],
    [1.5, 18],
    [100, 0],
    [100, Number.NaN],
  ])("rejects nodes=%d depth=%d", (nodes, depth) => {
    expect(() => goCommand(nodes, depth)).toThrow(RangeError);
  });
});
