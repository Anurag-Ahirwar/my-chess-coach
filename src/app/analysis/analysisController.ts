import { analysisId, LITE_SINGLE_ENGINE, mergeAnalyses, settingsHash, type RawAnalysis } from "@/core/engine/analysis";
import type { AnalysisSettings } from "@/core/engine/types";
import type { GameRecord } from "@/core/game/types";
import type { AnalysisRepository } from "@/infra/storage/repositories";
import { STORAGE_WAIT_MS, isSlowStorage, withinStorageWait } from "../storage";
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
  /** Sent after the run ended, when a delayed save finished: it must not replace a newer view. */
  late?: boolean;
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
  /** The limit on waiting for storage at the start and end of a run; storage carries on after it. */
  storageWaitMs?: number;
}

const SLOW_STORAGE = "Browser storage is slow: results are kept in memory and saved when it answers. Keep this tab open.";

/**
 * Runs one game analysis at a time and keeps it saved: loads any stored analysis for the same
 * game, engine and settings (reusing or resuming it), saves results as they arrive (throttled,
 * merged transactionally by the repository), and saves once more when the run ends or is
 * cancelled. A Web Lock per analysis id stops two tabs analysing the same game at once.
 *
 * Slow storage never blocks a run: after a limit it starts (or ends) in memory, and saving happens
 * whenever storage answers, even after the run. A stored result found late is never replaced.
 */
export class AnalysisController {
  private current: { id: string; controller: AbortController; done: Promise<unknown> } | undefined;
  private readonly saveIntervalMs: number;
  private readonly storageWaitMs: number;
  private readonly now: () => number;
  private runs = 0;

  constructor(private readonly deps: AnalysisControllerDeps) {
    this.saveIntervalMs = deps.saveIntervalMs ?? 250;
    this.storageWaitMs = deps.storageWaitMs ?? STORAGE_WAIT_MS;
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
    const runNumber = ++this.runs;
    let repository: AnalysisRepository | undefined;
    let existing: RawAnalysis | undefined;
    /** What storage held, when it answered only after the run had started: it wins every tie. */
    let foundLate: RawAnalysis | undefined;
    let saveProblem: string | undefined;
    const open = (async () => {
      const opened = await this.deps.analyses();
      return { opened, stored: await opened.get(base.analysisId) };
    })();
    let slowOpen = false;
    const cannotRead = (error: unknown) => {
      // Can't read what is stored: analyse in memory, and don't write over the stored copy.
      this.deps.onStorageError?.(error);
      saveProblem = "Saved analysis couldn't be read; this run is not being saved.";
    };
    try {
      const { opened, stored } = await withinStorageWait(open, this.storageWaitMs);
      repository = opened;
      existing = stored;
    } catch (error) {
      if (isSlowStorage(error)) {
        slowOpen = true;
        this.deps.onStorageError?.(error);
        saveProblem = SLOW_STORAGE;
      } else cannotRead(error);
    }

    let latest: RawAnalysis | undefined;
    const finished: { state?: AnalysisJobState } = {}; // set when the run ends; read by delayed saves
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | undefined;
    let dirty = false;
    // One save at a time; results that arrive meanwhile are saved by the next one.
    const drain = async () => {
      await Promise.resolve(); // `inFlight` is set before this continues
      while (dirty && repository && latest) {
        dirty = false;
        try {
          const snapshot = foundLate ? mergeAnalyses(latest, foundLate, this.now()) : latest;
          await repository.save(snapshot, this.now());
        } catch (error) {
          this.deps.onStorageError?.(error);
          saveProblem = "Saving failed; the analysis continues in memory.";
          repository = undefined; // stop retrying a failing store for this run
        }
      }
      inFlight = undefined; // in the same step as the check above, so no result is left behind
    };
    const save = (): Promise<void> => {
      timer = undefined;
      dirty = true;
      return (inFlight ??= drain());
    };
    /** After the run: once a delayed save has ended, shows the state again without the notice. */
    const settleLater = (pending: Promise<void>) => {
      void pending.then(() => {
        if (!finished.state || runNumber !== this.runs) return;
        const { error: _notice, ...rest } = { ...finished.state, late: true };
        const problem = saveProblem === SLOW_STORAGE ? undefined : saveProblem;
        this.emit(problem ? { ...rest, error: problem } : rest);
      });
    };
    if (slowOpen) {
      settleLater(
        open.then(
          async ({ opened, stored }) => {
            repository = opened;
            foundLate = stored;
            saveProblem = undefined;
            if (latest) await save();
          },
          (error: unknown) => cannotRead(error),
        ),
      );
    }
    /** Saves at the end of a run, without waiting for slow storage beyond the limit. */
    const finalSave = async () => {
      const saved = save();
      try {
        await withinStorageWait(saved, this.storageWaitMs);
      } catch (error) {
        this.deps.onStorageError?.(error);
        saveProblem = SLOW_STORAGE;
        settleLater(
          saved.then(() => {
            if (saveProblem === SLOW_STORAGE) saveProblem = undefined;
          }),
        );
      }
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
      await finalSave();
      return this.emit({ ...base, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }

    if (timer !== undefined) clearTimeout(timer);
    if (!result.reused) {
      latest = result.analysis;
      await finalSave();
    }
    const status: AnalysisJobStatus = result.status === "error" ? "failed" : result.status;
    const error = result.error ?? saveProblem;
    finished.state = { ...base, status, analysis: result.analysis, reused: result.reused, ...(error ? { error } : {}) };
    return this.emit(finished.state);
  }

  private emit(state: AnalysisJobState): AnalysisJobState {
    this.deps.onState(state);
    return state;
  }
}
