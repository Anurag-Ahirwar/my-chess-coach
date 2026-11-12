import type { PovScore } from "../eval";
import type { MethodologyConfig } from "../methodology/v1";
import type { Severity } from "./types";

export type MateRule =
  | { rule: "allowed"; minimum: Severity }
  | { rule: "lost"; minimum: Severity }
  | { rule: "delayed" };

const isMateAgainst = (s: PovScore) => (s.kind === "mate" && s.moves < 0) || (s.kind === "terminal" && s.outcome === "loss");

/**
 * methodology §5.4, mover POV. Mutually exclusive by construction. `before` is P (always an
 * engine score: P has a next move), `after` is P′ (an engine score, or terminal).
 * A terminal draw at P′ counts as cp 0 (M7). Delivering mate (terminal win) triggers nothing.
 */
export function mateRule(before: PovScore, after: PovScore, mate: MethodologyConfig["mate"]): MateRule | undefined {
  // Mate allowed: no forced mate at P (a cp score), forced mate against the mover at P′.
  if (before.kind === "cp" && isMateAgainst(after)) {
    const cp = before.value;
    if (cp <= -mate.inaccuracyAtCp) return { rule: "allowed", minimum: "inaccuracy" };
    if (cp < -mate.mistakeBeyondCp) return { rule: "allowed", minimum: "mistake" };
    return { rule: "allowed", minimum: "blunder" };
  }
  if (before.kind === "mate" && before.moves > 0) {
    if (after.kind === "terminal" && after.outcome === "win") return undefined; // mate delivered
    if (after.kind === "mate" && after.moves > 0) {
      // Mate delayed: still mating, at a longer or equal distance (lila: next ≥ prev). No minimum.
      return after.moves >= before.moves ? { rule: "delayed" } : undefined;
    }
    // Mate lost: P′ is a cp score (a terminal draw counts as cp 0) or a mate against the mover.
    if (isMateAgainst(after)) return { rule: "lost", minimum: "blunder" };
    const cp = after.kind === "cp" ? after.value : 0;
    if (cp >= mate.inaccuracyAtCp) return { rule: "lost", minimum: "inaccuracy" };
    if (cp > mate.mistakeBeyondCp) return { rule: "lost", minimum: "mistake" };
    return { rule: "lost", minimum: "blunder" };
  }
  return undefined;
}
