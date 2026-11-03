import { create } from "zustand";
import type { GameRecord } from "@/core/game/types";

/**
 * Imported games for this session. Kept in memory only until IndexedDB
 * persistence arrives in Phase 2, so a page reload clears them.
 */
interface GamesStore {
  byId: Record<string, GameRecord>;
  /** Most recently imported first. */
  order: string[];
  add: (records: readonly GameRecord[]) => void;
}

export const useGames = create<GamesStore>((set) => ({
  byId: {},
  order: [],
  add: (records) =>
    set((state) => {
      const byId = { ...state.byId };
      for (const record of records) byId[record.id] = record;
      const added = records.map((record) => record.id);
      return { byId, order: [...new Set([...added, ...state.order])] };
    }),
}));
