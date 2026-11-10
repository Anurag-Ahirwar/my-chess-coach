import { create } from "zustand";
import type { GameRecord } from "@/core/game/types";
import { getRepositories, reportStorageError, requestPersistenceOnce } from "./storage";

/**
 * Imported games. Saved in IndexedDB (Phase 2, approved change A10) and mirrored here for the UI.
 * If storage fails, games are still kept in memory for this tab and the storage banner says why.
 */
interface GamesStore {
  byId: Record<string, GameRecord>;
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

export const useGames = create<GamesStore>((set, get) => ({
  byId: {},
  order: [],
  listLoaded: false,
  missing: {},

  add: async (records) => {
    set((state) => {
      const byId = { ...state.byId };
      const missing = { ...state.missing };
      for (const record of records) {
        byId[record.id] = record;
        delete missing[record.id];
      }
      const added = records.map((record) => record.id);
      return { byId, missing, order: [...new Set([...added, ...state.order])] };
    });
    try {
      const { games } = await getRepositories();
      const now = Date.now();
      for (const record of records) await games.put(record, now);
      // Not awaited: in Firefox persist() can show a permission prompt, which must not delay
      // callers that wait for the save (e.g. navigation after an import).
      void requestPersistenceOnce();
    } catch (error) {
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
