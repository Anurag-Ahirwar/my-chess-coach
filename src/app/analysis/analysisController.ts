import { analysisId, LITE_SINGLE_ENGINE, settingsHash, type RawAnalysis } from "@/core/engine/analysis";
import type { AnalysisSettings } from "@/core/engine/types";
import type { GameRecord } from "@/core/game/types";
import type { AnalysisRepository } from "@/infra/storage/repositories";
import { analyzeGame, type AnalysisRun, type PositionSearcher } from "./analyzeGame";

export type AnalysisJobStatus = "pending" | "running" | "completed" | "incomplete" | "cancelled" | "failed";

export interface AnalysisJobState {
  analysisId: string;
  gameId: string;
  settings: AnalysisSettings;
  status: AnalysisJobStatus;
  analysis?: RawAnalysis;
  /** A complete saved analysis was shown without engine work. */
  reused: boolean;
  /** Readable reason for `failed`, or a non-fatal saving problem. */
  error?: string;
}

/** The subset of the Web Locks API used here (navigator.locks). */
export interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}

export interface AnalysisControllerDeps {
  searcher: () => PositionSearcher;
  analyses: () => Promise<AnalysisRepository>;
  onState: (state: AnalysisJobState) => void;
  /** Called when saving fails; the analysis continues in memory (decision D12). */
  onStorageError?: (error: unknown) => void;
  /** At most one save per interval while running, plus one at the end (decision D12). */
  saveIntervalMs?: number;
  /** navigator.locks in browsers; without it (e.g. Node) no cross-tab lock is taken. */
  locks?: LockManagerLike | undefined;
  now?: () => number;
}

/**
 * Runs one game analysis at a time and keeps it saved: loads any stored analysis for the same
 * game, engine and settings (reusing or resuming it), saves results as they arrive (throttled,
 * merged transactionally by the repository), and saves once more when the run ends or is
 * cancelled. A Web Lock per analysis id stops two tabs analysing the same game at once.
 */
export class AnalysisController {
  private current: { id: string; controller: AbortController; done: Promise<unknown> } | undefined;
  private readonly saveIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: AnalysisControllerDeps) {
    this.saveIntervalMs = deps.saveIntervalMs ?? 250;
    this.now = deps.now ?? Date.now;
  }

  /** Starts (or restarts) analysis of a game; a run already in progress is cancelled first. */
  async start(game: GameRecord, settings: AnalysisSettings): Promise<AnalysisJobState> {
    await this.cancel();
    const id = analysisId(game.id, LITE_SINGLE_ENGINE, await settingsHash(settings));
    const controller = new AbortController();
    const base: AnalysisJobState = { analysisId: id, gameId: game.id, settings, status: "pending", reused: false };
    this.deps.onState(base);

    const run = async (): Promise<AnalysisJobState> => this.run(game, settings, base, controller.signal);
    const locks = this.deps.locks;
    const done = locks
      ? locks.request(`chess-coach:analysis:${id}`, { ifAvailable: true }, (lock) =>
          lock ? run() : Promise.resolve(this.emit({ ...base, status: "failed", error: "This game is already being analysed in another tab." })),
        )
      : run();
    this.current = { id, controller, done };
    try {
      return await done;
    } finally {
      if (this.current?.controller === controller) this.current = undefined;
    }
  }

  /** Stops the running analysis. Positions already analysed stay saved; it resumes on the next start. */
  async cancel(): Promise<void> {
    const current = this.current;
    if (!current) return;
    current.controller.abort();
    await current.done.catch(() => undefined);
  }

  private async run(game: GameRecord, settings: AnalysisSettings, base: AnalysisJobState, signal: AbortSignal): Promise<AnalysisJobState> {
    let repository: AnalysisRepository | undefined;
    let existing: RawAnalysis | undefined;
    let saveProblem: string | undefined;
    try {
      repository = await this.deps.analyses();
      existing = await repository.get(base.analysisId);
    } catch (error) {
      // Can't read what is stored: analyse in memory, and don't write over the stored copy.
      this.deps.onStorageError?.(error);
      saveProblem = "Saved analysis couldn't be read; this run is not being saved.";
      repository = undefined;
    }

    let latest: RawAnalysis | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let saving: Promise<void> = Promise.resolve();
    const save = () => {
      timer = undefined;
      const snapshot = latest;
      if (!repository || !snapshot) return saving;
      const target = repository;
      saving = saving.then(async () => {
        try {
          await target.save(snapshot, this.now());
        } catch (error) {
          this.deps.onStorageError?.(error);
          saveProblem = "Saving failed; the analysis continues in memory.";
          repository = undefined; // stop retrying a failing store for this run
        }
      });
      return saving;
    };

    this.emit({ ...base, status: "running", ...(existing ? { analysis: existing } : {}) });
    let result: AnalysisRun;
    try {
      result = await analyzeGame(game, settings, {
        searcher: this.deps.searcher(),
        ...(existing ? { existing } : {}),
        signal,
        now: this.now,
        onUpdate: (analysis) => {
          latest = analysis;
          this.emit({ ...base, status: "running", analysis, ...(saveProblem ? { error: saveProblem } : {}) });
          timer ??= setTimeout(() => void save(), this.saveIntervalMs);
        },
      });
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      await save();
      return this.emit({ ...base, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }

    if (timer !== undefined) clearTimeout(timer);
    if (!result.reused) {
      latest = result.analysis;
      await save();
    }
    const status: AnalysisJobStatus = result.status === "error" ? "failed" : result.status;
    const error = result.error ?? saveProblem;
    return this.emit({ ...base, status, analysis: result.analysis, reused: result.reused, ...(error ? { error } : {}) });
  }

  private emit(state: AnalysisJobState): AnalysisJobState {
    this.deps.onState(state);
    return state;
  }
}
