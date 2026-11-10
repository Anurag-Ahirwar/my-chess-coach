import { Chess } from "chess.js";
import type { PositionSearcher } from "@/app/analysis/analyzeGame";
import type { EngineInfo, SearchOutcome, SearchRequest } from "@/infra/engine/engineWorker";
import { EngineError } from "@/infra/engine/errors";

/**
 * TEST DOUBLE for EnginePool. By default answers each request with the first legal move of
 * the position (as a one-move line), or with a scripted reply. While a reply is pending,
 * an abort rejects the request as `cancelled`, like the real pool.
 */
export class FakeSearcher implements PositionSearcher {
  readonly requests: SearchRequest[] = [];
  info: EngineInfo | undefined = { name: "Stockfish 19 Lite WASM", nnue: "nn-61e7af4bb97d.nnue" };

  constructor(private readonly reply: (request: SearchRequest, index: number) => SearchOutcome | Error | Promise<SearchOutcome> = legalReply) {}

  submit(request: SearchRequest, options: { signal?: AbortSignal } = {}): Promise<SearchOutcome> {
    const index = this.requests.length;
    this.requests.push(request);
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(new EngineError("cancelled", "cancelled"));
    return new Promise<SearchOutcome>((resolve, reject) => {
      const onAbort = () => reject(new EngineError("cancelled", "cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => this.reply(request, index))
        .then(
          (result) => {
            signal?.removeEventListener("abort", onAbort);
            if (result instanceof Error) reject(result);
            else resolve(result);
          },
          (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
        );
    });
  }
}

/** A legal one-move line for the requested position (first legal move by chess.js). */
export function legalReply(request: SearchRequest): SearchOutcome {
  const chess = new Chess(request.startFen);
  for (const uci of request.moves) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  const move = chess.moves({ verbose: true })[0]!.lan;
  return {
    lines: [{ rank: 1, score: { kind: "cp", value: request.moves.length }, depth: 10, nodes: 100, pv: [move] }],
    bestMove: move,
    timeMs: 1,
    anomalies: [],
  };
}

/** Resolves after `ms` with a legal reply. */
export const delayedLegalReply = (ms: number) => (request: SearchRequest) =>
  new Promise<SearchOutcome>((resolve) => setTimeout(() => resolve(legalReply(request)), ms));
