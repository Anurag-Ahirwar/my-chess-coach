import type { EngineTransportFactory, EngineTransportHandlers } from "@/infra/engine/transport";

/**
 * TEST DOUBLE. A scripted stand-in for a UCI engine, used only by unit tests of
 * EngineWorker and EnginePool. Replies are delivered asynchronously (microtasks).
 */
export interface FakeEngineBehaviour {
  idName?: string;
  evalFile?: string;
  /** Never reply to `uci`. */
  silentInit?: boolean;
  /** What to do on `go`: lines to emit (bestmove included by the script), or a failure. */
  onGo?: (context: { position: string; go: string; searchIndex: number }) => string[] | "hang" | "crash" | "exit";
  /** Don't answer `stop`. */
  ignoreStop?: boolean;
  /** Lines emitted just before each `readyok` that answers a search's `isready` (leftovers). */
  staleBeforeReady?: string[];
}

export class FakeEngine {
  readonly commands: string[] = [];
  terminated = false;
  private handlers: EngineTransportHandlers | undefined;
  private searchIndex = 0;
  private searching = false;
  private lastPosition = "";
  private initialised = false;

  constructor(public behaviour: FakeEngineBehaviour = {}) {}

  readonly factory: EngineTransportFactory = (handlers) => {
    this.handlers = handlers;
    return {
      send: (command) => {
        if (this.terminated) return;
        this.commands.push(command);
        this.respond(command);
      },
      terminate: () => {
        this.terminated = true;
      },
    };
  };

  /** Emits a line as if the engine printed it (no-op after terminate). */
  emit(...lines: string[]): void {
    queueMicrotask(() => {
      for (const line of lines) if (!this.terminated) this.handlers?.line(line);
    });
  }

  crash(message = "boom"): void {
    queueMicrotask(() => {
      if (!this.terminated) this.handlers?.error(message);
    });
  }

  exit(): void {
    queueMicrotask(() => {
      if (!this.terminated) this.handlers?.exit();
    });
  }

  private respond(command: string): void {
    const b = this.behaviour;
    if (command === "uci") {
      if (b.silentInit) return;
      this.emit(
        `id name ${b.idName ?? "Fake Engine"}`,
        "id author tests",
        `option name EvalFile type string default ${b.evalFile ?? "nn-fake.nnue"}`,
        "option name Hash type spin default 16 min 1 max 1024",
        "uciok",
      );
    } else if (command === "isready") {
      if (this.initialised && b.staleBeforeReady) this.emit(...b.staleBeforeReady);
      this.initialised = true;
      this.emit("readyok");
    } else if (command.startsWith("position")) {
      this.lastPosition = command;
    } else if (command.startsWith("go")) {
      this.searching = true;
      const reply = (b.onGo ?? defaultGo)({ position: this.lastPosition, go: command, searchIndex: this.searchIndex++ });
      if (reply === "hang") return;
      if (reply === "crash") return this.crash();
      if (reply === "exit") return this.exit();
      this.searching = !reply.some((line) => line.startsWith("bestmove"));
      this.emit(...reply);
    } else if (command === "stop") {
      if (b.ignoreStop || !this.searching) return;
      this.searching = false;
      this.emit("bestmove e2e4");
    }
  }
}

const defaultGo = () => [
  "info depth 1 seldepth 1 multipv 1 score cp 20 nodes 20 nps 1000 time 1 pv e2e4",
  "info depth 2 seldepth 3 multipv 1 score cp 25 wdl 60 900 40 nodes 100 nps 2000 time 2 pv e2e4 e7e5",
  "bestmove e2e4 ponder e7e5",
];
