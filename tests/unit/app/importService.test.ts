import { describe, expect, it } from "vitest";
import {
  GameImportError,
  importChessComGame,
  importPgnText,
  isAnalysable,
  openingFromEcoUrl,
  summariseChessComGame,
} from "@/app/importService";
import type { ChessComGame } from "@/infra/chesscom";
import { readFixture, readJsonFixture } from "../../helpers/fixtures";

const month = readJsonFixture<{ games: ChessComGame[] }>("chesscom", "api", "month-hikaru.json");
const sample = month.games[0]!;

const withPlayers = (white: Partial<ChessComGame["white"]>, black: Partial<ChessComGame["black"]>): ChessComGame => ({
  ...sample,
  white: { ...sample.white, ...white },
  black: { ...sample.black, ...black },
});

describe("summariseChessComGame", () => {
  it("reports the outcome from the user's side, case-insensitively", () => {
    const game = withPlayers({ username: "Me", result: "checkmated" }, { username: "Them", rating: 2000, result: "win" });
    expect(summariseChessComGame(game, "me")).toMatchObject({
      userColor: "w",
      outcome: "loss",
      opponent: { username: "Them", rating: 2000 },
    });
    expect(summariseChessComGame(game, "THEM")).toMatchObject({ userColor: "b", outcome: "win" });
  });

  it.each(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"])("treats %s as a draw", (result) => {
    const game = withPlayers({ username: "me", result }, { username: "x", result });
    expect(summariseChessComGame(game, "me").outcome).toBe("draw");
  });

  it("falls back to White's point of view when the user didn't play", () => {
    const summary = summariseChessComGame(withPlayers({ username: "a", result: "win" }, { username: "b", result: "resigned" }), "me");
    expect(summary.userColor).toBeUndefined();
    expect(summary.outcome).toBe("win");
  });
});

describe("isAnalysable", () => {
  it("accepts standard chess with a PGN only", () => {
    expect(isAnalysable(sample)).toBe(true);
    expect(isAnalysable({ ...sample, rules: "chess960" })).toBe(false);
    const { pgn: _pgn, ...withoutPgn } = sample;
    expect(isAnalysable(withoutPgn)).toBe(false);
  });
});

describe("openingFromEcoUrl", () => {
  it("turns the Chess.com opening URL into a readable name", () => {
    expect(openingFromEcoUrl("https://www.chess.com/openings/Sicilian-Defense-2.Nf3-d6")).toBe("Sicilian Defense 2.Nf3 d6");
  });
  it("returns undefined for missing or malformed URLs", () => {
    expect(openingFromEcoUrl(undefined)).toBeUndefined();
    expect(openingFromEcoUrl("https://example.com/x")).toBeUndefined();
    expect(openingFromEcoUrl("https://www.chess.com/openings/%E0%A4%A")).toBeUndefined();
  });
});

describe("importChessComGame", () => {
  it("builds a record that keeps the original PGN and Chess.com metadata", async () => {
    const record = await importChessComGame(sample);
    expect(record.id).toBe(`cc:${sample.uuid}`);
    expect(record.pgn).toBe(sample.pgn);
    expect(record.source).toMatchObject({ kind: "chesscom", url: sample.url, rules: "chess", timeClass: sample.time_class });
    expect(record.plies.length).toBeGreaterThan(0);
  });

  it("refuses variants", async () => {
    await expect(importChessComGame({ ...sample, rules: "chess960" })).rejects.toBeInstanceOf(GameImportError);
  });

  it("reports an unreadable PGN with its location", async () => {
    await expect(importChessComGame({ ...sample, pgn: "1. e4 e5 2. Ke3 *" })).rejects.toThrow(/line 1, column \d+: Illegal/);
  });
});

describe("importPgnText", () => {
  it("returns records for good games and errors for bad ones", async () => {
    const { records, errors } = await importPgnText(readFixture("pgn", "edge-cases", "multi-game-with-annotations.pgn"), "x.pgn");
    expect(records).toHaveLength(3);
    expect(errors).toHaveLength(1);
    expect(records[0]!.source).toEqual({ kind: "pgn", fileName: "x.pgn" });
  });
});
