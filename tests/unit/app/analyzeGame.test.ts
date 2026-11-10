import { describe, expect, it } from "vitest";
import { analyzeGame, type PositionSearcher } from "@/app/analysis/analyzeGame";
import { PRESETS, applyPositionResult, createRawAnalysis, LITE_SINGLE_ENGINE, type RawAnalysis } from "@/core/engine/analysis";
import type { EngineInfo, SearchOutcome, SearchRequest } from "@/infra/engine/engineWorker";
import { EngineError } from "@/infra/engine/errors";
import { readFixture } from "../../helpers/fixtures";
import { gameFromPgn, gameFromUci } from "../../helpers/games";

/** TEST DOUBLE for EnginePool: answers each request with a legal line, or a scripted failure. */
class FakeSearcher implements PositionSearcher {
  readonly requests: SearchRequest[] = [];
  info: EngineInfo | undefined = { name: "Stockfish 19 Lite WASM", nnue: "nn-61e7af4bb97d.nnue" };
  constructor(private readonly reply: (request: SearchRequest, index: number) => SearchOutcome | Error = defaultReply) {}

  submit(request: SearchRequest, options: { signal?: AbortSignal } = {}): Promise<SearchOutcome> {
    const index = this.requests.length;
    this.requests.push(request);
    if (options.signal?.aborted) return Promise.reject(new EngineError("cancelled", "cancelled"));
    const result = this.reply(request, index);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }
}

/** A legal reply for the standard opening positions used here: always a pawn or knight move. */
function defaultReply(request: SearchRequest): SearchOutcome {
  const move = request.sideToMove === "w" ? "b1c3" : "b8c6";
  return {
    lines: [{ rank: 1, score: { kind: "cp", value: request.moves.length }, depth: 10, nodes: 100, pv: [move] }],
    bestMove: move,
    timeMs: 3,
    anomalies: [],
  };
}

let clock = 0;
const now = () => ++clock;

describe("analyzeGame", () => {
  it("analyses every position with the full history, side to move and preset", async () => {
    const game = await gameFromUci(["e2e4", "e7e5", "g1f3"]);
    const searcher = new FakeSearcher();
    const updates: RawAnalysis[] = [];
    const run = await analyzeGame(game, PRESETS.standard, { searcher, onUpdate: (a) => updates.push(a), now });

    expect(run.status).toBe("completed");
    expect(run.reused).toBe(false);
    expect(searcher.requests.map((r) => [r.moves.join(" "), r.sideToMove])).toEqual([
      ["", "w"],
      ["e2e4", "b"],
      ["e2e4 e7e5", "w"],
      ["e2e4 e7e5 g1f3", "b"],
    ]);
    for (const request of searcher.requests) {
      expect(request).toMatchObject({ startFen: game.startFen, nodes: 600_000, maxDepth: 22, multiPv: 2 });
    }
    const { analysis } = run;
    expect(analysis.id).toMatch(new RegExp(`^${game.id.replace(/[|:]/g, "\\$&")}\\|stockfish-19\\.0\\.1-lite-single\\|[0-9a-f]{16}$`));
    expect(analysis.engine).toEqual({ ...LITE_SINGLE_ENGINE, nnue: "nn-61e7af4bb97d.nnue" });
    expect(analysis.positions.map((p) => p?.status)).toEqual(["done", "done", "done", "done"]);
    expect(analysis.completedCount).toBe(4);
    expect(analysis.completedAt).toBeDefined();
    expect(updates).toHaveLength(4);
    expect(updates.map((u) => u.completedCount)).toEqual([1, 2, 3, 4]);
  });

  it("resolves a checkmate final position by rules and never sends it to the engine", async () => {
    const game = await gameFromPgn(readFixture("pgn", "rules", "checkmate-white-wins.pgn"));
    const searcher = new FakeSearcher((request) => {
      const move = request.sideToMove === "w" ? "a2a3" : "a7a6";
      return { lines: [{ rank: 1, score: { kind: "cp", value: 0 }, depth: 5, nodes: 50, pv: [move] }], bestMove: move, timeMs: 1, anomalies: [] };
    });
    const run = await analyzeGame(game, PRESETS.quick, { searcher, now });
    expect(searcher.requests).toHaveLength(game.plies.length); // positions 0..n-1 only
    expect(searcher.requests.some((r) => r.moves.length === game.plies.length)).toBe(false);
    expect(run.analysis.positions.at(-1)).toEqual({
      positionIndex: game.plies.length,
      status: "terminal",
      terminal: { kind: "terminal", result: "1-0" },
      lines: [],
    });
    expect(run.status).toBe("completed");
  });

  it("reuses a complete analysis without any engine work", async () => {
    const game = await gameFromUci(["e2e4"]);
    const first = await analyzeGame(game, PRESETS.quick, { searcher: new FakeSearcher(), now });
    const searcher = new FakeSearcher();
    const again = await analyzeGame(game, PRESETS.quick, { searcher, existing: first.analysis, now });
    expect(again).toEqual({ analysis: first.analysis, status: "completed", reused: true });
    expect(searcher.requests).toEqual([]);
  });

  it("resumes a partial analysis, analysing only the missing and failed positions", async () => {
    const game = await gameFromUci(["e2e4", "e7e5", "g1f3"]);
    let partial = await createRawAnalysis({ gameId: game.id, positionCount: 4, engine: LITE_SINGLE_ENGINE, settings: PRESETS.quick, now: 1 });
    partial = applyPositionResult(partial, { positionIndex: 0, status: "done", lines: [{ rank: 1, score: { kind: "cp", value: 30 }, depth: 9, nodes: 9, pv: ["e2e4"] }], bestMove: "e2e4", timeMs: 1 }, 2);
    partial = applyPositionResult(partial, { positionIndex: 2, status: "failed", error: "timeout", lines: [] }, 3);

    const searcher = new FakeSearcher();
    const run = await analyzeGame(game, PRESETS.quick, { searcher, existing: partial, now });
    expect(searcher.requests.map((r) => r.moves.length)).toEqual([1, 2, 3]);
    expect(run.analysis.positions[0]).toEqual(partial.positions[0]); // kept, not recomputed
    expect(run.status).toBe("completed");
  });

  it("leaves cancelled positions empty and reports cancelled", async () => {
    const game = await gameFromUci(["e2e4", "e7e5", "g1f3"]);
    const controller = new AbortController();
    const searcher = new FakeSearcher((request, index) => {
      if (index === 1) controller.abort();
      return index >= 1 ? new EngineError("cancelled", "cancelled") : defaultReply(request);
    });
    const run = await analyzeGame(game, PRESETS.quick, { searcher, signal: controller.signal, now });
    expect(run.status).toBe("cancelled");
    expect(run.analysis.positions.map((p) => p?.status ?? null)).toEqual(["done", null, null, null]);
    expect(run.analysis.completedAt).toBeUndefined();
  });

  it("does nothing when the signal is already aborted", async () => {
    const game = await gameFromUci(["e2e4"]);
    const controller = new AbortController();
    controller.abort();
    const searcher = new FakeSearcher();
    const run = await analyzeGame(game, PRESETS.quick, { searcher, signal: controller.signal, now });
    expect(run.status).toBe("cancelled");
    expect(searcher.requests).toEqual([]);
  });

  it("marks positions failed after the pool's retry failed, and reports incomplete", async () => {
    const game = await gameFromUci(["e2e4", "e7e5"]);
    const searcher = new FakeSearcher((request, index) =>
      index === 1 ? new EngineError("crashed", "The engine stopped unexpectedly. (failed again after one retry)") : defaultReply(request),
    );
    const run = await analyzeGame(game, PRESETS.quick, { searcher, now });
    expect(run.status).toBe("incomplete");
    expect(run.analysis.positions[1]).toEqual({
      positionIndex: 1,
      status: "failed",
      error: "The engine stopped unexpectedly. (failed again after one retry)",
      lines: [],
    });
    expect(run.analysis.completedCount).toBe(2);
  });

  it("marks a position failed when the engine's result is illegal, never storing it as done", async () => {
    const game = await gameFromUci(["e2e4"]);
    const searcher = new FakeSearcher((request) =>
      request.moves.length === 1
        ? { lines: [{ rank: 1, score: { kind: "cp", value: 0 }, depth: 5, nodes: 5, pv: ["e2e4"] }], bestMove: "e2e4", timeMs: 1, anomalies: [] }
        : defaultReply(request),
    );
    const run = await analyzeGame(game, PRESETS.quick, { searcher, now });
    expect(run.analysis.positions[1]).toMatchObject({ status: "failed" });
    expect(run.status).toBe("incomplete");
  });

  it("stops with an error and marks nothing when the engine is unavailable", async () => {
    const game = await gameFromUci(["e2e4", "e7e5"]);
    const searcher = new FakeSearcher(() => new EngineError("unavailable", "The engine could not be started: WASM failed"));
    const run = await analyzeGame(game, PRESETS.quick, { searcher, now });
    expect(run).toMatchObject({ status: "error", error: "The engine could not be started: WASM failed" });
    expect(run.analysis.positions).toEqual([null, null, null]);
  });

  it("refuses results from an unexpected engine", async () => {
    const game = await gameFromUci(["e2e4"]);
    const searcher = new FakeSearcher();
    searcher.info = { name: "Some Other Engine 1.0" };
    const run = await analyzeGame(game, PRESETS.quick, { searcher, now });
    expect(run.status).toBe("error");
    expect(run.error).toContain("Unexpected engine");
    expect(run.analysis.completedCount).toBe(0);
  });

  it("rejects a stored analysis for different settings or a different game length", async () => {
    const game = await gameFromUci(["e2e4"]);
    const other = await createRawAnalysis({ gameId: game.id, positionCount: 2, engine: LITE_SINGLE_ENGINE, settings: PRESETS.deep, now: 1 });
    await expect(analyzeGame(game, PRESETS.quick, { searcher: new FakeSearcher(), existing: other })).rejects.toThrow(/does not match/);
    const wrongLength = { ...(await createRawAnalysis({ gameId: game.id, positionCount: 5, engine: LITE_SINGLE_ENGINE, settings: PRESETS.quick, now: 1 })) };
    await expect(analyzeGame(game, PRESETS.quick, { searcher: new FakeSearcher(), existing: wrongLength })).rejects.toThrow(/positions/);
  });
});
