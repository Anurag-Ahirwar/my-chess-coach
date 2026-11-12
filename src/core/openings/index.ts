import { toEpd } from "../chess/notation";
import type { Epd, Fen } from "../chess/types";

/**
 * The opening index (docs/CHESS_ANALYSIS_METHODOLOGY.md §5.8), built from the pinned Lichess
 * `chess-openings` dataset by scripts/build-openings.mjs. Pure lookups; loading is done outside
 * core/.
 */

/** The JSON written by scripts/build-openings.mjs. */
export interface OpeningIndexJson {
  source: string;
  commit: string;
  licence: string;
  lines: number;
  positions: number;
  named: number;
  /** Book positions that are not the end of a named line. */
  book: Epd[];
  /** End positions of named lines → [ECO, name]. */
  names: Record<Epd, [string, string]>;
}

export interface OpeningIndex {
  commit: string;
  has(epd: Epd): boolean;
  name(epd: Epd): { eco: string; name: string } | undefined;
}

export function openingIndexFromJson(json: OpeningIndexJson): OpeningIndex {
  const book = new Set(json.book);
  const names = new Map(Object.entries(json.names));
  return {
    commit: json.commit,
    has: (epd) => book.has(epd) || names.has(epd),
    name: (epd) => {
      const entry = names.get(epd);
      return entry ? { eco: entry[0], name: entry[1] } : undefined;
    },
  };
}

/** An index with no positions: no move is Book and no game has an opening name. */
export const EMPTY_OPENING_INDEX: OpeningIndex = { commit: "none", has: () => false, name: () => undefined };

/**
 * The book chain (§5.8, M5): the number of leading moves whose positions after the move are all in
 * the index. Move k (1-based) is in the chain when k ≤ the returned value. Positions, not labels.
 *
 * @param fens positions 0..n
 */
export function bookChainLength(fens: readonly Fen[], index: OpeningIndex): number {
  let length = 0;
  for (let k = 1; k < fens.length; k++) {
    if (!index.has(toEpd(fens[k]!))) break;
    length = k;
  }
  return length;
}

/**
 * The opening name (§5.8): the name and ECO of the deepest position among 0..n that ends a
 * named line. Undefined if there is none; a name is never guessed.
 */
export function openingOf(fens: readonly Fen[], index: OpeningIndex): { eco: string; name: string; ply: number } | undefined {
  for (let k = fens.length - 1; k >= 0; k--) {
    const named = index.name(toEpd(fens[k]!));
    if (named) return { ...named, ply: k };
  }
  return undefined;
}
