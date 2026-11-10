import { describe, expect, it } from "vitest";
import { MAX_PV_PLIES } from "@/core/engine/types";
import { SearchAccumulator, parseUciLine, type UciInfo } from "@/infra/engine/uciParser";

const info = (line: string, side: "w" | "b" = "w"): UciInfo => {
  const event = parseUciLine(line, side);
  if (event.type !== "info") throw new Error(`not info: ${JSON.stringify(event)}`);
  return event.info;
};

describe("parseUciLine: handshake and control lines", () => {
  it.each([
    ["uciok", { type: "uciok" }],
    ["readyok", { type: "readyok" }],
    ["  readyok  ", { type: "readyok" }],
    ["id name Stockfish 19 Lite WASM", { type: "id", field: "name", value: "Stockfish 19 Lite WASM" }],
    ["id author the Stockfish developers (see AUTHORS file)", { type: "id", field: "author", value: "the Stockfish developers (see AUTHORS file)" }],
  ])("%j", (line, expected) => {
    expect(parseUciLine(line, "w")).toEqual(expected);
  });

  it.each([
    ["option name EvalFile type string default nn-61e7af4bb97d.nnue", { type: "option", name: "EvalFile", default: "nn-61e7af4bb97d.nnue" }],
    ["option name Hash type spin default 16 min 1 max 33554432", { type: "option", name: "Hash", default: "16" }],
    ["option name UCI_ShowWDL type check default false", { type: "option", name: "UCI_ShowWDL", default: "false" }],
    ["option name Clear Hash type button", { type: "option", name: "Clear Hash" }],
    ["option name Style type combo default Normal var Solid var Normal", { type: "option", name: "Style", default: "Normal" }],
  ])("option %j", (line, expected) => {
    expect(parseUciLine(line, "w")).toEqual(expected);
  });

  it.each([
    ["bestmove e2e4", { type: "bestmove", move: "e2e4" }],
    ["bestmove g1f3 ponder b8c6", { type: "bestmove", move: "g1f3", ponder: "b8c6" }],
    ["bestmove e7e8q ponder a2a1n", { type: "bestmove", move: "e7e8q", ponder: "a2a1n" }],
    ["bestmove (none)", { type: "bestmove", move: null }],
    ["bestmove e2e4 ponder", { type: "bestmove", move: "e2e4" }],
  ])("bestmove %j", (line, expected) => {
    expect(parseUciLine(line, "w")).toEqual(expected);
  });

  it.each(["", "   ", "garbage", "bestmove", "bestmove z9z9", "bestmove e2e4e5", "id", "id foo bar", "option", "option name x", "\u0000\u0001", "info depth x", "info score cp", "info score foo 12", "info wdl 1 2", "info pv e2e4 nonsense"])(
    "unrecognised or garbled %j becomes unknown without throwing",
    (line) => {
      expect(parseUciLine(line, "w")).toEqual({ type: "unknown", line });
      expect(parseUciLine(line, "b")).toEqual({ type: "unknown", line });
    },
  );
});

describe("parseUciLine: info lines", () => {
  const full =
    "info depth 14 seldepth 23 multipv 1 score cp 32 wdl 62 933 5 nodes 150048 nps 590740 hashfull 50 time 254 pv g1f3 b8c6 d2d4";

  it("parses every field with White to move", () => {
    expect(info(full)).toEqual({
      depth: 14,
      selDepth: 23,
      multiPv: 1,
      score: { kind: "cp", value: 32 },
      wdl: [62, 933, 5],
      nodes: 150048,
      nps: 590740,
      timeMs: 254,
      pv: ["g1f3", "b8c6", "d2d4"],
    });
  });

  it("converts score and WDL to White's perspective with Black to move", () => {
    const parsed = info(full, "b");
    expect(parsed.score).toEqual({ kind: "cp", value: -32 });
    expect(parsed.wdl).toEqual([5, 933, 62]);
  });

  it.each([
    ["w", "mate 3", 3],
    ["w", "mate -2", -2],
    ["b", "mate 3", -3],
    ["b", "mate -2", 2],
  ] as const)("side %s, score %s -> White mate %d", (side, score, moves) => {
    expect(info(`info depth 5 score ${score} nodes 10 pv e2e4`, side).score).toEqual({ kind: "mate", moves });
  });

  it("keeps mate 0 as 0 (never -0) so the accumulator can flag it", () => {
    const score = info("info depth 0 score mate 0", "b").score;
    expect(score).toEqual({ kind: "mate", moves: 0 });
    expect(Object.is(score?.kind === "mate" ? score.moves : NaN, 0)).toBe(true);
  });

  it.each([
    ["w", "lowerbound", "lower"],
    ["w", "upperbound", "upper"],
    ["b", "lowerbound", "upper"],
    ["b", "upperbound", "lower"],
  ] as const)("side %s %s is a White %s bound", (side, bound, expected) => {
    expect(info(`info depth 9 multipv 2 score cp 11 ${bound} nodes 5 pv b1c3`, side).bound).toBe(expected);
  });

  it("accepts fields in any order and ignores hashfull, currmove, tbhits and unknown keys", () => {
    expect(
      info("info nodes 77 currmove e2e4 currmovenumber 3 tbhits 0 futurekey score cp -5 multipv 3 depth 7 time 12 pv d2d4"),
    ).toEqual({ multiPv: 3, nodes: 77, score: { kind: "cp", value: -5 }, depth: 7, timeMs: 12, pv: ["d2d4"] });
  });

  it("defaults multipv to 1", () => {
    expect(info("info depth 1 score cp 10 nodes 20 pv e2e4").multiPv).toBe(1);
  });

  it("parses info string lines", () => {
    expect(info("info string Network replica 1: Local memory.").string).toBe("Network replica 1: Local memory.");
  });

  it("parses currmove-only progress lines (no score)", () => {
    expect(info("info depth 20 currmove e2e4 currmovenumber 1")).toEqual({ multiPv: 1, depth: 20 });
  });

  it("parses promotions in the PV", () => {
    expect(info("info depth 3 score cp 900 nodes 5 pv a7a8q b8a8 h1h8").pv).toEqual(["a7a8q", "b8a8", "h1h8"]);
  });
});

describe("SearchAccumulator", () => {
  const add = (acc: SearchAccumulator, line: string, side: "w" | "b" = "w") => acc.add(info(line, side));

  it("keeps the last exact line per MultiPV index and discards bound lines", () => {
    const acc = new SearchAccumulator();
    add(acc, "info depth 13 seldepth 21 multipv 1 score cp 31 wdl 60 935 5 nodes 82737 pv g1f3 b8c6");
    add(acc, "info depth 13 seldepth 24 multipv 2 score cp 21 wdl 42 950 8 nodes 82737 pv b1c3 b8c6");
    add(acc, "info depth 14 seldepth 23 multipv 1 score cp 32 wdl 62 933 5 nodes 150048 pv g1f3 b8c6 d2d4");
    add(acc, "info depth 14 seldepth 25 multipv 2 score cp 11 upperbound wdl 28 960 12 nodes 150048 pv b1c3 b8c6");
    expect(acc.result()).toEqual([
      { rank: 1, score: { kind: "cp", value: 32 }, wdl: [62, 933, 5], depth: 14, selDepth: 23, nodes: 150048, pv: ["g1f3", "b8c6", "d2d4"] },
      { rank: 2, score: { kind: "cp", value: 21 }, wdl: [42, 950, 8], depth: 13, selDepth: 24, nodes: 82737, pv: ["b1c3", "b8c6"] },
    ]);
    expect(acc.anomalies).toEqual([]);
  });

  it("ignores lines without a score, depth or nodes, and info strings", () => {
    const acc = new SearchAccumulator();
    add(acc, "info depth 20 currmove e2e4 currmovenumber 1");
    add(acc, "info score cp 10 nodes 5 pv e2e4");
    add(acc, "info depth 3 score cp 10 pv e2e4");
    add(acc, "info string hello");
    expect(acc.result()).toEqual([]);
  });

  it("orders lines by rank regardless of arrival order", () => {
    const acc = new SearchAccumulator();
    add(acc, "info depth 2 multipv 2 score cp 1 nodes 9 pv a2a3");
    add(acc, "info depth 2 multipv 1 score cp 5 nodes 9 pv e2e4");
    expect(acc.result().map((l) => l.rank)).toEqual([1, 2]);
  });

  it(`caps stored PVs at ${MAX_PV_PLIES} plies`, () => {
    const acc = new SearchAccumulator();
    const pv = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? "g1f3" : "g8f6"));
    add(acc, `info depth 30 score cp 0 nodes 9 pv ${pv.join(" ")}`);
    expect(acc.result()[0]!.pv).toHaveLength(MAX_PV_PLIES);
  });

  it("flags mate 0 as an anomaly instead of storing it, with or without a nodes field", () => {
    const acc = new SearchAccumulator();
    add(acc, "info depth 0 score mate 0", "b"); // Stockfish's form for a mated root: no nodes
    add(acc, "info depth 1 score mate 0 nodes 1", "w");
    expect(acc.result()).toEqual([]);
    expect(acc.anomalies).toHaveLength(2);
  });

  it("stores scores in White's perspective for Black to move", () => {
    const acc = new SearchAccumulator();
    add(acc, "info depth 8 score mate 2 wdl 1000 0 0 nodes 500 pv d8d1 e1e2", "b");
    expect(acc.result()[0]).toMatchObject({ score: { kind: "mate", moves: -2 }, wdl: [0, 0, 1000] });
  });
});
