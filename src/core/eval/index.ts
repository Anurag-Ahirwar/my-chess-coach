import type { Color } from "../chess/types";
import type { Score } from "../engine/types";
import { LICHESS_ACCURACY_V1 } from "../methodology/v1";

/**
 * Scores, perspective and Win% (docs/CHESS_ANALYSIS_METHODOLOGY.md §2–§4).
 * Stored scores are always White's perspective; this module is the single place that turns
 * them into a player's perspective.
 */

/** A score from one player's point of view: positive is good for that player. */
export type PovScore =
  | { kind: "cp"; value: number }
  | { kind: "mate"; moves: number }
  | { kind: "terminal"; outcome: "win" | "loss" | "draw" };

function assertValid(score: Score): void {
  if (score.kind === "cp" && !Number.isFinite(score.value)) throw new RangeError(`Invalid centipawn score ${score.value}`);
  if (score.kind === "mate" && (!Number.isInteger(score.moves) || score.moves === 0)) {
    throw new RangeError(`Invalid mate score ${score.moves}: mate 0 is never a score (methodology §2.1)`);
  }
}

/** methodology §2.2: `povScore(score, color) = color === "w" ? score : negate(score)`. */
export function povScore(score: Score, color: Color): PovScore {
  assertValid(score);
  const sign = color === "w" ? 1 : -1;
  switch (score.kind) {
    case "cp":
      return { kind: "cp", value: sign * score.value + 0 }; // + 0 turns -0 into 0
    case "mate":
      return { kind: "mate", moves: sign * score.moves };
    case "terminal": {
      if (score.result === "1/2-1/2") return { kind: "terminal", outcome: "draw" };
      const whiteWon = score.result === "1-0";
      return { kind: "terminal", outcome: whiteWon === (color === "w") ? "win" : "loss" };
    }
  }
}

const clampCp = (cp: number) => Math.max(-LICHESS_ACCURACY_V1.cpCeiling, Math.min(LICHESS_ACCURACY_V1.cpCeiling, cp));

/**
 * The "ceiled" centipawn value used for Win% and ACPL (methodology §4.1, §6.6): cp clamped to
 * ±1000, a mate for the player +1000, against −1000, a terminal win +1000, loss −1000, draw 0.
 */
export function povCp(score: PovScore): number {
  switch (score.kind) {
    case "cp":
      return clampCp(score.value);
    case "mate":
      return score.moves > 0 ? LICHESS_ACCURACY_V1.cpCeiling : -LICHESS_ACCURACY_V1.cpCeiling;
    case "terminal":
      return score.outcome === "win" ? LICHESS_ACCURACY_V1.cpCeiling : score.outcome === "loss" ? -LICHESS_ACCURACY_V1.cpCeiling : 0;
  }
}

/** White-perspective ceiled centipawns. */
export function whiteCp(score: Score): number {
  return povCp(povScore(score, "w"));
}

/** methodology §4.1: Win% = 100 / (1 + e^(−0.00368208 · cp)), cp clamped to ±1000. */
export function winPercentFromCp(cp: number): number {
  if (!Number.isFinite(cp)) throw new RangeError(`Invalid centipawn value ${cp}`);
  return 100 / (1 + Math.exp(-LICHESS_ACCURACY_V1.winPercentK * clampCp(cp)));
}

/** Win% for `color` (0..100) from a White-perspective score. */
export function winPercent(score: Score, color: Color): number {
  return winPercentFromCp(povCp(povScore(score, color)));
}

/** White-perspective Win% per position, `null` where there is no score (failed or not analysed). */
export function winSeries(scores: readonly (Score | undefined)[]): (number | null)[] {
  return scores.map((score) => (score === undefined ? null : winPercent(score, "w")));
}
