// Types for scripts/build-openings.mjs, so tests can build the index from the pinned dataset.
import type { OpeningIndexJson } from "../src/core/openings";

export interface DatasetRow {
  eco: string;
  name: string;
  pgn: string;
}

export const OPENINGS_DIR: string;
export const PINNED: { source: string; commit: string; files: Record<string, string> };
export function readDataset(dir?: string): DatasetRow[];
export function buildOpeningIndex(rows: readonly DatasetRow[]): OpeningIndexJson & { sameEndDifferentName: number };
