import { afterEach, describe, expect, it, vi } from "vitest";
import { LITE_SINGLE_ENGINE_PATH, workerTransportFactory } from "@/infra/engine/transport";

/** TEST DOUBLE for the browser Worker constructor. */
class StubWorker {
  static instances: StubWorker[] = [];
  readonly posted: unknown[] = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  constructor(readonly url: string) {
    StubWorker.instances.push(this);
  }
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  StubWorker.instances = [];
  vi.unstubAllGlobals();
});

function setup() {
  vi.stubGlobal("Worker", StubWorker);
  const handlers = { line: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const transport = workerTransportFactory()(handlers);
  return { handlers, transport, worker: StubWorker.instances[0]! };
}

describe("workerTransportFactory", () => {
  it("loads the engine from the app's base path", () => {
    const { worker } = setup();
    expect(worker.url).toBe(`/${LITE_SINGLE_ENGINE_PATH}`);
    expect(LITE_SINGLE_ENGINE_PATH).toBe("engine/stockfish-19-lite-single.js");
  });

  it("forwards commands and delivers each output line", () => {
    const { handlers, transport, worker } = setup();
    transport.send("uci");
    expect(worker.posted).toEqual(["uci"]);
    worker.onmessage!({ data: "uciok" });
    worker.onmessage!({ data: "info depth 1\ninfo depth 2\n" });
    expect(handlers.line.mock.calls).toEqual([["uciok"], ["info depth 1"], ["info depth 2"]]);
  });

  it("ignores non-string messages such as download progress", () => {
    const { handlers, worker } = setup();
    worker.onmessage!({ data: { percent: 0.5 } });
    expect(handlers.line).not.toHaveBeenCalled();
  });

  it("reports worker errors and unreadable messages, and stops further events", () => {
    const { handlers, worker } = setup();
    const preventDefault = vi.fn();
    worker.onerror!({ message: "", preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(handlers.error).toHaveBeenCalledWith("The engine worker failed to load or crashed.");
    worker.onmessageerror!();
    expect(handlers.error).toHaveBeenCalledTimes(2);
  });

  it("terminates the worker and then ignores everything", () => {
    const { handlers, transport, worker } = setup();
    transport.terminate();
    expect(worker.terminated).toBe(true);
    transport.send("go");
    worker.onmessage!({ data: "bestmove e2e4" });
    worker.onerror!({ message: "late", preventDefault: () => undefined });
    worker.onmessageerror!();
    expect(worker.posted).toEqual([]);
    expect(handlers.line).not.toHaveBeenCalled();
    expect(handlers.error).not.toHaveBeenCalled();
  });
});
