import { create } from "zustand";
import type { GameRecord } from "@/core/game/types";
import { STORAGE_WAIT_MS, getRepositories, reportStorageError, requestPersistenceOnce } from "./storage";

/**
 * Imported games. Saved in IndexedDB (Phase 2, approved change A10) and mirrored here for the UI.
 * If storage fails, games are still kept in memory for this tab and the storage banner says why.
 */
export type UnsavedState = "saving" | "failed";

interface GamesStore {
  byId: Record<string, GameRecord>;
  /** Games in memory that are NOT (yet) in storage: being saved now, or the save failed. */
  unsaved: Record<string, UnsavedState>;
  /** Most recently imported first. */
  order: string[];
  /** True once the saved games have been loaded from storage. */
  listLoaded: boolean;
  /** Ids looked up in storage and not found. */
  missing: Record<string, true>;
  /** Adds games in memory at once, then saves them; resolves when saved (or the failure is reported). Never rejects. */
  add: (records: readonly GameRecord[]) => Promise<void>;
  /** Loads one game from storage if it isn't in memory. */
  load: (id: string) => Promise<void>;
  /** Loads every saved game (for the home page list). */
  loadAll: () => Promise<void>;
}

/** How long an import waits for its save before opening the review anyway (owner decision, 2026-11-25). */
export const SAVE_WAIT_MS = STORAGE_WAIT_MS;

/** Saves in progress per game, so an earlier save finishing can't hide a later one of the same game. */
const savesInProgress = new Map<string, number>();

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

export const useGames = create<GamesStore>((set, get) => ({
  byId: {},
  unsaved: {},
  order: [],
  listLoaded: false,
  missing: {},

  add: async (records) => {
    for (const { id } of records) savesInProgress.set(id, (savesInProgress.get(id) ?? 0) + 1);
    set((state) => {
      const byId = { ...state.byId };
      const missing = { ...state.missing };
      const unsaved = { ...state.unsaved };
      for (const record of records) {
        byId[record.id] = record;
        delete missing[record.id];
        unsaved[record.id] = "saving";
      }
      const added = records.map((record) => record.id);
      return { byId, missing, unsaved, order: [...new Set([...added, ...state.order])] };
    });
    const finish = (id: string, saved: boolean) => {
      const remaining = (savesInProgress.get(id) ?? 1) - 1;
      if (remaining > 0) {
        savesInProgress.set(id, remaining); // a newer save of the same game decides
        return;
      }
      savesInProgress.delete(id);
      set((state) => ({ unsaved: saved ? without(state.unsaved, id) : { ...state.unsaved, [id]: "failed" } }));
    };
    const waiting = records.map((record) => record.id);
    try {
      const { games } = await getRepositories();
      const now = Date.now();
      for (const record of records) {
        await games.put(record, now);
        finish(record.id, true);
        waiting.shift();
      }
      // Not awaited: in Firefox persist() can show a permission prompt, which must not delay
      // callers that wait for the save (e.g. navigation after an import).
      void requestPersistenceOnce();
    } catch (error) {
      for (const id of waiting) finish(id, false);
      reportStorageError(error);
    }
  },

  load: async (id) => {
    if (get().byId[id]) return;
    try {
      const game = await (await getRepositories()).games.get(id);
      if (game) set((state) => ({ byId: { ...state.byId, [id]: game } }));
      else set((state) => ({ missing: { ...state.missing, [id]: true } }));
    } catch (error) {
      reportStorageError(error);
      set((state) => ({ missing: { ...state.missing, [id]: true } }));
    }
  },

  loadAll: async () => {
    try {
      const games = await (await getRepositories()).games.list();
      set((state) => {
        const byId = { ...state.byId };
        for (const game of games) byId[game.id] ??= game;
        // Saved games in their stored order, then anything only in memory (e.g. storage failed).
        const stored = games.map((game) => game.id);
        const memoryOnly = state.order.filter((id) => !stored.includes(id));
        return { byId, order: [...memoryOnly, ...stored], listLoaded: true };
      });
    } catch (error) {
      reportStorageError(error);
      set({ listLoaded: true });
    }
  },
}));

/**
 * Adds games and waits for the save, but at most `waitMs`: slow or stalled browser storage must not
 * block an import (storage problems never block the app). The save carries on in the background;
 * until it ends the games are "saving" in `unsaved`, and the UI says so. Never rejects.
 */
export async function addGamesWithin(records: readonly GameRecord[], waitMs: number = SAVE_WAIT_MS): Promise<"finished" | "still-saving"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"still-saving">((resolve) => {
    timer = setTimeout(() => resolve("still-saving"), waitMs);
  });
  const result = await Promise.race([
    useGames
      .getState()
      .add(records)
      .then(() => "finished" as const),
    timeout,
  ]);
  clearTimeout(timer);
  return result;
}
