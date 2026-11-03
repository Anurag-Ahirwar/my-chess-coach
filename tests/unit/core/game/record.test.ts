import { describe, expect, it } from "vitest";
import { buildGameRecord, describeTimeControl, parsePlayedAt, parseTimeControl, resolveUserColor } from "@/core/game/record";
import { parsePgn } from "@/core/pgn";
import { readFixture } from "../../../helpers/fixtures";

const parse = (pgn: string) => parsePgn(pgn).games[0]!;

describe("buildGameRecord", () => {
  it("builds a Chess.com record keyed by uuid and keeps the original PGN", async () => {
    const pgn = readFixture("pgn", "chesscom", "01-blitz.pgn");
    const record = await buildGameRecord(
      parse(pgn),
      { kind: "chesscom", url: "https://www.chess.com/game/live/1", uuid: "abc-123", rules: "chess", timeClass: "blitz" },
      pgn,
    );
    expect(record.id).toBe("cc:abc-123");
    expect(record.pgn).toBe(pgn);
    expect(record.white.name).toBe(parse(pgn).headers["White"]);
    expect(record.white.rating).toBeGreaterThan(0);
    expect(record.timeControl?.kind).toBe("live");
    expect(record.playedAt).toBeTypeOf("number");
    expect(record.termination).toContain("won");
  });

  it("falls back to a URL hash for Chess.com games without a uuid", async () => {
    const record = await buildGameRecord(parse("1. e4 *"), { kind: "chesscom", url: "https://x/1", rules: "chess" });
    expect(record.id).toMatch(/^cc:[0-9a-f]{32}$/);
  });

  it("gives the same PGN game the same id regardless of tags or comments", async () => {
    const a = await buildGameRecord(parse('[Event "A"]\n\n1. e4 {hi} e5 *'), { kind: "pgn" });
    const b = await buildGameRecord(parse('[Event "B"]\n\n1. e4 e5 1-0'), { kind: "pgn" });
    const c = await buildGameRecord(parse("1. e4 e6 *"), { kind: "pgn" });
    expect(a.id).toMatch(/^pgn:[0-9a-f]{32}$/);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });

  it("stores an exported PGN for file imports and handles missing players", async () => {
    const record = await buildGameRecord(parse("1. e4 *"), { kind: "pgn", fileName: "x.pgn" });
    expect(record.pgn).toContain("1. e4 *");
    expect(record.white).toEqual({ name: "?" });
    expect(record.playedAt).toBeUndefined();
    expect(record.timeControl).toBeUndefined();
  });
});

describe("parseTimeControl / describeTimeControl", () => {
  it.each([
    ["180", { kind: "live", initialSeconds: 180, incrementSeconds: 0 }, "3 min"],
    ["180+2", { kind: "live", initialSeconds: 180, incrementSeconds: 2 }, "3 min + 2 s"],
    ["30", { kind: "live", initialSeconds: 30, incrementSeconds: 0 }, "30 s"],
    ["1/86400", { kind: "daily", secondsPerMove: 86400 }, "1 day / move"],
    ["1/604800", { kind: "daily", secondsPerMove: 604800 }, "7 days / move"],
    ["1/3600", { kind: "daily", secondsPerMove: 3600 }, "3600 s / move"],
    ["-", { kind: "unknown", raw: "-" }, "-"],
    ["", { kind: "unknown", raw: "" }, "Unknown"],
  ])("%j", (raw, parsed, text) => {
    expect(parseTimeControl(raw)).toEqual(parsed);
    expect(describeTimeControl(parseTimeControl(raw))).toBe(text);
  });
});

describe("parsePlayedAt", () => {
  it("uses UTCDate and UTCTime", () => {
    expect(parsePlayedAt({ UTCDate: "2026.10.02", UTCTime: "22:05:06" })).toBe(Date.UTC(2026, 9, 2, 22, 5, 6));
  });
  it("falls back to Date at midnight, ignoring non-UTC times", () => {
    expect(parsePlayedAt({ Date: "2026.10.02", StartTime: "10:00:00" })).toBe(Date.UTC(2026, 9, 2));
  });
  it("returns undefined for unknown or invalid dates", () => {
    expect(parsePlayedAt({ Date: "????.??.??" })).toBeUndefined();
    expect(parsePlayedAt({ Date: "2026.13.01" })).toBeUndefined();
    expect(parsePlayedAt({})).toBeUndefined();
  });
});

describe("resolveUserColor", () => {
  const game = { white: { name: "Hikaru" }, black: { name: "someone" } };
  it("matches case-insensitively", () => {
    expect(resolveUserColor(game, "hikaru")).toBe("w");
    expect(resolveUserColor(game, " SOMEONE ")).toBe("b");
  });
  it("returns undefined when there is no match or no username", () => {
    expect(resolveUserColor(game, "nobody")).toBeUndefined();
    expect(resolveUserColor(game, undefined)).toBeUndefined();
    expect(resolveUserColor(game, "")).toBeUndefined();
  });
});
