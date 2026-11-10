import type { Uci } from "../chess/types";

/**
 * An evaluation, always from WHITE's point of view (docs/CHESS_ANALYSIS_METHODOLOGY.md §2).
 * `mate.moves` is never 0: a checkmated side to move is a rules-based `terminal` score.
 */
export type Score =
  | { kind: "cp"; value: number }
  | { kind: "mate"; moves: number }
  | { kind: "terminal"; result: "1-0" | "0-1" | "1/2-1/2" };

/** Win / draw / loss per mille, White's point of view. */
export type Wdl = [win: number, draw: number, loss: number];

export interface EngineIdentity {
  name: "stockfish";
  version: string;
  flavour: "lite-single" | "full-single";
  /** Network file name, from the engine's EvalFile option. */
  nnue?: string;
}

export type PresetName = "quick" | "standard" | "deep";

export interface AnalysisSettings {
  preset: PresetName | "custom";
  nodes: number;
  maxDepth: number;
  multiPv: 1 | 2 | 3;
  hashMb: number;
  /** Always true: `ucinewgame` before every position (docs/TECHNICAL_ARCHITECTURE.md D9). */
  freshHashPerPosition: true;
}

export interface EngineLine {
  /** MultiPV index, 1-based. */
  rank: number;
  score: Score;
  wdl?: Wdl;
  /** Depth of the iteration this line comes from; lines of one search may differ. */
  depth: number;
  selDepth?: number;
  /** Nodes searched when this line was reported. */
  nodes: number;
  /** Principal variation, capped at MAX_PV_PLIES. */
  pv: Uci[];
}

/** Stored PVs are capped (docs/DATA_MODELS.md §5). */
export const MAX_PV_PLIES = 24;
