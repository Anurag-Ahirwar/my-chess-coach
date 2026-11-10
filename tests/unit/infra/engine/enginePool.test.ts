import { describe, expect, it } from "vitest";
import { STANDARD_START_FEN } from "@/core/chess/position";
import { EnginePool, defaultPoolSize } from "@/infra/engine/enginePool";
import { EngineError } from "@/infra/engine/errors";
import type { SearchRequest } from "@/infra/engine/engineWorker";
import type { EngineTransportFactory } from "@/infra/engine/transport";
import { FakeEngine, type FakeEngineBehaviour } from "../../../helpers/fakeEngine";

const request = (moves: string[] = []): SearchRequest => ({
  startFen: STANDARD_START_FEN,
  moves,
  sideToMove: moves.length % 2 === 0 ? "w" : "b",
  nodes: 1000,
  maxDepth: 10,
  multiPv: 1,
});

/** Creates a fresh FakeEngine per engine started, recording them all. */
function fakeFleet(behaviourFor: (index: number) => FakeEngineBehaviour = () => ({})) {
  const engines: FakeEngine[] = [];
  const factory: EngineTransportFactory = (handlers) => {
    const engine = new FakeEngine(behaviourFor(engines.length));
    engines.push(engine);
    return engine.factory(handlers);
  };
  return { engines, factory };
}

/** A go reply that echoes the searched position, so results can be matched to jobs. */
const echo: FakeEngineBehaviour["onGo"] = ({ position }) => {
  const moves = position.split(" moves ")[1]?.split(" ") ?? [];
  return [`info depth 1 score cp ${moves.length} nodes 10 pv e2e4`, "bestmove e2e4"];
};

const kindOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (e: unknown) => (e instanceof EngineError ? e.kind : String(e)),
  );

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("defaultPoolSize", () => {
  it.each([
    [undefined, 1],
    [0, 1],
    [1, 1],
    [2, 1],
    [4, 3],
    [8, 4],
    [32, 4],
  ])("hardwareConcurrency %s -> %d", (cores, size) => {
    expect(defaultPoolSize(cores)).toBe(size);
  });
});

describe("EnginePool", () => {
  it("rejects an invalid size", () => {
    expect(() => new EnginePool(fakeFleet().factory, { size: 0 })).toThrow(RangeError);
  });

  it("runs N jobs over M engines and returns every result for its own position", async () => {
    const { engines, factory } = fakeFleet(() => ({ onGo: echo }));
    const pool = new EnginePool(factory, { size: 3 });
    const jobs = Array.from({ length: 10 }, (_, i) => request(Array.from({ length: i }, () => "g1f3")));
    const outcomes = await Promise.all(jobs.map((job) => pool.submit(job)));
    outcomes.forEach((outcome, i) => {
      // White-perspective score of a position with i moves played, as echoed by the fake.
      expect(outcome.lines[0]!.score).toEqual({ kind: "cp", value: i % 2 === 0 ? i : -i });
    });
    expect(engines.length).toBeLessThanOrEqual(3);
    expect(pool.info?.name).toBe("Fake Engine");
    await pool.shutdown();
  });

  it("starts engines lazily, only as many as there are jobs", async () => {
    const { engines, factory } = fakeFleet();
    const pool = new EnginePool(factory, { size: 4 });
    await pool.submit(request());
    expect(engines).toHaveLength(1);
    await pool.shutdown();
  });

  it("serves higher priorities first, FIFO within a priority", async () => {
    const order: string[] = [];
    const { factory } = fakeFleet(() => ({
      onGo: ({ position }) => {
        order.push(position);
        return ["info depth 1 score cp 0 nodes 1 pv e2e4", "bestmove e2e4"];
      },
    }));
    const pool = new EnginePool(factory, { size: 1 });
    // The engine starts asynchronously, so all five jobs are queued before it is ready.
    const jobs = [
      pool.submit(request(["a2a3"]), { priority: "batch" }),
      pool.submit(request(["b2b3"]), { priority: "batch" }),
      pool.submit(request(["c2c3"]), { priority: "review" }),
      pool.submit(request(["d2d3"]), { priority: "interactive" }),
      pool.submit(request(["e2e3"]), { priority: "review" }),
    ];
    await Promise.all(jobs);
    expect(order.map((p) => p.split(" moves ")[1])).toEqual(["d2d3", "c2c3", "e2e3", "a2a3", "b2b3"]);
    await pool.shutdown();
  });

  it("replaces a crashed engine and retries the job once", async () => {
    const { engines, factory } = fakeFleet((index) => ({ onGo: index === 0 ? () => "crash" : echo }));
    const pool = new EnginePool(factory, { size: 1 });
    const outcome = await pool.submit(request(["e2e4"]));
    expect(outcome.bestMove).toBe("e2e4");
    expect(engines).toHaveLength(2);
    expect(engines[0]!.terminated).toBe(true);
    expect(pool.stats).toMatchObject({ engines: 1, busy: 0, queued: 0 });
    await pool.shutdown();
  });

  it("rejects the job after its single retry also fails, and stays usable", async () => {
    const { engines, factory } = fakeFleet((index) => ({ onGo: index < 2 ? () => "crash" : echo }));
    const pool = new EnginePool(factory, { size: 1 });
    expect(await kindOf(pool.submit(request()))).toBe("crashed");
    expect(engines).toHaveLength(2);
    expect((await pool.submit(request())).bestMove).toBe("e2e4");
    await pool.shutdown();
  });

  it("removes a queued job when it is cancelled", async () => {
    const { factory } = fakeFleet(() => ({ onGo: () => "hang" }));
    const pool = new EnginePool(factory, { size: 1 });
    const running = pool.submit(request());
    const controller = new AbortController();
    const queued = pool.submit(request(["e2e4"]), { signal: controller.signal });
    await flush();
    controller.abort();
    expect(await kindOf(queued)).toBe("cancelled");
    expect(pool.stats.queued).toBe(0);
    await pool.shutdown();
    expect(await kindOf(running)).toBe("quit");
  });

  it("stops a running job when it is cancelled and does not retry it", async () => {
    const { engines, factory } = fakeFleet(() => ({ onGo: ({ searchIndex }) => (searchIndex === 0 ? "hang" : echo({ position: "", go: "", searchIndex })) }));
    const pool = new EnginePool(factory, { size: 1 });
    const controller = new AbortController();
    const job = pool.submit(request(), { signal: controller.signal });
    await flush();
    controller.abort();
    expect(await kindOf(job)).toBe("cancelled");
    expect(engines[0]!.commands).toContain("stop");
    expect((await pool.submit(request())).bestMove).toBe("e2e4");
    expect(engines).toHaveLength(1);
    await pool.shutdown();
  });

  it("rejects an already-cancelled submit and submits after shutdown", async () => {
    const pool = new EnginePool(fakeFleet().factory, { size: 1 });
    const controller = new AbortController();
    controller.abort();
    expect(await kindOf(pool.submit(request(), { signal: controller.signal }))).toBe("cancelled");
    await pool.shutdown();
    expect(await kindOf(pool.submit(request()))).toBe("quit");
  });

  it("rejects queued and running jobs on shutdown, leaving nothing pending", async () => {
    const { engines, factory } = fakeFleet(() => ({ onGo: () => "hang" }));
    const pool = new EnginePool(factory, { size: 2 });
    const jobs = [pool.submit(request()), pool.submit(request()), pool.submit(request()), pool.submit(request())];
    await flush();
    await pool.shutdown();
    expect(await Promise.all(jobs.map(kindOf))).toEqual(["quit", "quit", "quit", "quit"]);
    expect(engines.every((engine) => engine.terminated)).toBe(true);
    expect(pool.stats).toEqual({ engines: 0, busy: 0, starting: 0, queued: 0 });
  });

  it("rejects waiting jobs as unavailable when no engine can start, then recovers", async () => {
    let broken = true;
    const { engines, factory } = fakeFleet(() => ({ silentInit: broken }));
    const failing: EngineTransportFactory = (handlers) => {
      const transport = factory(handlers);
      if (broken) queueMicrotask(() => handlers.error("WASM failed to load"));
      return transport;
    };
    const pool = new EnginePool(failing, { size: 2, maxConsecutiveStartFailures: 3 });
    const jobs = [pool.submit(request()), pool.submit(request())];
    expect(await Promise.all(jobs.map(kindOf))).toEqual(["unavailable", "unavailable"]);
    expect(engines.length).toBeGreaterThanOrEqual(3);
    broken = false;
    expect((await pool.submit(request())).bestMove).toBe("e2e4");
    await pool.shutdown();
  });
});
