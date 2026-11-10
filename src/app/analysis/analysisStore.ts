import { create } from "zustand";
import { LITE_SINGLE_ENGINE, PRESETS, analysisId, isAnalysisComplete, settingsHash, type RawAnalysis } from "@/core/engine/analysis";
import type { PresetName } from "@/core/engine/types";
import type { GameRecord } from "@/core/game/types";
import { usePreferences } from "../prefs";
import { getRepositories, reportStorageError } from "../storage";
import { AnalysisController, type AnalysisJobState, type LockManagerLike } from "./analysisController";
import { getEnginePool, resolvePoolSize } from "./engine";

/**
 * What the debug view shows for the current game and preset:
 * - none: nothing analysed yet
 * - saved: a stored analysis loaded without running (complete or partial)
 * - pending/running/completed/incomplete/cancelled/failed: the latest run
 */
export type AnalysisViewStatus = "none" | "saved" | AnalysisJobState["status"];

export interface AnalysisView {
  gameId: string;
  preset: PresetName;
  analysisId: string;
  status: AnalysisViewStatus;
  analysis: RawAnalysis | undefined;
  reused: boolean;
  error?: string;
}

interface AnalysisStore {
  view: AnalysisView | undefined;
  /** Shows any stored analysis for this game and preset, without running the engine. */
  show: (game: GameRecord, preset: PresetName) => Promise<void>;
  /** Starts (or resumes, or reuses) analysis of the game with the preset. */
  start: (game: GameRecord, preset: PresetName) => Promise<void>;
  stop: () => Promise<void>;
}

const browserLocks = (): LockManagerLike | undefined => {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return undefined;
  return { request: (name, options, callback) => locks.request(name, options, callback) };
};

let controller: AnalysisController | undefined;
let active: { gameId: string; preset: PresetName } | undefined;

function getController(set: (view: AnalysisView) => void): AnalysisController {
  controller ??= new AnalysisController({
    searcher: () => getEnginePool(resolvePoolSize(usePreferences.getState().workerCount)),
    analyses: async () => (await getRepositories()).analyses,
    onStorageError: reportStorageError,
    locks: browserLocks(),
    onState: (state) => {
      if (!active || state.gameId !== active.gameId) return;
      set({
        gameId: state.gameId,
        preset: active.preset,
        analysisId: state.analysisId,
        status: state.status,
        analysis: state.analysis,
        reused: state.reused,
        ...(state.error ? { error: state.error } : {}),
      });
    },
  });
  return controller;
}

export const useAnalysis = create<AnalysisStore>((set, get) => ({
  view: undefined,

  show: async (game, preset) => {
    const running = get().view;
    if (running && running.gameId === game.id && (running.status === "running" || running.status === "pending")) return;
    const id = analysisId(game.id, LITE_SINGLE_ENGINE, await settingsHash(PRESETS[preset]));
    let analysis: RawAnalysis | undefined;
    try {
      analysis = await (await getRepositories()).analyses.get(id);
    } catch (error) {
      reportStorageError(error);
    }
    set({
      view: { gameId: game.id, preset, analysisId: id, status: analysis ? "saved" : "none", analysis, reused: false },
    });
  },

  start: async (game, preset) => {
    active = { gameId: game.id, preset };
    const instance = getController((view) => set({ view }));
    await instance.start(game, PRESETS[preset]);
  },

  stop: async () => {
    await controller?.cancel();
  },
}));

/** True when a saved analysis covers every position. */
export function isSavedComplete(view: AnalysisView | undefined): boolean {
  return !!view?.analysis && isAnalysisComplete(view.analysis);
}
