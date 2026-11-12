import type { Score } from "@/core/engine/types";
import { winPercent } from "@/core/eval";
import { formatScore } from "@/ui/format";

/**
 * Evaluation bar (F4.4): White's perspective, filled by White's Win% (core/eval, methodology §4),
 * labelled with the engine score ("+1.24", "M3", "−M2"). White's side is at the bottom when the
 * board shows White at the bottom.
 */
export function EvalBar({ score, orientation }: { score: Score | undefined; orientation: "white" | "black" }) {
  const white = score ? winPercent(score, "w") : 50;
  const text = score ? formatScore(score) : "–";
  const whiteAtBottom = orientation === "white";
  const whiteAhead = white >= 50;
  return (
    <div
      role="img"
      aria-label={score ? `Evaluation ${text}, White's perspective` : "No evaluation for this position"}
      data-testid="eval-bar"
      data-score={text}
      data-white-percent={white.toFixed(1)}
      className="relative w-8 shrink-0 overflow-hidden rounded-md border border-border bg-[#3a3935]"
    >
      <div
        className="absolute inset-x-0 bg-[#f4f3ee] transition-[height] duration-200"
        style={{ height: `${white}%`, ...(whiteAtBottom ? { bottom: 0 } : { top: 0 }) }}
      />
      <span
        className={`absolute inset-x-0 text-center font-mono text-[9px] font-semibold leading-4 tracking-tighter ${whiteAhead ? "text-[#1d1c19]" : "text-[#f4f3ee]"}`}
        style={whiteAhead === whiteAtBottom ? { bottom: 2 } : { top: 2 }}
        aria-hidden="true"
      >
        {text}
      </span>
    </div>
  );
}
