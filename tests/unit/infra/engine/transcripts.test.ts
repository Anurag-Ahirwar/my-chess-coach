import { describe, expect, it } from "vitest";
import { GameReplay, replayUciLine } from "@/core/chess/position";
import type { Color } from "@/core/chess/types";
import { SearchAccumulator, parseUciLine } from "@/infra/engine/uciParser";
import { listFixtures, readFixture, readJsonFixture } from "../../../helpers/fixtures";

/**
 * Golden transcripts recorded from the pinned npm build (scripts/record-engine-fixtures.mjs).
 * The expected values below were read by hand from the raw files, not produced by the parser.
 */
interface FixturePosition {
  id: string;
  startFen: string;
  moves: string[];
  sideToMove: Color;
}
const { positions } = readJsonFixture<{ positions: FixturePosition[] }>("engine", "positions.json");
const positionById = new Map(positions.map((p) => [p.id, p]));

function replayTranscript(file: string) {
  const text = readFixture("engine", "transcripts", file);
  const id = /^# position-id: (\S+)$/m.exec(text)![1]!;
  const position = positionById.get(id)!;
  const accumulator = new SearchAccumulator();
  let bestMove: string | null | undefined;
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const event = parseUciLine(line, position.sideToMove);
    if (event.type === "info") accumulator.add(event.info);
    if (event.type === "bestmove") bestMove = event.move;
  }
  return { position, lines: accumulator.result(), bestMove, anomalies: accumulator.anomalies };
}

function fenOf(position: FixturePosition): string {
  const replay = new GameReplay(position.startFen);
  for (const move of position.moves) replay.playUci(move);
  return replay.fen;
}

const files = listFixtures("engine", "transcripts");

describe("golden transcripts: structure", () => {
  it("has a quick and a standard transcript for every fixture position", () => {
    expect(files).toEqual(positions.flatMap((p) => [`${p.id}.quick.uci`, `${p.id}.standard.uci`]).sort());
  });

  it.each(files)("%s: parses to exact lines whose PVs and best move are legal", (file) => {
    const { position, lines, bestMove, anomalies } = replayTranscript(file);
    const multiPv = file.endsWith(".standard.uci") ? 2 : 1;
    expect(anomalies).toEqual([]);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(multiPv);
    const fen = fenOf(position);
    for (const line of lines) {
      expect(replayUciLine(fen, line.pv).illegalAt, `${file} rank ${line.rank} PV`).toBeUndefined();
      expect(line.pv.length).toBeGreaterThan(0);
    }
    expect(bestMove).toBeTruthy();
    expect(replayUciLine(fen, [bestMove!]).illegalAt).toBeUndefined();
  });
});

describe("golden transcripts: values (White's perspective)", () => {
  it.each([
    // file, rank 1 score, rank 1 first move, best move
    ["equal-white-to-move.quick.uci", { kind: "cp", value: 24 }, "g1f3", "g1f3"],
    ["white-queen-up-white-to-move.quick.uci", { kind: "cp", value: 745 }, "d1d6", "d1d6"],
    // Black to move, Black is losing: the engine says -625 from Black's side.
    ["white-queen-up-black-to-move.quick.uci", { kind: "cp", value: 625 }, "e8e7", "e8e7"],
    ["white-mates-in-1.quick.uci", { kind: "mate", moves: 1 }, "d1d8", "d1d8"],
    ["black-mates-in-1.quick.uci", { kind: "mate", moves: -1 }, "h7h1", "h7h1"],
    ["black-gets-mated-in-1.quick.uci", { kind: "mate", moves: 1 }, "a8b8", "a8b8"],
    ["white-gets-mated-in-1.quick.uci", { kind: "mate", moves: -1 }, "a8b8", "a8b8"],
    ["forced-black.quick.uci", { kind: "mate", moves: 1 }, "h8g8", "h8g8"],
    ["forced-white.quick.uci", { kind: "mate", moves: -1 }, "h1g1", "h1g1"],
  ] as const)("%s", (file, score, firstMove, best) => {
    const { lines, bestMove } = replayTranscript(file);
    expect(lines[0]!.score).toEqual(score);
    expect(lines[0]!.pv[0]).toBe(firstMove);
    expect(bestMove).toBe(best);
  });

  it("discards the final bound line and keeps the previous exact one (Black to move)", () => {
    const { lines } = replayTranscript("white-queen-up-black-to-move.quick.uci");
    // The depth-14 line is "score cp -1068 upperbound": discarded.
    expect(lines).toEqual([
      expect.objectContaining({ rank: 1, depth: 13, selDepth: 16, nodes: 120023, score: { kind: "cp", value: 625 }, wdl: [1000, 0, 0] }),
    ]);
  });

  it("keeps each MultiPV line at its own depth when the last iteration was cut short", () => {
    const { lines } = replayTranscript("equal-white-to-move.standard.uci");
    expect(lines.map((l) => [l.rank, l.depth, l.nodes, l.score])).toEqual([
      [1, 18, 600401, { kind: "cp", value: 26 }],
      [2, 17, 476133, { kind: "cp", value: 14 }],
    ]);
  });

  it("records that the engine's bestmove can differ from the last exact top line (interrupted iteration)", () => {
    const { lines, bestMove } = replayTranscript("equal-black-to-move.quick.uci");
    expect(lines[0]).toMatchObject({ depth: 16, nodes: 72794, score: { kind: "cp", value: 30 }, wdl: [58, 936, 6] });
    expect(lines[0]!.pv[0]).toBe("e7e5");
    expect(bestMove).toBe("e7e6");
  });

  it("converts MultiPV mate scores for both sides", () => {
    expect(replayTranscript("black-mates-in-1.standard.uci").lines.map((l) => l.score)).toEqual([
      { kind: "mate", moves: -1 },
      { kind: "mate", moves: -2 },
    ]);
    expect(replayTranscript("white-mates-in-1.standard.uci").lines.map((l) => l.score)).toEqual([
      { kind: "mate", moves: 1 },
      { kind: "cp", value: 677 },
    ]);
  });

  it("shows that the move history reaches the engine: a threefold-repetition draw is seen only with history", () => {
    const withHistory = replayTranscript("repetition-with-history.quick.uci");
    const withoutHistory = replayTranscript("repetition-without-history.quick.uci");
    // Same position on the board:
    expect(fenOf(withHistory.position)).toBe(withoutHistory.position.startFen);
    // With history, Ke8 repeats the position a third time: a draw, so it's Black's best move.
    expect(withHistory.bestMove).toBe("f8e8");
    expect(withHistory.lines[0]!.score).toEqual({ kind: "cp", value: 0 });
    // Without history there is no repetition: White is winning.
    expect(withoutHistory.bestMove).toBe("f8e7");
    expect(withoutHistory.lines[0]!.score).toEqual({ kind: "cp", value: 583 });

    const standard = replayTranscript("repetition-with-history.standard.uci").lines;
    expect(standard.map((l) => [l.pv[0], l.score])).toEqual([
      ["f8e8", { kind: "cp", value: 0 }],
      ["f8e7", { kind: "mate", moves: 9 }],
    ]);
  });
});
