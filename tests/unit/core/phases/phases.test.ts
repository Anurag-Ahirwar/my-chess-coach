import { describe, expect, it } from "vitest";
import { materialBalance, majorsAndMinors, pieceCounts } from "@/core/chess/material";
import { positionsOf } from "@/core/chess/position";
import { METHODOLOGY_V1 } from "@/core/methodology/v1";
import { dividePhases } from "@/core/phases";
import { readFixture as fixtureText, readJsonFixture as fixtureJson } from "../../../helpers/fixtures";
import { gameFromPgn } from "../../../helpers/games";

const P = METHODOLOGY_V1.phases;
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

interface Annotation {
  pgn: string;
  lastBookPosition: number | null;
  middlegameStart: number | null;
  endgameStart: number | null;
}

describe("material helpers", () => {
  it("counts pieces, the back ranks and the balance", () => {
    const counts = pieceCounts(START);
    expect(majorsAndMinors(counts)).toBe(14);
    expect(counts.backRank).toEqual({ w: 8, b: 8 });
    expect(materialBalance(START, "w", METHODOLOGY_V1.material)).toBe(0);
    // White is a knight up; Black's view is the negative.
    const fen = "rnbqkb1r/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    expect(materialBalance(fen, "w", METHODOLOGY_V1.material)).toBe(3);
    expect(materialBalance(fen, "b", METHODOLOGY_V1.material)).toBe(-3);
    expect(() => pieceCounts("8/8/8 w - - 0 1")).toThrow(RangeError);
    expect(() => pieceCounts("8/8/8/8/8/8/8/7X w - - 0 1")).toThrow(RangeError);
  });
});

describe("phase divider rules (methodology §7, M12)", () => {
  it("the start position is the opening", () => {
    expect(dividePhases([START], undefined, P)).toEqual({ phases: ["opening"] });
  });

  it("middlegame at ≤ 10 pieces", () => {
    const ten = "rn2k2r/pppppppp/5n2/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1"; // 4 + 6 = 10 pieces, no sparse rank
    expect(majorsAndMinors(pieceCounts(ten))).toBe(10);
    const result = dividePhases([START, ten], undefined, P);
    expect(result).toMatchObject({ middlegameStart: 1, phases: ["opening", "middlegame"] });
  });

  it("middlegame when either side has fewer than 4 of its own pieces (any type) on its first rank", () => {
    const sparseWhite = "rnbqkbnr/pppppppp/8/8/8/2NPBN2/PPP1PPPP/R3K2R w KQkq - 0 1"; // R, K, R = 3 on rank 1
    expect(pieceCounts(sparseWhite).backRank.w).toBe(3);
    expect(dividePhases([START, sparseWhite], undefined, P).middlegameStart).toBe(1);
    // Pawns and the king count: 4 on rank 1 is not sparse.
    const four = "rnbqkbnr/pppppppp/8/8/8/2NPBN2/PPP1PPPP/R3K1PR w Kkq - 0 1";
    expect(pieceCounts(four).backRank.w).toBe(4);
    expect(dividePhases([START, four], undefined, P).middlegameStart).toBeUndefined();
  });

  it("the 12-move guard counts from the last Book position, or from position 0", () => {
    const fens = Array.from({ length: 40 }, () => START);
    expect(dividePhases(fens, undefined, P).middlegameStart).toBe(24);
    expect(dividePhases(fens, 6, P).middlegameStart).toBe(30);
  });

  it("endgame at ≤ 6 pieces, or with no queens and at most one rook and one minor each", () => {
    const six = "4k3/8/8/8/8/8/8/RNB1KBNR w - - 0 1"; // 6 pieces, all White
    expect(dividePhases([START, six], undefined, P)).toMatchObject({ endgameStart: 1, phases: ["opening", "endgame"] });
    const rookMinor = "r1b1k3/8/8/8/8/8/8/R1B1K3 w - - 0 1"; // 4 pieces: each side R + B
    expect(dividePhases([rookMinor], undefined, P).endgameStart).toBe(0);
    const twoRooks = "r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1"; // 4 pieces but two rooks each: not "thin"... but ≤ 6 pieces
    expect(dividePhases([twoRooks], undefined, P).endgameStart).toBe(0);
    const queens = "3qk3/pppppppp/1n4n1/8/8/1N4N1/PPPPPPPP/3QK3 w - - 0 1"; // 6 pieces → endgame by count
    expect(dividePhases([queens], undefined, P).endgameStart).toBe(0);
    const eightThin = "rnb1k3/8/8/8/8/8/8/RNB1KR2 w - - 0 1"; // 7 pieces, two minors each → no endgame
    expect(dividePhases([eightThin], undefined, P).endgameStart).toBeUndefined();
  });

  it("skips the middlegame when the endgame starts at the same position", () => {
    const rookEnding = "4k3/r7/8/8/8/8/R7/4K3 w - - 0 1";
    expect(dividePhases([rookEnding], undefined, P)).toEqual({ phases: ["endgame"], endgameStart: 0 });
  });

  it("never goes back to an earlier phase (e.g. after a promotion)", () => {
    const few = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1";
    const promoted = "Q3k3/8/8/8/8/8/8/4K3 b - - 0 1";
    expect(dividePhases([few, promoted, START], undefined, P).phases).toEqual(["endgame", "endgame", "endgame"]);
  });
});

describe("hand-annotated games (tests/fixtures/phases)", () => {
  const { games } = fixtureJson<{ games: Annotation[] }>("phases", "annotations.json");
  for (const annotation of games) {
    it(`${annotation.pgn} with last Book position ${String(annotation.lastBookPosition)}`, async () => {
      const game = await gameFromPgn(fixtureText("pgn", ...annotation.pgn.split("/")));
      const result = dividePhases(positionsOf(game.startFen, game.plies), annotation.lastBookPosition ?? undefined, P);
      expect(result.middlegameStart ?? null).toBe(annotation.middlegameStart);
      expect(result.endgameStart ?? null).toBe(annotation.endgameStart);
    });
  }

  it("a miniature (checkmate on move 4) is all opening", async () => {
    const game = await gameFromPgn(fixtureText("pgn", "rules", "checkmate-white-wins.pgn"));
    const result = dividePhases(positionsOf(game.startFen, game.plies), undefined, P);
    expect(new Set(result.phases)).toEqual(new Set(["opening"]));
  });
});
