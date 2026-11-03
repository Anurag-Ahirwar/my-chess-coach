import { describe, expect, it } from "vitest";
import { describePgnError, parsePgn } from "@/core/pgn";
import { listFixtures, readFixture } from "../../../helpers/fixtures";

describe("malformed PGN", () => {
  const expectations: Record<string, { kind: string; line: number; column: number; messageIncludes: string }> = {
    "illegal-move.pgn": { kind: "illegal_move", line: 7, column: 4, messageIncludes: '"Ke3" at 3.' },
    "unreadable-san.pgn": { kind: "illegal_move", line: 4, column: 13, messageIncludes: '"Xx4" at 2.' },
    "unterminated-comment.pgn": { kind: "syntax", line: 4, column: 17, messageIncludes: "Unterminated comment" },
    "unsupported-variant.pgn": { kind: "unsupported_variant", line: 7, column: 4, messageIncludes: "Chess960" },
    "invalid-fen.pgn": { kind: "invalid_fen", line: 6, column: 4, messageIncludes: "Invalid FEN" },
    "unexpected-close-paren.pgn": { kind: "unbalanced_variation", line: 4, column: 7, messageIncludes: "')'" },
    "missing-close-paren.pgn": { kind: "unbalanced_variation", line: 1, column: 1, messageIncludes: "closing ')'" },
    "malformed-tag.pgn": { kind: "syntax", line: 1, column: 1, messageIncludes: "unterminated value" },
    "truncated-movetext.pgn": { kind: "illegal_move", line: 4, column: 24, messageIncludes: '"Bb" at 3.' },
  };

  it("has an expectation for every malformed fixture", () => {
    expect(listFixtures("pgn", "malformed")).toEqual(Object.keys(expectations).sort());
  });

  it.each(Object.entries(expectations))("%s reports %o", (file, expected) => {
    const { games, errors } = parsePgn(readFixture("pgn", "malformed", file));
    expect(games).toEqual([]);
    expect(errors).toHaveLength(1);
    const error = errors[0]!;
    expect(error).toMatchObject({ kind: expected.kind, line: expected.line, column: expected.column, gameIndex: 0 });
    expect(error.message).toContain(expected.messageIncludes);
    expect(describePgnError(error)).toMatch(/^Game 1 \(.+\), line \d+, column \d+: /);
  });

  it("labels errors with the player names", () => {
    const { errors } = parsePgn(readFixture("pgn", "malformed", "illegal-move.pgn"));
    expect(errors[0]!.gameLabel).toBe("Alice vs Bob");
    expect(describePgnError(errors[0]!)).toBe(
      'Game 1 (Alice vs Bob), line 7, column 4: Illegal or unreadable move "Ke3" at 3. (White to move)',
    );
  });
});

describe("edge cases", () => {
  it("handles a BOM and CRLF line endings", () => {
    const { games, errors } = parsePgn(readFixture("pgn", "edge-cases", "bom-crlf.pgn"));
    expect(errors).toEqual([]);
    expect(games).toHaveLength(1);
    const game = games[0]!;
    expect(game.headers["Event"]).toBe("BOM and CRLF");
    expect(game.plies).toHaveLength(7);
    expect(game.plies[0]!.clockSeconds).toBe(180);
    expect(game.plies[1]!.clockSeconds).toBe(179.9);
    expect(game.terminal).toEqual({ kind: "checkmate", winner: "w" });
  });

  describe("multi-game file with comments, NAGs, variations and a broken game", () => {
    const { games, errors } = parsePgn(readFixture("pgn", "edge-cases", "multi-game-with-annotations.pgn"));

    it("parses the valid games and keeps going after the broken one", () => {
      expect(games.map((game) => game.headers["Event"])).toEqual(["Game one", "Game two", "Game four"]);
      expect(games.map((game) => game.index)).toEqual([0, 1, 3]);
    });

    it("keeps only the main line, ignoring variations, NAGs and glyphs", () => {
      expect(games[0]!.plies.map((ply) => ply.san)).toEqual(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O"]);
      expect(games[0]!.result).toBe("1-0");
    });

    it("handles moves glued to move numbers and multi-line comments containing brackets", () => {
      expect(games[1]!.plies.map((ply) => ply.san)).toEqual(["d4", "d5", "c4", "dxc4", "e3", "b5"]);
    });

    it("reports the broken game with its index and location", () => {
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ gameIndex: 2, gameLabel: "E vs F", kind: "illegal_move", san: "Qxe1", line: 23 });
    });
  });

  it("returns nothing for empty input", () => {
    expect(parsePgn("")).toEqual({ games: [], errors: [] });
    expect(parsePgn("  \n\n ")).toEqual({ games: [], errors: [] });
  });

  it("parses bare movetext without tags", () => {
    const { games, errors } = parsePgn("1. e4 e5 2. Nf3");
    expect(errors).toEqual([]);
    expect(games[0]!.plies).toHaveLength(3);
    expect(games[0]!.result).toBe("*");
  });

  it("splits games that have no result token", () => {
    const { games } = parsePgn('[Event "a"]\n\n1. e4\n\n[Event "b"]\n\n1. d4 d5');
    expect(games.map((game) => game.plies.length)).toEqual([1, 2]);
  });

  it("parses a game with tags but no moves", () => {
    const { games, errors } = parsePgn('[Event "Empty"]\n[Result "*"]\n\n*');
    expect(errors).toEqual([]);
    expect(games[0]!.plies).toEqual([]);
  });

  it("falls back to the Result tag and warns when it disagrees with the movetext", () => {
    expect(parsePgn('[Result "0-1"]\n\n1. e4').games[0]!.result).toBe("0-1");
    const game = parsePgn('[Result "0-1"]\n\n1. e4 1-0').games[0]!;
    expect(game.result).toBe("1-0");
    expect(game.warnings[0]).toContain("differs");
  });

  it("warns about duplicate tags and keeps the last value", () => {
    const game = parsePgn('[White "a"]\n[White "b"]\n\n1. e4 *').games[0]!;
    expect(game.headers["White"]).toBe("b");
    expect(game.warnings[0]).toContain("Duplicate tag [White]");
  });

  it("unescapes quotes and backslashes in tag values", () => {
    const game = parsePgn('[Event "The \\"big\\" game \\\\ 1"]\n\n1. e4 *').games[0]!;
    expect(game.headers["Event"]).toBe('The "big" game \\ 1');
  });

  it("accepts the ½-½ result glyph", () => {
    expect(parsePgn("1. e4 e5 ½-½").games[0]!.result).toBe("1/2-1/2");
  });

  it("ignores a result inside a variation", () => {
    const game = parsePgn("1. e4 (1. d4 1-0) 1... e5 *").games[0]!;
    expect(game.plies.map((ply) => ply.san)).toEqual(["e4", "e5"]);
    expect(game.result).toBe("*");
  });

  it("reports a stray closing brace, quote or $ as a syntax error", () => {
    expect(parsePgn("1. e4 } e5").errors[0]).toMatchObject({ kind: "syntax", message: "Unexpected '}'" });
    expect(parsePgn("1. e4 $ e5").errors[0]).toMatchObject({ kind: "syntax" });
  });

  it.each([
    ['[ "x"]\n\n1. e4', "missing tag name"],
    ["[Event x]\n\n1. e4", "missing opening quote"],
    ['[Event "x"\n\n1. e4', "missing ']'"],
    ['[Event "x\n"]\n\n1. e4', "unterminated value"],
  ])("reports malformed tag %j", (pgn, message) => {
    expect(parsePgn(pgn).errors[0]!.message).toContain(message);
  });

  it("attaches only the first clock comment to a move", () => {
    const game = parsePgn("1. e4 {[%clk 0:01:00]} {[%clk 0:00:10]} e5 {no clock here} *").games[0]!;
    expect(game.plies[0]!.clockSeconds).toBe(60);
    expect(game.plies[1]!.clockSeconds).toBeUndefined();
  });
});

describe("real Chess.com games", () => {
  const files = listFixtures("pgn", "chesscom");

  it("has a corpus of at least 20 games", () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files)("%s parses with clocks on every move", (file) => {
    const { games, errors } = parsePgn(readFixture("pgn", "chesscom", file));
    expect(errors).toEqual([]);
    expect(games).toHaveLength(1);
    const game = games[0]!;
    expect(game.plies.length).toBeGreaterThan(0);
    expect(game.plies.every((ply) => ply.clockSeconds !== undefined)).toBe(true);
    // The final position matches Chess.com's own CurrentPosition tag. Chess.com always writes the
    // en-passant square after a double pawn push; chess.js only when a capture is legal. Both are
    // valid FEN, so that one field may differ only in that direction.
    const current = game.headers["CurrentPosition"];
    if (current) {
      const ours = game.plies.at(-1)!.fenAfter.split(" ");
      const theirs = current.split(" ");
      expect([...ours.slice(0, 3), ...ours.slice(4)]).toEqual([...theirs.slice(0, 3), ...theirs.slice(4)]);
      expect([theirs[3], "-"]).toContain(ours[3]);
    }
  });

  // Clock values checked by hand against the PGN text of three games (first two and last moves).
  it.each([
    ["01-blitz.pgn", [180, 180], 86.2],
    ["07-bullet.pgn", [56.4, 59.9], 47.1],
    ["20-daily.pgn", [4 * 3600 + 8 * 60 + 37.9, 28 * 60 + 47.2], 3600 + 24],
  ])("%s has the expected clock values", (file, [first, second], last) => {
    const plies = parsePgn(readFixture("pgn", "chesscom", file)).games[0]!.plies;
    expect(plies[0]!.clockSeconds).toBe(first);
    expect(plies[1]!.clockSeconds).toBe(second);
    expect(plies.at(-1)!.clockSeconds).toBe(last);
  });

  it("follows FIDE rules where Chess.com differs: K+N vs K+N is not insufficient material", () => {
    // Chess.com ended 10-bullet "drawn by insufficient material" with a knight each; a helpmate is
    // still possible, so under FIDE rules (chess.js) the position is not a dead draw.
    const game = parsePgn(readFixture("pgn", "chesscom", "10-bullet.pgn")).games[0]!;
    expect(game.plies.at(-1)!.fenAfter.split(" ")[0]).toBe("8/8/8/8/4n3/5N1K/5k2/8");
    expect(game.terminal).toBeNull();
    expect(game.result).toBe("1/2-1/2");
  });

  it.each([
    ["06-blitz.pgn", "checkmate"],
    ["12-blitz.pgn", "threefold_repetition"],
    ["14-blitz.pgn", "fifty_move_rule"],
    ["15-rapid.pgn", "insufficient_material"],
    ["18-rapid.pgn", "threefold_repetition"],
    ["19-rapid.pgn", "stalemate"],
  ])("%s ends in %s, matching its Termination tag", (file, kind) => {
    const game = parsePgn(readFixture("pgn", "chesscom", file)).games[0]!;
    expect(game.terminal?.kind).toBe(kind);
  });
});
