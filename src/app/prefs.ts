import { create } from "zustand";
import type { PresetName } from "@/core/engine/types";

export type ThemePreference = "system" | "light" | "dark";
export type OrientationPreference = "auto" | "white" | "black";
/** "auto" = the spec D7 default for this machine; a number is a fixed engine count (1-4). */
export type WorkerCountPreference = "auto" | 1 | 2 | 3 | 4;

export interface Preferences {
  theme: ThemePreference;
  /** "auto" puts the configured user's colour at the bottom. */
  boardOrientation: OrientationPreference;
  chesscomUsername: string;
  /** Analysis preset (docs/DATA_MODELS.md §10). */
  analysisPreset: PresetName;
  /** Number of engines analysing in parallel (docs/TECHNICAL_ARCHITECTURE.md D7, user-configurable). */
  workerCount: WorkerCountPreference;
}

interface PreferencesStore extends Preferences {
  update: (patch: Partial<Preferences>) => void;
}

const STORAGE_KEY = "prefs.v1";
const DEFAULTS: Preferences = {
  theme: "system",
  boardOrientation: "auto",
  chesscomUsername: "",
  analysisPreset: "standard",
  workerCount: "auto",
};

/** Reads saved preferences; storage may be unavailable (private mode, blocked site data). */
function load(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<Preferences>;
    return {
      theme: ["system", "light", "dark"].includes(saved.theme ?? "") ? saved.theme! : DEFAULTS.theme,
      boardOrientation: ["auto", "white", "black"].includes(saved.boardOrientation ?? "")
        ? saved.boardOrientation!
        : DEFAULTS.boardOrientation,
      chesscomUsername: typeof saved.chesscomUsername === "string" ? saved.chesscomUsername : "",
      analysisPreset: ["quick", "standard", "deep"].includes(saved.analysisPreset ?? "")
        ? saved.analysisPreset!
        : DEFAULTS.analysisPreset,
      workerCount: (["auto", 1, 2, 3, 4] as unknown[]).includes(saved.workerCount) ? saved.workerCount! : DEFAULTS.workerCount,
    };
  } catch {
    return DEFAULTS;
  }
}

function save(prefs: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Preferences are a convenience; the app works without persisting them.
  }
}

export const usePreferences = create<PreferencesStore>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch);
    const { theme, boardOrientation, chesscomUsername, analysisPreset, workerCount } = get();
    save({ theme, boardOrientation, chesscomUsername, analysisPreset, workerCount });
  },
}));
