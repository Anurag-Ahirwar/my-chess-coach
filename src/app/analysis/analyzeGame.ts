import {
  LITE_SINGLE_ENGINE,
  applyPositionResult,
  createRawAnalysis,
  isAnalysisComplete,
  pendingPositions,
  settingsHash,
  analysisId,
  type RawAnalysis,
} from "@/core/engine/analysis";
import { positionJob, terminalScore } from "@/core/engine/jobs";
import type { AnalysisSettings } from "@/core/engine/types";
import { resultFromOutcome } from "@/core/engine/validate";
import type { GameRecord } from "@/core/game/types";
import type { JobPriority } from "@/infra/engine/enginePool";
import type { EngineInfo, SearchOutcome, SearchRequest } from "@/infra/engine/engineWorker";
import { EngineError } from "@/infra/engine/errors";

/** The part of EnginePool the service uses (an interface, so tests can supply a fake). */
export interface PositionSearcher {
  submit(request: SearchRequest, options: { priority?: JobPriority; signal?: AbortSignal }): Promise<SearchOutcome>;
  readonly info: EngineInfo | undefined;
}

export type AnalysisRunStatus =
  /** Every position is done or terminal. */
  | "completed"
  /** Finished, but some positions failed (they are retried on the next run). */
  | "incomplete"
  /** Stopped by the caller; unanalysed positions stay empty and resume later. */
  | "cancelled"
  /** The engine could not run at all (e.g. it failed to load); nothing was marked failed. */
  | "error";

export interface AnalysisRun {
  analysis: RawAnalysis;
  status: AnalysisRunStatus;
  /** True when a complete stored analysis was returned without any engine work. */
  reused: boolean;
  error?: string;
}

export interface AnalyzeGameOptions {
  searcher: PositionSearcher;
  /** A stored analysis for the same game, engine and settings, possibly partial (resume). */
  existing?: RawAnalysis;
  signal?: AbortSignal;
  /** Called with the new analysis after every recorded position (persistence hooks in here). */
  onUpdate?: (analysis: RawAnalysis) => void;
  now?: () => number;
}

const EXPECTED_ENGINE_NAME = /^Stockfish 19\b/;

/**
 * Analyses every position of a game (docs/TECHNICAL_ARCHITECTURE.md §6.2):
 * reuses a complete analysis, resumes a partial one, resolves the final position by rules
 * when the game ended on the board (never sent to the engine), and validates every engine
 * result before recording it. Engine evaluations are never invented: a position the engine
 * could not analyse is `failed`, or stays empty if the run was cancelled.
 */
export async function analyzeGame(game: GameRecord, settings: AnalysisSettings, options: AnalyzeGameOptions): Promise<AnalysisRun> {
  const now = options.now ?? Date.now;
  const engine = { ...LITE_SINGLE_ENGINE };
  const expectedId = analysisId(game.id, engine, await settingsHash(settings));
  if (options.existing && options.existing.id !== expectedId) {
    throw new Error(`Stored analysis ${options.existing.id} does not match ${expectedId}.`);
  }
  if (options.existing && options.existing.totalCount !== game.plies.length + 1) {
    throw new Error(`Stored analysis has ${options.existing.totalCount} positions; the game has ${game.plies.length + 1}.`);
  }

  let analysis =
    options.existing ??
    (await createRawAnalysis({ gameId: game.id, positionCount: game.plies.length + 1, engine, settings, now: now() }));
  if (isAnalysisComplete(analysis)) return { analysis, status: "completed", reused: true };

  const record = (next: RawAnalysis) => {
    analysis = next;
    options.onUpdate?.(analysis);
  };

  // The final position, if the game ended on the board, is scored by rules (methodology §3, D6).
  const finalIndex = game.plies.length;
  const terminal = terminalScore(game, finalIndex);
  if (terminal && analysis.positions[finalIndex]?.status !== "terminal") {
    record(applyPositionResult(analysis, { positionIndex: finalIndex, status: "terminal", terminal, lines: [] }, now()));
  }

  const pending = pendingPositions(analysis).filter((index) => !(terminal && index === finalIndex));
  if (pending.length === 0) return finish(analysis, false);
  if (options.signal?.aborted) return { analysis, status: "cancelled", reused: false };

  let fatal: string | undefined;
  await Promise.allSettled(
    pending.map(async (index) => {
      const job = positionJob(game, index);
      try {
        const outcome = await options.searcher.submit(
          {
            startFen: job.startFen,
            moves: job.moves,
            sideToMove: job.sideToMove,
            nodes: settings.nodes,
            maxDepth: settings.maxDepth,
            multiPv: settings.multiPv,
          },
          { priority: "review", ...(options.signal ? { signal: options.signal } : {}) },
        );
        const info = options.searcher.info;
        if (info?.name && !EXPECTED_ENGINE_NAME.test(info.name)) {
          fatal ??= `Unexpected engine "${info.name}"; expected Stockfish 19.`;
          return;
        }
        if (info?.nnue && analysis.engine.nnue === undefined) analysis = { ...analysis, engine: { ...analysis.engine, nnue: info.nnue } };
        record(applyPositionResult(analysis, resultFromOutcome(index, job.fen, settings.multiPv, outcome), now()));
      } catch (error) {
        if (error instanceof EngineError && (error.kind === "cancelled" || error.kind === "quit")) return; // stays empty
        if (error instanceof EngineError && error.kind === "unavailable") {
          fatal ??= error.message;
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        record(applyPositionResult(analysis, { positionIndex: index, status: "failed", error: message, lines: [] }, now()));
      }
    }),
  );

  if (fatal) return { analysis, status: "error", reused: false, error: fatal };
  if (options.signal?.aborted) return { analysis, status: "cancelled", reused: false };
  return finish(analysis, false);
}

function finish(analysis: RawAnalysis, reused: boolean): AnalysisRun {
  return { analysis, status: isAnalysisComplete(analysis) ? "completed" : "incomplete", reused };
}
