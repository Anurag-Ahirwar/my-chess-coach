import { describe, expect, it } from "vitest";
import { exportPgn, formatClock, parseClockComment, parsePgn, type ParsedGame } from "@/core/pgn";
import { listFixtures, readFixture } from "../../../helpers/fixtures";

describe("clock comments", () => {
  it.each([
    ["[%clk 0:03:00]", 180],
    ["[%clk 0:02:59.9]", 179.9],
    ["[%clk 1:00:00.25]", 3600.25],
    ["[%clk 72:00:00]", 259_200],
    ["text before [%clk 0:00:01] and after", 1],
    ["[%clk  0:00:05 ]", 5],
  ])("%s -> %d s", (comment, seconds) => {
    expect(parseClockComment(comment)).toBe(seconds);
  });

  it.each(["", "no clock", "[%clk 0:60:00]", "[%clk 0:00:60]", "[%clk 3:00]", "[%emt 0:00:05]"])("ignores %j", (comment) => {
    expect(parseClockComment(comment)).toBeUndefined();
  });

  it.each([
    [180, "0:03:00"],
    [179.9, "0:02:59.9"],
    [3600.25, "1:00:00.25"],
    [259_200, "72:00:00"],
    [0.1, "0:00:00.1"],
  ])("formats %d s as %s", (seconds, text) => {
    expect(formatClock(seconds)).toBe(text);
  });

  it("round-trips formatted clocks", () => {
    for (const seconds of [0, 0.1, 1.5, 59.9, 61, 179.9, 3599.999, 86_400.5]) {
      expect(parseClockComment(`[%clk ${formatClock(seconds)}]`)).toBe(seconds);
    }
  });
});

describe("exportPgn", () => {
  const parseOne = (pgn: string): ParsedGame => {
    const { games, errors } = parsePgn(pgn);
    expect(errors).toEqual([]);
    return games[0]!;
  };

  it("writes the Seven Tag Roster first, with defaults for missing tags", () => {
    const pgn = exportPgn(parseOne('[ECO "C20"]\n[White "Me"]\n\n1. e4 e5 1-0'));
    expect(pgn.split("\n").slice(0, 8)).toEqual([
      '[Event "?"]',
      '[Site "?"]',
      '[Date "????.??.??"]',
      '[Round "?"]',
      '[White "Me"]',
      '[Black "?"]',
      '[Result "1-0"]',
      '[ECO "C20"]',
    ]);
    expect(pgn.trimEnd().endsWith("1. e4 e5 1-0")).toBe(true);
  });

  it("writes SetUp and FEN for a custom start and numbers a Black first move", () => {
    const pgn = exportPgn(parseOne(readFixture("pgn", "rules", "black-to-move-start.pgn")));
    expect(pgn).toContain('[SetUp "1"]');
    expect(pgn).toContain('[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"]');
    expect(pgn).toContain("1... e5 2. Nf3 Nc6 *");
  });

  it("omits SetUp/FEN for the standard start even if the source had them", () => {
    const pgn = exportPgn(
      parseOne('[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"]\n\n1. e4 *'),
    );
    expect(pgn).not.toContain("SetUp");
    expect(pgn).not.toContain("[FEN");
  });

  it("writes clocks and repeats Black's move number after a comment", () => {
    const pgn = exportPgn(parseOne("1. e4 {[%clk 0:03:00]} 1... e5 {[%clk 0:02:59.9]} 2. Nf3 *"));
    expect(pgn).toContain("1. e4 {[%clk 0:03:00]} 1... e5 {[%clk 0:02:59.9]} 2. Nf3 *");
  });

  it("can leave clocks out", () => {
    const pgn = exportPgn(parseOne("1. e4 {[%clk 0:03:00]} e5 *"), { includeClock: false });
    expect(pgn).toContain("1. e4 e5 *");
  });

  it("escapes quotes and backslashes in tag values", () => {
    const pgn = exportPgn(parseOne('[Event "The \\"big\\" one \\\\"]\n\n1. e4 *'));
    expect(pgn).toContain('[Event "The \\"big\\" one \\\\"]');
  });

  it("wraps movetext at the requested width", () => {
    const game = parseOne(readFixture("pgn", "chesscom", "01-blitz.pgn"));
    const movetext = exportPgn(game, { maxLineWidth: 80 }).split("\n\n")[1]!;
    for (const line of movetext.trimEnd().split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });
});

describe("parse -> export -> parse round trip", () => {
  // Rules fixtures that are deliberately illegal are covered by the rules tests instead.
  const illegalRulesFixtures = ["castling-after-rook-moved.pgn", "castling-through-check.pgn", "en-passant-too-late.pgn"];
  const corpus = [
    ...listFixtures("pgn", "chesscom").map((file) => ["chesscom", file] as const),
    ...listFixtures("pgn", "rules")
      .filter((file) => !illegalRulesFixtures.includes(file))
      .map((file) => ["rules", file] as const),
    ...listFixtures("pgn", "edge-cases").map((file) => ["edge-cases", file] as const),
  ];

  it.each(corpus)("%s/%s keeps plies, start position, result and tags", (dir, file) => {
    const first = parsePgn(readFixture("pgn", dir, file)).games;
    expect(first.length).toBeGreaterThan(0);
    for (const game of first) {
      const second = parsePgn(exportPgn(game));
      expect(second.errors).toEqual([]);
      expect(second.games).toHaveLength(1);
      const again = second.games[0]!;
      expect(again.plies).toEqual(game.plies);
      expect(again.startFen).toBe(game.startFen);
      expect(again.result).toBe(game.result);
      expect(again.terminal).toEqual(game.terminal);
      for (const [name, value] of Object.entries(game.headers)) {
        if (name === "SetUp" || name === "FEN") continue;
        expect(again.headers[name]).toBe(name === "Result" ? game.result : value);
      }
    }
  });
});
