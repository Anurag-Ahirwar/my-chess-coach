import { describe, expect, it } from "vitest";
import { GameReplay, IllegalMoveError, InvalidFenError, STANDARD_START_FEN, positionsOf, replayUciLine } from "@/core/chess/position";
import { parsePgn, type ParsedGame } from "@/core/pgn";
import { readFixture } from "../../../helpers/fixtures";

function parseOne(file: string): ParsedGame {
  const { games, errors } = parsePgn(readFixture("pgn", "rules", file));
  expect(errors).toEqual([]);
  expect(games).toHaveLength(1);
  return games[0]!;
}

function parseError(file: string) {
  const { games, errors } = parsePgn(readFixture("pgn", "rules", file));
  expect(games).toEqual([]);
  expect(errors).toHaveLength(1);
  return errors[0]!;
}

const ucis = (game: ParsedGame) => game.plies.map((ply) => ply.uci);

describe("castling", () => {
  it("castles kingside and queenside, recorded as UCI king moves", () => {
    const game = parseOne("castling-both-sides.pgn");
    expect(game.plies[6]).toMatchObject({ san: "O-O", uci: "e1g1", color: "w" });
    expect(game.plies[11]).toMatchObject({ san: "O-O-O", uci: "e8c8", color: "b" });
  });

  it("accepts zero-notation castling (0-0)", () => {
    expect(parseOne("castling-zero-notation.pgn").plies[6]).toMatchObject({ san: "O-O", uci: "e1g1" });
  });

  it("rejects castling through an attacked square", () => {
    expect(parseError("castling-through-check.pgn")).toMatchObject({ kind: "illegal_move", san: "O-O", moveLabel: "1." });
  });

  it("rejects castling after the rook has moved and returned", () => {
    expect(parseError("castling-after-rook-moved.pgn")).toMatchObject({ kind: "illegal_move", san: "O-O", moveLabel: "6." });
  });
});

describe("en passant", () => {
  it("allows the capture on the immediately following move", () => {
    const game = parseOne("en-passant.pgn");
    expect(game.plies[4]).toMatchObject({ san: "exd6", uci: "e5d6" });
    // The captured pawn on d5 is gone.
    expect(game.plies[4]!.fenAfter.split(" ")[0]).toBe("rnbqkb1r/ppp1pppp/3P1n2/8/8/8/PPPP1PPP/RNBQKBNR");
  });

  it("rejects it one move too late", () => {
    expect(parseError("en-passant-too-late.pgn")).toMatchObject({ kind: "illegal_move", san: "exd6", moveLabel: "4." });
  });
});

describe("promotion", () => {
  const { games, errors } = parsePgn(readFixture("pgn", "rules", "promotions.pgn"));

  it("parses every promotion game", () => {
    expect(errors).toEqual([]);
    expect(games).toHaveLength(8);
  });

  it.each([
    [0, "a8=Q+", "a7a8q"],
    [1, "a8=R+", "a7a8r"],
    [2, "a8=B", "a7a8b"],
    [3, "a8=N", "a7a8n"],
    [4, "a8=N+", "a7a8n"],
    [5, "axb8=Q", "a7b8q"],
    [6, "a1=Q+", "a2a1q"],
    [7, "a8=Q+", "a7a8q"],
  ])("game %i: %s is %s", (index, san, uci) => {
    const ply = games[index]!.plies[0]!;
    expect(ply.san).toBe(san);
    expect(ply.uci).toBe(uci);
  });

  it("records Black as the mover when Black promotes", () => {
    expect(games[6]!.plies[0]!.color).toBe("b");
  });
});

describe("terminal states", () => {
  it("detects checkmate with White winning", () => {
    const game = parseOne("checkmate-white-wins.pgn");
    expect(game.terminal).toEqual({ kind: "checkmate", winner: "w" });
    expect(game.result).toBe("1-0");
  });

  it("detects checkmate with Black winning", () => {
    expect(parseOne("checkmate-black-wins.pgn").terminal).toEqual({ kind: "checkmate", winner: "b" });
  });

  it("detects stalemate", () => {
    expect(parseOne("stalemate.pgn").terminal).toEqual({ kind: "stalemate" });
  });

  it("detects insufficient material", () => {
    expect(parseOne("insufficient-material.pgn").terminal).toEqual({ kind: "insufficient_material" });
  });

  it("detects threefold repetition from the move history", () => {
    const game = parseOne("threefold-repetition.pgn");
    expect(game.terminal).toEqual({ kind: "threefold_repetition" });
    // The same final position loaded on its own has no history, so it is not a repetition.
    expect(new GameReplay(game.plies.at(-1)!.fenAfter).terminalState()).toBeNull();
  });

  it("detects the fifty-move rule", () => {
    expect(parseOne("fifty-move-rule.pgn").terminal).toEqual({ kind: "fifty_move_rule" });
  });

  it("reports no terminal state for a game in progress", () => {
    expect(parseOne("castling-both-sides.pgn").terminal).toBeNull();
  });
});

describe("custom start position", () => {
  it("starts with Black to move and alternates colours from there", () => {
    const game = parseOne("black-to-move-start.pgn");
    expect(game.startFen).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1");
    expect(game.plies.map((ply) => ply.color)).toEqual(["b", "w", "b"]);
    expect(ucis(game)).toEqual(["e7e5", "g1f3", "b8c6"]);
  });
});

describe("GameReplay", () => {
  it("rejects an invalid start FEN", () => {
    expect(() => new GameReplay("not a fen")).toThrow(InvalidFenError);
  });

  it("throws IllegalMoveError for illegal SAN and UCI moves", () => {
    const replay = new GameReplay();
    expect(() => replay.playSan("Ke2")).toThrow(IllegalMoveError);
    expect(() => replay.playUci("e2e5")).toThrow(IllegalMoveError);
    expect(() => replay.playUci("garbage")).toThrow(IllegalMoveError);
    expect(replay.fen).toBe(STANDARD_START_FEN);
  });

  it("plays UCI moves and reports SAN", () => {
    const replay = new GameReplay();
    expect(replay.playUci("g1f3")).toMatchObject({ san: "Nf3", color: "w" });
    expect(replay.turn).toBe("b");
    expect(replay.legalMoveCount()).toBe(20);
  });

  it("counts a single legal move", () => {
    // Black king on h8: g7 and h7 are covered by the white king, so Kg8 is the only move.
    expect(new GameReplay("7k/8/6K1/8/8/8/8/R7 b - - 0 1").legalMoveCount()).toBe(1);
  });
});

describe("replayUciLine", () => {
  it("converts an engine line to SAN", () => {
    const { moves, illegalAt } = replayUciLine(STANDARD_START_FEN, ["e2e4", "e7e5", "g1f3"]);
    expect(illegalAt).toBeUndefined();
    expect(moves.map((move) => move.san)).toEqual(["e4", "e5", "Nf3"]);
  });

  it("stops at the first illegal move", () => {
    const { moves, illegalAt } = replayUciLine(STANDARD_START_FEN, ["e2e4", "e2e4", "g1f3"]);
    expect(moves).toHaveLength(1);
    expect(illegalAt).toBe(1);
  });
});

describe("positionsOf", () => {
  it("lists the start position followed by the position after each ply", () => {
    const game = parseOne("en-passant.pgn");
    const positions = positionsOf(game.startFen, game.plies);
    expect(positions).toHaveLength(game.plies.length + 1);
    expect(positions[0]).toBe(STANDARD_START_FEN);
    expect(positions.at(-1)).toBe(game.plies.at(-1)!.fenAfter);
  });
});
