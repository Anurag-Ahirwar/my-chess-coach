import type { Color, Fen, Uci } from "@/core/chess/types";
import { goCommand, positionCommand } from "@/core/engine/commands";
import type { EngineLine } from "@/core/engine/types";
import { EngineError, type EngineErrorKind } from "./errors";
import type { EngineTransport, EngineTransportFactory } from "./transport";
import { SearchAccumulator, parseUciLine } from "./uciParser";

export interface EngineWorkerOptions {
  hashMb?: number;
  /** From `new Worker` to `readyok` (spec: 10 s). */
  initTimeoutMs?: number;
  /** Longest silence while preparing or searching (spec: 30 s). */
  inactivityTimeoutMs?: number;
  /** After `stop`, how long to wait for `bestmove` before killing the engine. */
  stopTimeoutMs?: number;
  /** Overall cap per search, from its node budget. Provisional until benchmarked (Stage 4). */
  searchTimeoutMs?: (nodes: number) => number;
}

/**
 * Overall cap for one search: 10 s plus the budget at 50 000 nodes/s (docs/BENCHMARKS.md).
 * Measured in Chromium on the reference machine: p50 ≈ 565 000 nodes/s, slowest search 4.8 s
 * (Deep). The cap is 13-28x the slowest measured search per preset, leaving room for much
 * slower hardware without letting a hung engine block a position for minutes.
 */
export const defaultSearchTimeoutMs = (nodes: number): number => 10_000 + Math.ceil(nodes / 50);

export interface SearchRequest {
  /** The game's start position; the engine also receives every move since (spec D9). */
  startFen: Fen;
  moves: readonly Uci[];
  /** Side to move in the analysed position, for converting scores to White's view. */
  sideToMove: Color;
  nodes: number;
  maxDepth: number;
  multiPv: number;
}

export interface SearchOutcome {
  /** Exact lines by rank, White's perspective. */
  lines: EngineLine[];
  bestMove: Uci | null;
  ponder?: Uci;
  timeMs: number;
  /** Problems that make the result untrustworthy (e.g. mate 0); the caller marks the position failed. */
  anomalies: string[];
  /** Last reported nodes per second; for benchmarks only, not stored. */
  nps?: number;
}

export interface EngineInfo {
  name?: string;
  /** Default EvalFile, i.e. the network the build embeds. */
  nnue?: string;
}

export type EngineWorkerState =
  | "new"
  | "initialising"
  | "ready"
  | "preparing"
  | "searching"
  | "stopping"
  | "failed"
  | "terminated";

type Operation =
  | { kind: "init"; resolve: (info: EngineInfo) => void; reject: (error: EngineError) => void }
  | {
      kind: "search";
      request: SearchRequest;
      resolve: (outcome: SearchOutcome) => void;
      reject: (error: EngineError) => void;
      accumulator: SearchAccumulator;
      startedAt: number;
      nps?: number;
      cancelRequested: boolean;
      detachSignal: () => void;
    };

/**
 * One engine instance and its UCI state machine (docs/TECHNICAL_ARCHITECTURE.md §6.1):
 *
 *   new → initialising (uci … uciok, setoption…, isready … readyok) → ready
 *   ready → preparing (ucinewgame, isready … readyok) → searching (position, go) → ready on bestmove
 *   searching → stopping (stop) → ready on bestmove, or failed after stopTimeoutMs
 *   any → failed on error, exit or timeout (the engine is terminated); any → terminated on quit()
 *
 * Output before the `readyok` that opens a search is discarded, so lines left over from an
 * earlier search can never be attributed to a new one. Every operation's promise settles.
 */
export class EngineWorker {
  private transport: EngineTransport | undefined;
  private stateValue: EngineWorkerState = "new";
  private operation: Operation | undefined;
  private uciOk = false;
  private multiPv = 1;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  readonly info: EngineInfo = {};
  private readonly options: Required<EngineWorkerOptions>;

  constructor(
    private readonly factory: EngineTransportFactory,
    options: EngineWorkerOptions = {},
  ) {
    this.options = {
      hashMb: options.hashMb ?? 16,
      initTimeoutMs: options.initTimeoutMs ?? 10_000,
      inactivityTimeoutMs: options.inactivityTimeoutMs ?? 30_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 2_000,
      searchTimeoutMs: options.searchTimeoutMs ?? defaultSearchTimeoutMs,
    };
  }

  get state(): EngineWorkerState {
    return this.stateValue;
  }

  /** True while a start or search promise is unsettled. */
  get hasPendingOperation(): boolean {
    return this.operation !== undefined;
  }

  start(): Promise<EngineInfo> {
    if (this.stateValue !== "new") return Promise.reject(new EngineError("busy", `Cannot start an engine in state ${this.stateValue}`));
    return new Promise<EngineInfo>((resolve, reject) => {
      this.operation = { kind: "init", resolve, reject };
      this.stateValue = "initialising";
      this.armTimer(this.options.initTimeoutMs, () => this.fail("timeout", "The engine did not finish starting in time."));
      try {
        this.transport = this.factory({
          line: (text) => this.onLine(text),
          error: (message) => this.fail("crashed", message),
          exit: () => this.fail("crashed", "The engine stopped unexpectedly."),
        });
        this.transport.send("uci");
      } catch (error) {
        this.fail("crashed", error instanceof Error ? error.message : "The engine could not be created.");
      }
    });
  }

  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchOutcome> {
    if (this.stateValue !== "ready" || this.operation) {
      return Promise.reject(new EngineError("busy", `Cannot search in state ${this.stateValue}`));
    }
    if (signal?.aborted) return Promise.reject(new EngineError("cancelled", "The search was cancelled."));
    // Validate the command before changing state, so a bad request leaves the engine ready.
    let commands: string[];
    try {
      commands = [positionCommand(request.startFen, request.moves), goCommand(request.nodes, request.maxDepth)];
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    return new Promise<SearchOutcome>((resolve, reject) => {
      const onAbort = () => this.cancel();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.operation = {
        kind: "search",
        request,
        resolve,
        reject,
        accumulator: new SearchAccumulator(),
        startedAt: Date.now(),
        cancelRequested: false,
        detachSignal: () => signal?.removeEventListener("abort", onAbort),
      };
      this.pendingCommands = commands;
      this.stateValue = "preparing";
      if (request.multiPv !== this.multiPv) {
        this.send(`setoption name MultiPV value ${request.multiPv}`);
        this.multiPv = request.multiPv;
      }
      this.send("ucinewgame");
      this.send("isready");
      this.touch();
    });
  }

  private pendingCommands: string[] = [];

  /** Stops the current search. Its promise rejects with `cancelled`. */
  private cancel(): void {
    const op = this.operation;
    if (op?.kind !== "search") return;
    if (this.stateValue === "preparing") {
      op.cancelRequested = true; // settles on the readyok that is already on its way
      return;
    }
    if (this.stateValue === "searching") {
      this.stateValue = "stopping";
      this.clearTimers();
      this.send("stop");
      this.armTimer(this.options.stopTimeoutMs, () =>
        this.fail("cancelled", "The engine did not stop in time and was restarted."),
      );
    }
  }

  /** Ends the engine. Any pending operation rejects with `quit`. Safe to call more than once. */
  quit(): Promise<void> {
    if (this.stateValue === "terminated") return Promise.resolve();
    this.clearTimers();
    this.settleWithError(new EngineError("quit", "The engine was shut down."));
    if (this.transport && this.stateValue !== "failed") {
      try {
        this.transport.send("quit");
      } catch {
        // The engine may already be gone.
      }
    }
    this.transport?.terminate();
    this.stateValue = "terminated";
    return Promise.resolve();
  }

  private onLine(text: string): void {
    switch (this.stateValue) {
      case "initialising":
        this.onInitLine(text);
        return;
      case "preparing":
        this.touch();
        if (parseUciLine(text, "w").type === "readyok") this.onSearchReady();
        // Anything else belongs to an earlier search and is dropped.
        return;
      case "searching":
        this.touch();
        this.onSearchLine(text);
        return;
      case "stopping":
        if (parseUciLine(text, "w").type === "bestmove") {
          this.clearTimers();
          this.stateValue = "ready";
          this.settleWithError(new EngineError("cancelled", "The search was cancelled."));
        }
        return;
      case "new":
      case "ready":
      case "failed":
      case "terminated":
        // Stale output (e.g. after a cancelled search, or from a dying engine) is ignored.
        return;
    }
  }

  private onInitLine(text: string): void {
    const event = parseUciLine(text, "w");
    if (event.type === "id" && event.field === "name") this.info.name = event.value;
    else if (event.type === "option" && event.name === "EvalFile" && event.default) this.info.nnue = event.default;
    else if (event.type === "uciok") {
      this.uciOk = true;
      this.send("setoption name Threads value 1");
      this.send(`setoption name Hash value ${this.options.hashMb}`);
      this.send("setoption name UCI_ShowWDL value true");
      this.send("setoption name MultiPV value 1");
      this.multiPv = 1;
      this.send("isready");
    } else if (event.type === "readyok" && this.uciOk) {
      this.clearTimers();
      this.stateValue = "ready";
      const op = this.takeOperation();
      if (op?.kind === "init") op.resolve({ ...this.info });
    }
  }

  private onSearchReady(): void {
    const op = this.operation;
    if (op?.kind !== "search") return;
    if (op.cancelRequested) {
      this.clearTimers();
      this.stateValue = "ready";
      this.settleWithError(new EngineError("cancelled", "The search was cancelled."));
      return;
    }
    this.stateValue = "searching";
    op.startedAt = Date.now();
    for (const command of this.pendingCommands) this.send(command);
    this.pendingCommands = [];
    this.armTimer(this.options.searchTimeoutMs(op.request.nodes), () =>
      this.fail("timeout", `The search did not finish within its time limit (${op.request.nodes} nodes).`),
    );
  }

  private onSearchLine(text: string): void {
    const op = this.operation;
    if (op?.kind !== "search") return;
    const event = parseUciLine(text, op.request.sideToMove);
    if (event.type === "info") {
      op.accumulator.add(event.info);
      if (event.info.nps !== undefined) op.nps = event.info.nps;
    } else if (event.type === "bestmove") {
      this.clearTimers();
      this.stateValue = "ready";
      this.takeOperation();
      op.detachSignal();
      op.resolve({
        lines: op.accumulator.result(),
        bestMove: event.move,
        timeMs: Date.now() - op.startedAt,
        anomalies: [...op.accumulator.anomalies],
        ...(event.ponder ? { ponder: event.ponder } : {}),
        ...(op.nps !== undefined ? { nps: op.nps } : {}),
      });
    }
  }

  /** Kills the engine and rejects the pending operation. */
  private fail(kind: EngineErrorKind, message: string): void {
    if (this.stateValue === "failed" || this.stateValue === "terminated") return;
    this.clearTimers();
    this.stateValue = "failed";
    this.transport?.terminate();
    this.settleWithError(new EngineError(kind, message));
  }

  private settleWithError(error: EngineError): void {
    const op = this.takeOperation();
    if (!op) return;
    if (op.kind === "search") op.detachSignal();
    op.reject(error);
  }

  private takeOperation(): Operation | undefined {
    const op = this.operation;
    this.operation = undefined;
    return op;
  }

  private send(command: string): void {
    try {
      this.transport?.send(command);
    } catch (error) {
      this.fail("crashed", error instanceof Error ? error.message : "Could not send a command to the engine.");
    }
  }

  /** Restarts the inactivity watchdog. */
  private touch(): void {
    if (this.inactivityTimer !== undefined) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(
      () => this.fail("timeout", `The engine sent nothing for ${this.options.inactivityTimeoutMs / 1000} s.`),
      this.options.inactivityTimeoutMs,
    );
  }

  private armTimer(ms: number, onTimeout: () => void): void {
    this.timers.push(setTimeout(onTimeout, ms));
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    if (this.inactivityTimer !== undefined) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = undefined;
  }
}
