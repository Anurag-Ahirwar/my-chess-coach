import { povScore, winPercent } from "../eval";
import type { MethodologyConfig } from "../methodology/v1";
import { atLeast, bandFor, worse } from "./bands";
import { mateRule } from "./mate";
import type { MoveInput, MoveVerdict, Severity } from "./types";

/** Optional evaluators for the experimental labels (methodology §5.6–§5.7), tried in this order. */
export interface SpecialLabelRule {
  label: "brilliant" | "great";
  /** Returns reasons when the label applies, undefined otherwise. Never throws for missing data. */
  evaluate(input: MoveInput, facts: { wb: number; wa: number; severity: Severity }, config: MethodologyConfig): string[] | undefined;
}

/**
 * The label pipeline, in exactly the order of methodology §5.2:
 * missing data (§6.4) → Forced → Book → mate rules → severity band → Miss → Brilliant → Great.
 * Pure and deterministic.
 */
export function classifyMove(input: MoveInput, config: MethodologyConfig, special: readonly SpecialLabelRule[] = []): MoveVerdict {
  const { before, after, color } = input;
  // §6.4 / M6: no evaluation on either side → no label at all, not even Forced or Book.
  if (!before || !after) return { reasons: ["missing:eval"] };

  const wb = winPercent(before.score, color);
  const wa = winPercent(after.score, color);
  const winLoss = Math.max(0, wb - wa);
  const wins = { winBefore: wb, winAfter: wa, winLoss };

  if (input.legalMoves === 1) return { label: "forced", reasons: ["forced"], ...wins };
  if (input.bookChain) return { label: "book", reasons: ["book"], ...wins };

  const reasons: string[] = [];
  const mate = mateRule(povScore(before.score, color), povScore(after.score, color), config.mate);
  if (mate) reasons.push(`mate:${mate.rule}`);

  const playedIsBest = before.bestMove !== undefined && before.bestMove === input.uci;
  const band = bandFor(winLoss, playedIsBest, config.bands);
  reasons.push(`band:${band}`);
  if (playedIsBest) reasons.push("engine:best");
  const severity = worse(band, mate && mate.rule !== "delayed" ? mate.minimum : undefined);
  if (severity !== band) reasons.push(`mate:minimum:${severity}`);

  // §5.5 Miss.
  const opportunity =
    (input.previousSeverity !== undefined && atLeast(input.previousSeverity, config.miss.minSeverity)) ||
    (input.winPrev !== undefined && wb - input.winPrev >= config.miss.opportunityGain);
  const failedToTake = atLeast(severity, config.miss.minSeverity) || mate?.rule === "lost";
  if (opportunity && failedToTake && wb >= config.miss.minWinBefore) {
    reasons.push("miss");
    return { label: "miss", severity, reasons, ...wins };
  }

  if (severity === "best") {
    for (const rule of special) {
      const extra = rule.evaluate(input, { wb, wa, severity }, config);
      if (extra) return { label: rule.label, severity, reasons: [...reasons, ...extra], ...wins };
    }
  }
  return { label: severity, severity, reasons, ...wins };
}
