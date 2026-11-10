import { afterEach, describe, expect, it, vi } from "vitest";
import { STANDARD_START_FEN } from "@/core/chess/position";
import { EngineError } from "@/infra/engine/errors";
import { EngineWorker, type SearchRequest } from "@/infra/engine/engineWorker";
import { FakeEngine } from "../../../helpers/fakeEngine";

const request = (overrides: Partial<SearchRequest> = {}): SearchRequest => ({
  startFen: STANDARD_START_FEN,
  moves: ["e2e4"],
  sideToMove: "b",
  nodes: 1000,
  maxDepth: 10,
  multiPv: 1,
  ...overrides,
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function started(fake = new FakeEngine(), options = {}) {
  const worker = new EngineWorker(fake.factory, options);
  await worker.start();
  fake.commands.length = 0;
  return { worker, fake };
}

async function expectRejection(promise: Promise<unknown>, kind: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(EngineError);
  expect((error as EngineError).kind).toBe(kind);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EngineWorker: initialisation", () => {
  it("performs the UCI handshake and sets the spec's options", async () => {
    const fake = new FakeEngine({ idName: "Stockfish 19 Lite WASM", evalFile: "nn-61e7af4bb97d.nnue" });
    const worker = new EngineWorker(fake.factory, { hashMb: 16 });
    const info = await worker.start();
    expect(info).toEqual({ name: "Stockfish 19 Lite WASM", nnue: "nn-61e7af4bb97d.nnue" });
    expect(fake.commands).toEqual([
      "uci",
      "setoption name Threads value 1",
      "setoption name Hash value 16",
      "setoption name UCI_ShowWDL value true",
      "setoption name MultiPV value 1",
      "isready",
    ]);
    expect(worker.state).toBe("ready");
    expect(worker.hasPendingOperation).toBe(false);
  });

  it("times out if the engine never answers", async () => {
    vi.useFakeTimers();
    const fake = new FakeEngine({ silentInit: true });
    const worker = new EngineWorker(fake.factory, { initTimeoutMs: 10_000 });
    const rejected = expectRejection(worker.start(), "timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(worker.state).toBe("failed");
    expect(fake.terminated).toBe(true);
    expect(worker.hasPendingOperation).toBe(false);
  });

  it("fails as crashed when the engine errors or exits during start", async () => {
    for (const how of ["crash", "exit"] as const) {
      const fake = new FakeEngine({ silentInit: true });
      const worker = new EngineWorker(fake.factory);
      const start = worker.start();
      fake[how]();
      await expectRejection(start, "crashed");
      expect(worker.state).toBe("failed");
      expect(worker.hasPendingOperation).toBe(false);
    }
  });

  it("fails as crashed when the transport cannot be created", async () => {
    const worker = new EngineWorker(() => {
      throw new Error("Worker blocked");
    });
    await expectRejection(worker.start(), "crashed");
    expect(worker.state).toBe("failed");
  });

  it("refuses to start twice or search before starting", async () => {
    const fake = new FakeEngine();
    const worker = new EngineWorker(fake.factory);
    await expectRejection(worker.search(request()), "busy");
    await worker.start();
    await expectRejection(worker.start(), "busy");
  });
});

describe("EngineWorker: search", () => {
  it("sends ucinewgame and isready, then position with the full history and a node-limited go", async () => {
    const { worker, fake } = await started();
    await worker.search(request({ moves: ["e2e4", "e7e5", "g1f3"], sideToMove: "b", nodes: 150_000, maxDepth: 18 }));
    expect(fake.commands).toEqual([
      "ucinewgame",
      "isready",
      "position startpos moves e2e4 e7e5 g1f3",
      "go nodes 150000 depth 18",
    ]);
  });

  it("returns White-perspective lines, best move, ponder and nps", async () => {
    const { worker } = await started();
    const outcome = await worker.search(request({ sideToMove: "b" }));
    expect(outcome.bestMove).toBe("e2e4");
    expect(outcome.ponder).toBe("e7e5");
    expect(outcome.nps).toBe(2000);
    expect(outcome.lines).toEqual([
      { rank: 1, score: { kind: "cp", value: -25 }, wdl: [40, 900, 60], depth: 2, selDepth: 3, nodes: 100, pv: ["e2e4", "e7e5"] },
    ]);
    expect(outcome.anomalies).toEqual([]);
    expect(worker.state).toBe("ready");
    expect(worker.hasPendingOperation).toBe(false);
  });

  it("only changes MultiPV when the request differs from the current value", async () => {
    const { worker, fake } = await started();
    await worker.search(request({ multiPv: 2 }));
    await worker.search(request({ multiPv: 2 }));
    await worker.search(request({ multiPv: 1 }));
    expect(fake.commands.filter((c) => c.startsWith("setoption name MultiPV"))).toEqual([
      "setoption name MultiPV value 2",
      "setoption name MultiPV value 1",
    ]);
  });

  it("drops output that arrives before the search's readyok (stale results)", async () => {
    const fake = new FakeEngine({
      staleBeforeReady: ["info depth 30 multipv 1 score mate 1 nodes 999 pv h5f7", "bestmove h5f7"],
    });
    const { worker } = await started(fake);
    const outcome = await worker.search(request({ sideToMove: "w" }));
    expect(outcome.bestMove).toBe("e2e4");
    expect(outcome.lines[0]!.score).toEqual({ kind: "cp", value: 25 });
  });

  it("ignores output while idle", async () => {
    const { worker, fake } = await started();
    fake.emit("bestmove a2a3", "info depth 5 score cp 1 nodes 5 pv a2a3");
    await flush();
    expect(worker.state).toBe("ready");
    expect((await worker.search(request())).bestMove).toBe("e2e4");
  });

  it("passes anomalies such as mate 0 to the caller", async () => {
    const fake = new FakeEngine({ onGo: () => ["info depth 0 score mate 0", "bestmove (none)"] });
    const { worker } = await started(fake);
    const outcome = await worker.search(request());
    expect(outcome.bestMove).toBeNull();
    expect(outcome.lines).toEqual([]);
    expect(outcome.anomalies).toHaveLength(1);
  });

  it("rejects an invalid request and stays ready", async () => {
    const { worker, fake } = await started();
    await expect(worker.search(request({ nodes: 0 }))).rejects.toThrow(RangeError);
    expect(worker.state).toBe("ready");
    expect(fake.commands).toEqual([]);
  });

  it("refuses a second search while one is running", async () => {
    const fake = new FakeEngine({ onGo: () => "hang" });
    const { worker } = await started(fake);
    const first = worker.search(request());
    await expectRejection(worker.search(request()), "busy");
    await worker.quit();
    await expectRejection(first, "quit");
  });
});

describe("EngineWorker: cancel", () => {
  it("sends stop, waits for bestmove, rejects as cancelled and stays usable", async () => {
    const fake = new FakeEngine({ onGo: ({ searchIndex }) => (searchIndex === 0 ? "hang" : ["info depth 1 score cp 3 nodes 9 pv d2d4", "bestmove d2d4"]) });
    const { worker } = await started(fake);
    const controller = new AbortController();
    const search = worker.search(request(), controller.signal);
    await flush();
    expect(worker.state).toBe("searching");
    controller.abort();
    expect(fake.commands.at(-1)).toBe("stop");
    await expectRejection(search, "cancelled");
    expect(worker.state).toBe("ready");
    expect(worker.hasPendingOperation).toBe(false);
    expect((await worker.search(request())).bestMove).toBe("d2d4");
  });

  it("cancels before go is sent when aborted while preparing", async () => {
    const { worker, fake } = await started();
    const controller = new AbortController();
    const search = worker.search(request(), controller.signal);
    controller.abort();
    await expectRejection(search, "cancelled");
    expect(fake.commands).toEqual(["ucinewgame", "isready"]);
    expect(worker.state).toBe("ready");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { worker, fake } = await started();
    const controller = new AbortController();
    controller.abort();
    await expectRejection(worker.search(request(), controller.signal), "cancelled");
    expect(fake.commands).toEqual([]);
  });

  it("kills the engine if it ignores stop", async () => {
    vi.useFakeTimers();
    const fake = new FakeEngine({ onGo: () => "hang", ignoreStop: true });
    const { worker } = await started(fake, { stopTimeoutMs: 2000 });
    const controller = new AbortController();
    const rejected = expectRejection(worker.search(request(), controller.signal), "cancelled");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(worker.state).toBe("failed");
    expect(fake.terminated).toBe(true);
    expect(worker.hasPendingOperation).toBe(false);
  });
});

describe("EngineWorker: failures", () => {
  it("times out a search that exceeds its node-based budget", async () => {
    vi.useFakeTimers();
    const fake = new FakeEngine({ onGo: () => "hang" });
    const { worker } = await started(fake, { searchTimeoutMs: () => 5000, inactivityTimeoutMs: 60_000 });
    const rejected = expectRejection(worker.search(request()), "timeout");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(worker.state).toBe("failed");
    expect(fake.terminated).toBe(true);
  });

  it("times out when the engine goes silent", async () => {
    vi.useFakeTimers();
    const fake = new FakeEngine({ onGo: () => "hang" });
    const { worker } = await started(fake, { searchTimeoutMs: () => 600_000, inactivityTimeoutMs: 30_000 });
    const rejected = expectRejection(worker.search(request()), "timeout");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });

  it("keeps a search alive while the engine keeps reporting", async () => {
    vi.useFakeTimers();
    const fake = new FakeEngine({ onGo: () => "hang" });
    const { worker } = await started(fake, { searchTimeoutMs: () => 600_000, inactivityTimeoutMs: 30_000 });
    const search = worker.search(request());
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      fake.emit(`info depth ${i + 1} score cp 1 nodes ${i + 1} pv e2e4`);
    }
    fake.emit("bestmove e2e4");
    await vi.advanceTimersByTimeAsync(0);
    expect((await search).bestMove).toBe("e2e4");
  });

  it.each(["crash", "exit"] as const)("rejects as crashed when the engine %ses mid-search", async (how) => {
    const fake = new FakeEngine({ onGo: () => how });
    const { worker } = await started(fake);
    await expectRejection(worker.search(request()), "crashed");
    expect(worker.state).toBe("failed");
    expect(fake.terminated).toBe(true);
    expect(worker.hasPendingOperation).toBe(false);
    await expectRejection(worker.search(request()), "busy");
  });
});

describe("EngineWorker: quit", () => {
  it("rejects a running search with quit, sends quit and terminates", async () => {
    const fake = new FakeEngine({ onGo: () => "hang" });
    const { worker } = await started(fake);
    const search = worker.search(request());
    await flush();
    await worker.quit();
    await expectRejection(search, "quit");
    expect(fake.commands.at(-1)).toBe("quit");
    expect(fake.terminated).toBe(true);
    expect(worker.state).toBe("terminated");
    expect(worker.hasPendingOperation).toBe(false);
  });

  it("rejects a pending start with quit", async () => {
    const fake = new FakeEngine({ silentInit: true });
    const worker = new EngineWorker(fake.factory);
    const start = worker.start();
    await worker.quit();
    await expectRejection(start, "quit");
  });

  it("is idempotent and works on a failed engine", async () => {
    const fake = new FakeEngine({ onGo: () => "crash" });
    const { worker } = await started(fake);
    await worker.search(request()).catch(() => undefined);
    await worker.quit();
    await worker.quit();
    expect(worker.state).toBe("terminated");
  });
});
