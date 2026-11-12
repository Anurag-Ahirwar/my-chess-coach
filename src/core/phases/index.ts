import type { Phase } from "../accuracy";
import { majorsAndMinors, pieceCounts } from "../chess/material";
import type { Fen } from "../chess/types";
import type { MethodologyConfig } from "../methodology/v1";

export interface PhaseDivision {
  /** Phase of each position 0..n. */
  phases: Phase[];
  /** First middlegame position; undefined if the game never reaches it or skips it. */
  middlegameStart?: number;
  /** First endgame position; undefined if the game never reaches it. */
  endgameStart?: number;
}

/**
 * The opening / middlegame / endgame divider (docs/CHESS_ANALYSIS_METHODOLOGY.md §7, M12),
 * from material and development, not move numbers alone.
 *
 * @param fens positions 0..n
 * @param lastBookPosition the last position of the game's book chain (methodology §5.8);
 *   undefined when the game has no Book position, so the 12-move guard counts from position 0.
 */
export function dividePhases(fens: readonly Fen[], lastBookPosition: number | undefined, config: MethodologyConfig["phases"]): PhaseDivision {
  const guard = (lastBookPosition ?? 0) + config.bookGuardMoves * 2;
  let middlegameStart: number | undefined;
  let endgameStart: number | undefined;
  fens.forEach((fen, k) => {
    const counts = pieceCounts(fen);
    const pieces = majorsAndMinors(counts);
    if (middlegameStart === undefined) {
      const sparse = counts.backRank.w < config.backRankSparse || counts.backRank.b < config.backRankSparse;
      if (pieces <= config.openingMaxPieces || sparse || k >= guard) middlegameStart = k;
    }
    if (endgameStart === undefined) {
      const thin = (["w", "b"] as const).every((c) => counts[c].q === 0 && counts[c].r <= 1 && counts[c].n + counts[c].b <= 1);
      if (pieces <= config.endgameMaxPieces || thin) endgameStart = k;
    }
  });
  // Every endgame condition implies ≤ 10 pieces, so the middlegame never starts after the endgame.
  const middle = middlegameStart !== undefined && (endgameStart === undefined || middlegameStart < endgameStart) ? middlegameStart : undefined;
  const phases = fens.map((_, k): Phase => {
    if (endgameStart !== undefined && k >= endgameStart) return "endgame";
    if (middle !== undefined && k >= middle) return "middlegame";
    return "opening";
  });
  return { phases, ...(middle !== undefined ? { middlegameStart: middle } : {}), ...(endgameStart !== undefined ? { endgameStart } : {}) };
}
