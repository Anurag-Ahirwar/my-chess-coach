// @engine: the real Stockfish 19.0.1 lite single-threaded WASM build (npm), as a Node child process.
import { afterEach, describe, expect, it } from "vitest";
import { GameReplay, STANDARD_START_FEN, replayUciLine } from "@/core/chess/position";
import { EnginePool } from "@/infra/engine/enginePool";
import { EngineError } from "@/infra/engine/errors";
import { EngineWorker, type SearchRequest } from "@/infra/engine/engineWorker";
import { nodeEngineFleet } from "./nodeTransport";

const QUICK = { nodes: 150_000, maxDepth: 18, multiPv: 1 };
const STANDARD = { nodes: 600_000, maxDepth: 22, multiPv: 2 };
/** Observed overshoot is a few hundred nodes; Stockfish checks the limit periodically. */
const NODE_OVERSHOOT = 2048;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startedEngine(fleet = nodeEngineFleet(), options = {}) {
  const engine = new EngineWorker(fleet.factory, options);
  cleanups.push(() => engine.quit());
  const info = await engine.start();
  return { engine, info, fleet };
}

const req = (moves: string[], preset = QUICK, startFen = STANDARD_START_FEN): SearchRequest => {
  const replay = new GameReplay(startFen);
  for (const move of moves) replay.playUci(move);
  return { startFen, moves, sideToMove: replay.turn, ...preset };
};

const fenAfter = (request: SearchRequest) => {
  const replay = new GameReplay(request.startFen);
  for (const move of request.moves) replay.playUci(move);
  return replay.fen;
};

async function kindOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (e: unknown) => (e instanceof EngineError ? e.kind : `other: ${String(e)}`),
  );
}

describe("@engine handshake", () => {
  it("starts the lite single-threaded build and reports its identity", async () => {
    const { engine, info } = await startedEngine();
    expect(info).toEqual({ name: "Stockfish 19 Lite WASM", nnue: "nn-61e7af4bb97d.nnue" });
    expect(engine.state).toBe("ready");
  });
});

describe("@engine search", () => {
  it("analyses a known position to its node budget with legal PVs", async () => {
    const { engine } = await startedEngine();
    const request = req(["e2e4", "e7e5"], QUICK);
    const outcome = await engine.search(request);
    const top = outcome.lines[0]!;
    expect(outcome.lines).toHaveLength(1);
    // Ended by the node budget or the depth cap, never beyond the budget (plus the engine's check interval).
    expect(top.nodes).toBeLessThanOrEqual(QUICK.nodes + NODE_OVERSHOOT);
    expect(top.depth).toBeLessThanOrEqual(QUICK.maxDepth);
    expect(top.nodes >= QUICK.nodes - 50_000 || top.depth === QUICK.maxDepth).toBe(true);
    expect(top.score.kind).toBe("cp");
    const fen = fenAfter(request);
    expect(replayUciLine(fen, top.pv).illegalAt).toBeUndefined();
    expect(replayUciLine(fen, [outcome.bestMove!]).illegalAt).toBeUndefined();
    expect(outcome.anomalies).toEqual([]);
  });

  it("returns two distinct MultiPV lines with legal PVs", async () => {
    const { engine } = await startedEngine();
    const request = req(["e2e4"], STANDARD);
    const outcome = await engine.search(request);
    expect(outcome.lines.map((l) => l.rank)).toEqual([1, 2]);
    expect(outcome.lines[0]!.pv[0]).not.toBe(outcome.lines[1]!.pv[0]);
    for (const line of outcome.lines) expect(replayUciLine(fenAfter(request), line.pv).illegalAt).toBeUndefined();
  });

  it("stops at the depth cap in a trivial position, far below the node budget", async () => {
    const { engine } = await startedEngine();
    const outcome = await engine.search(req([], { nodes: 600_000, maxDepth: 10, multiPv: 1 }, "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1"));
    expect(outcome.lines[0]).toMatchObject({ depth: 10, score: { kind: "mate", moves: 1 }, pv: ["d1d8"] });
    expect(outcome.lines[0]!.nodes).toBeLessThan(600_000);
  });
});

describe("@engine lifecycle", () => {
  it("cancels a long search with stop, then searches again", async () => {
    const { engine } = await startedEngine();
    const controller = new AbortController();
    const long = engine.search(req([], { nodes: 50_000_000, maxDepth: 60, multiPv: 1 }), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stoppedAt = Date.now();
    controller.abort();
    expect(await kindOf(long)).toBe("cancelled");
    expect(Date.now() - stoppedAt).toBeLessThan(2000);
    expect(engine.state).toBe("ready");
    expect(engine.hasPendingOperation).toBe(false);
    expect((await engine.search(req(["e2e4"]))).bestMove).toBeTruthy();
  });

  it("times out a search that exceeds its time budget and kills the engine", async () => {
    const fleet = nodeEngineFleet();
    const { engine } = await startedEngine(fleet, { searchTimeoutMs: () => 300 });
    expect(await kindOf(engine.search(req([], { nodes: 50_000_000, maxDepth: 60, multiPv: 1 })))).toBe("timeout");
    expect(engine.state).toBe("failed");
    expect(engine.hasPendingOperation).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fleet.children[0]!.exitCode !== null || fleet.children[0]!.signalCode !== null).toBe(true);
  });

  it("reports a crash when the engine process dies mid-search", async () => {
    const fleet = nodeEngineFleet();
    const { engine } = await startedEngine(fleet);
    const search = engine.search(req([], { nodes: 50_000_000, maxDepth: 60, multiPv: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    fleet.kill(0);
    expect(await kindOf(search)).toBe("crashed");
    expect(engine.state).toBe("failed");
    expect(engine.hasPendingOperation).toBe(false);
  });

  it("quits during a search: the search rejects with quit and the process exits", async () => {
    const fleet = nodeEngineFleet();
    const { engine } = await startedEngine(fleet);
    const search = engine.search(req([], { nodes: 50_000_000, maxDepth: 60, multiPv: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await engine.quit();
    expect(await kindOf(search)).toBe("quit");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const child = fleet.children[0]!;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});

describe("@engine pool", () => {
  it("respawns a killed engine and retries its job once", async () => {
    let killed = false;
    const fleet = nodeEngineFleet({
      onCommand: (command, index, f) => {
        // Kill the first engine just after its first search starts.
        if (!killed && index === 0 && command.startsWith("go ")) {
          killed = true;
          setTimeout(() => f.kill(0), 50);
        }
      },
    });
    const pool = new EnginePool(fleet.factory, { size: 1 });
    cleanups.push(() => pool.shutdown());
    const outcome = await pool.submit(req(["e2e4", "e7e5"]));
    expect(outcome.bestMove).toBeTruthy();
    expect(fleet.children).toHaveLength(2);
    expect(pool.stats).toMatchObject({ engines: 1, busy: 0, queued: 0 });
  });

  it("analyses several positions over two engines, each result belonging to its position", async () => {
    const fleet = nodeEngineFleet();
    const pool = new EnginePool(fleet.factory, { size: 2 });
    cleanups.push(() => pool.shutdown());
    const game = ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"];
    const requests = game.map((_, i) => req(game.slice(0, i + 1), { nodes: 50_000, maxDepth: 12, multiPv: 1 }));
    const outcomes = await Promise.all(requests.map((r) => pool.submit(r)));
    outcomes.forEach((outcome, i) => {
      const fen = fenAfter(requests[i]!);
      expect(replayUciLine(fen, outcome.lines[0]!.pv).illegalAt, `position ${i + 1}`).toBeUndefined();
    });
    expect(fleet.children).toHaveLength(2);
  });
});
