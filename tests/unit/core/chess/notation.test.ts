import { describe, expect, it } from "vitest";
import {
  fenMoveInfo,
  isSquare,
  moveNumberLabel,
  normaliseSanToken,
  parseUci,
  toEpd,
  toUci,
} from "@/core/chess/notation";

describe("parseUci", () => {
  it.each([
    ["e2e4", { from: "e2", to: "e4" }],
    ["e1g1", { from: "e1", to: "g1" }],
    ["e7e8q", { from: "e7", to: "e8", promotion: "q" }],
    ["a2a1n", { from: "a2", to: "a1", promotion: "n" }],
  ])("parses %s", (uci, expected) => {
    expect(parseUci(uci)).toEqual(expected);
  });

  it.each(["", "e2", "e2e9", "i2i4", "e2e4k", "e2e4qq", "e2e2", "E2E4"])("rejects %j", (uci) => {
    expect(parseUci(uci)).toBeNull();
  });

  it("round-trips through toUci", () => {
    for (const uci of ["e2e4", "e7e8q", "h7h8r", "b2b1b"]) {
      const parts = parseUci(uci);
      expect(parts).not.toBeNull();
      expect(toUci(parts!)).toBe(uci);
    }
  });
});

describe("isSquare", () => {
  it("accepts a1..h8 only", () => {
    expect(isSquare("a1")).toBe(true);
    expect(isSquare("h8")).toBe(true);
    expect(isSquare("i1")).toBe(false);
    expect(isSquare("a9")).toBe(false);
    expect(isSquare("a10")).toBe(false);
  });
});

describe("toEpd", () => {
  it("keeps placement, side, castling and en passant", () => {
    expect(toEpd("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1")).toBe(
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3",
    );
  });
});

describe("fenMoveInfo", () => {
  it("reads full-move number and side to move", () => {
    expect(fenMoveInfo("8/8/8/8/8/8/8/K6k b - - 3 41")).toEqual({ turn: "b", fullmove: 41 });
  });
  it("defaults missing or invalid counters to move 1", () => {
    expect(fenMoveInfo("8/8/8/8/8/8/8/K6k w - -")).toEqual({ turn: "w", fullmove: 1 });
    expect(fenMoveInfo("8/8/8/8/8/8/8/K6k w - - 0 0")).toEqual({ turn: "w", fullmove: 1 });
  });
});

describe("normaliseSanToken", () => {
  it.each([
    ["e4!", "e4"],
    ["Nf3?!", "Nf3"],
    ["Qxf7#!!", "Qxf7#"],
    ["0-0", "O-O"],
    ["0-0-0", "O-O-O"],
    ["0-0+", "O-O+"],
    ["O-O-O#", "O-O-O#"],
    ["exd8=Q+", "exd8=Q+"],
  ])("%s -> %s", (input, expected) => {
    expect(normaliseSanToken(input)).toBe(expected);
  });
});

describe("moveNumberLabel", () => {
  it("formats White and Black move numbers", () => {
    expect(moveNumberLabel(12, "w")).toBe("12.");
    expect(moveNumberLabel(12, "b")).toBe("12...");
  });
});
