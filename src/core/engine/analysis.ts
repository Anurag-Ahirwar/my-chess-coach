import type { Uci } from "../chess/types";
import type { AnalysisSettings, EngineIdentity, EngineLine, PresetName, Score } from "./types";

/**
 * Raw analysis model (docs/DATA_MODELS.md §5, decisions D3, D4, D16). Raw engine output only:
 * no labels, Win% or accuracy are ever stored here.
 */

export type TerminalScore = Extract<Score, { kind: "terminal" }>;

export type PositionResult =
  | {
      positionIndex: number;
      status: "done";
      /** Last exact line per MultiPV index, White's perspective (D16). */
      lines: EngineLine[];
      /** The engine's bestmove exactly as reported; may differ from lines[0].pv[0] (D16). */
      bestMove: Uci;
      timeMs: number;
    }
  | { positionIndex: number; status: "terminal"; terminal: TerminalScore; lines: [] }
  | { positionIndex: number; status: "failed"; error: string; lines: [] };

export interface RawAnalysis {
  /** `${gameId}|${engineKey}|${settingsHash}` */
  id: string;
  schemaVersion: 1;
  gameId: string;
  engine: EngineIdentity;
  settings: AnalysisSettings;
  settingsHash: string;
  /** One entry per position 0..n; null until analysed (decision D3: dense, never sparse). */
  positions: (PositionResult | null)[];
  /** Positions with status done or terminal. Failed positions keep an analysis incomplete (D3). */
  completedCount: number;
  totalCount: number;
  startedAt: number;
  /** Set when every position is done or terminal. */
  completedAt?: number;
}

/** The engine this app ships (docs/TECHNICAL_ARCHITECTURE.md D6). nnue is filled in from the engine's report. */
export const LITE_SINGLE_ENGINE: Readonly<EngineIdentity> = { name: "stockfish", version: "19.0.1", flavour: "lite-single" };

/**
 * Presets (docs/TECHNICAL_ARCHITECTURE.md D8). Provisional values until the Stage 4 benchmark.
 * Changing a value changes the settings hash, so older analyses are kept, not overwritten.
 */
export const PRESETS: Readonly<Record<PresetName, AnalysisSettings>> = {
  quick: { preset: "quick", nodes: 150_000, maxDepth: 18, multiPv: 1, hashMb: 16, freshHashPerPosition: true },
  standard: { preset: "standard", nodes: 600_000, maxDepth: 22, multiPv: 2, hashMb: 16, freshHashPerPosition: true },
  deep: { preset: "deep", nodes: 2_500_000, maxDepth: 30, multiPv: 2, hashMb: 16, freshHashPerPosition: true },
};

/** "stockfish-19.0.1-lite-single". The network is implied by version + flavour. */
export function engineKey(engine: EngineIdentity): string {
  return `${engine.name}-${engine.version}-${engine.flavour}`;
}

/** JSON with object keys sorted, so equal settings always serialise identically. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** First 16 hex characters of SHA-256 over the canonical settings JSON (decision D3: settings only). */
export async function settingsHash(settings: AnalysisSettings): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(settings)));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function analysisId(gameId: string, engine: EngineIdentity, hash: string): string {
  return `${gameId}|${engineKey(engine)}|${hash}`;
}

export async function createRawAnalysis(params: {
  gameId: string;
  positionCount: number;
  engine: EngineIdentity;
  settings: AnalysisSettings;
  now: number;
}): Promise<RawAnalysis> {
  const hash = await settingsHash(params.settings);
  return {
    id: analysisId(params.gameId, params.engine, hash),
    schemaVersion: 1,
    gameId: params.gameId,
    engine: { ...params.engine },
    settings: { ...params.settings },
    settingsHash: hash,
    positions: Array.from({ length: params.positionCount }, () => null),
    completedCount: 0,
    totalCount: params.positionCount,
    startedAt: params.now,
  };
}

const isComplete = (result: PositionResult | null) => result?.status === "done" || result?.status === "terminal";

/** Returns a new analysis with one position's result recorded (pure; the input is not changed). */
export function applyPositionResult(analysis: RawAnalysis, result: PositionResult, now: number): RawAnalysis {
  const index = result.positionIndex;
  if (!Number.isInteger(index) || index < 0 || index >= analysis.totalCount) {
    throw new RangeError(`Position ${index} is outside 0..${analysis.totalCount - 1}`);
  }
  const positions = analysis.positions.slice();
  positions[index] = result;
  const completedCount = positions.filter(isComplete).length;
  const next: RawAnalysis = { ...analysis, positions, completedCount };
  if (completedCount === analysis.totalCount) next.completedAt = analysis.completedAt ?? now;
  else delete next.completedAt;
  return next;
}

export function isAnalysisComplete(analysis: RawAnalysis): boolean {
  return analysis.completedCount === analysis.totalCount && analysis.completedAt !== undefined;
}

/** Positions that still need the engine: never analysed, or failed on an earlier run. */
export function pendingPositions(analysis: RawAnalysis): number[] {
  const pending: number[] = [];
  analysis.positions.forEach((result, index) => {
    if (result === null || result.status === "failed") pending.push(index);
  });
  return pending;
}
