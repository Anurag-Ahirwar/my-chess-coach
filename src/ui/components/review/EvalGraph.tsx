import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { Label } from "@/core/classify";
import { LABEL_INFO } from "@/ui/review/presentation";

export interface EvalGraphProps {
  /** White-perspective Win% per position 0..n; null where there is no evaluation (a gap). */
  series: readonly (number | null)[];
  /** Displayed label of each move 1..n (index 0 = move 1), for marking large drops. */
  labels: readonly (Label | undefined)[];
  /** Current position. */
  ply: number;
  onSelect: (ply: number) => void;
  /** Text for a position: used for the tooltip and the screen-reader value. */
  describe: (ply: number) => string;
}

const MARKED: ReadonlySet<Label> = new Set(["inaccuracy", "mistake", "miss", "blunder"]);
const W = 1000;

/**
 * Evaluation graph (F4.4): custom SVG (architecture D12), White's Win% over the game, gaps where
 * a position has no evaluation, large drops marked with their label colour and symbol.
 * Click a point or use the keyboard (it is a slider: ← → Home End, handled with the move keys).
 */
export function EvalGraph({ series, labels, ply, onSelect, describe }: EvalGraphProps) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | undefined>(undefined);
  const last = Math.max(1, series.length - 1);
  const x = (k: number) => (k / last) * W;


  const plyAt = (event: MouseEvent<HTMLDivElement>) => {
    const rect = box.current!.getBoundingClientRect();
    return Math.max(0, Math.min(series.length - 1, Math.round(((event.clientX - rect.left) / rect.width) * last)));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // ← → Home End reach the page's move keys; PageUp/PageDown jump 10 plies.
    if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      onSelect(Math.max(0, Math.min(series.length - 1, ply + (event.key === "PageDown" ? 10 : -10))));
    }
  };
  const shown = hover ?? ply;

  // The curve, gaps and markers only change with a new review: drawn once per review, not on every
  // move (Phase 3: no main-thread task over 50 ms while navigating).
  const drawing = useMemo(() => {
    const runs: { k: number; win: number }[][] = [];
    series.forEach((win, k) => {
      if (win === null) return;
      const run = runs.at(-1);
      if (run && run.at(-1)!.k === k - 1) run.push({ k, win });
      else runs.push([{ k, win }]);
    });
    const span = Math.max(1, series.length - 1);
    const px = (k: number) => (k / span) * W;
    return (
      <svg viewBox={`0 0 ${W} 100`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
        {runs.map((run) => {
          const top = run.map((p) => `${px(p.k)},${100 - p.win}`).join(" ");
          return (
            <g key={run[0]!.k}>
              <polygon points={`${px(run[0]!.k)},100 ${top} ${px(run.at(-1)!.k)},100`} fill="#f4f3ee" />
              <polyline points={top} fill="none" stroke="#9a978d" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
        <line x1={0} x2={W} y1={50} y2={50} stroke="#8a877e" strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {series.map((win, k) =>
          win === null ? <rect key={`gap-${k}`} x={px(Math.max(0, k - 0.5))} width={W / span} y={0} height={100} fill="#a8261b" opacity={0.18} /> : null,
        )}
      </svg>
    );
  }, [series]);

  const markers = useMemo(() => {
    const span = Math.max(1, series.length - 1);
    return labels.map((label, i) => {
      const k = i + 1;
      const win = series[k];
      if (!label || !MARKED.has(label) || win === null || win === undefined) return null;
      const info = LABEL_INFO[label];
      return (
        <span
          key={k}
          aria-hidden="true"
          data-testid={`graph-marker-${k}`}
          className={`label-chip ${info.className} pointer-events-none absolute flex h-4 min-w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full px-0.5 text-[9px] font-bold`}
          style={{ left: `${(k / span) * 100}%`, top: `${100 - win}%` }}
        >
          {info.symbol}
        </span>
      );
    });
  }, [series, labels]);

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label="Evaluation graph (White's winning chances)"
        aria-valuemin={0}
        aria-valuemax={series.length - 1}
        aria-valuenow={ply}
        aria-valuetext={describe(ply)}
        data-testid="eval-graph"
        className="relative h-28 w-full cursor-pointer select-none overflow-hidden rounded-md border border-border bg-[#3a3935]"
        onClick={(event) => onSelect(plyAt(event))}
        onMouseMove={(event) => setHover(plyAt(event))}
        onMouseLeave={() => setHover(undefined)}
        onKeyDown={onKeyDown}
      >
        {drawing}
        <svg viewBox={`0 0 ${W} 100`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
          <line x1={x(ply)} x2={x(ply)} y1={0} y2={100} stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
        {markers}
      </div>
      <p className="min-h-5 text-xs text-muted" aria-hidden="true" data-testid="eval-graph-tooltip">
        {describe(shown)}
      </p>
    </div>
  );
}
