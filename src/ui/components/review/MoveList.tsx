import { memo, useEffect, useMemo, useRef } from "react";
import type { Label } from "@/core/classify";
import { fenMoveInfo } from "@/core/chess/notation";
import type { Fen, Ply } from "@/core/chess/types";
import { LabelChip } from "./LabelChip";

interface Row {
  number: number;
  white?: Ply;
  black?: Ply;
}

function buildRows(startFen: Fen, plies: readonly Ply[]): Row[] {
  const rows: Row[] = [];
  let { fullmove } = fenMoveInfo(startFen);
  for (const ply of plies) {
    if (ply.color === "w" || rows.length === 0) rows.push({ number: fullmove });
    const row = rows[rows.length - 1]!;
    if (ply.color === "w") row.white = ply;
    else {
      row.black = ply;
      fullmove++;
    }
  }
  return rows;
}

export interface MoveListProps {
  startFen: Fen;
  plies: readonly Ply[];
  /** 0 is the start position; k is the position after ply k. */
  currentPly: number;
  onSelect: (ply: number) => void;
  /** Displayed label of each move (index 0 = ply 1), when the game has a review. */
  labels?: readonly (Label | undefined)[];
}

/**
 * One move. Memoised: moving through the game re-renders only the two moves whose "current"
 * state changes, not every move of a long game (Phase 3: no main-thread task over 50 ms).
 * The label sits next to the button (not inside it), so the button's visible text stays its SAN
 * and its name stays "White: e4"; the label is linked as its description.
 */
const MoveCell = memo(function MoveCell({ ply, label, isCurrent, onSelect }: { ply: Ply; label: Label | undefined; isCurrent: boolean; onSelect: (ply: number) => void }) {
  const labelId = `move-label-${ply.index}`;
  return (
    <div className={`flex flex-wrap items-center justify-between gap-x-1 rounded ${isCurrent ? "bg-accent text-accent-contrast" : "hover:bg-surface-2"}`}>
      <button
        type="button"
        onClick={() => onSelect(ply.index)}
        aria-current={isCurrent ? "true" : undefined}
        aria-label={`${ply.color === "w" ? "White" : "Black"}: ${ply.san}`}
        aria-describedby={label ? labelId : undefined}
        className="min-w-0 flex-1 rounded px-2 py-1 text-left font-mono text-sm"
      >
        {ply.san}
      </button>
      {label && (
        <span id={labelId} className="pr-1">
          <LabelChip label={label} size="xs" />
        </span>
      )}
    </div>
  );
});

export function MoveList({ startFen, plies, currentPly, onSelect, labels }: MoveListProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const rows = useMemo(() => buildRows(startFen, plies), [startFen, plies]);

  useEffect(() => {
    const current = listRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    current?.scrollIntoView({ block: "nearest" });
  }, [currentPly]);

  const cell = (ply: Ply | undefined) =>
    ply ? (
      <MoveCell ply={ply} label={labels?.[ply.index - 1]} isCurrent={ply.index === currentPly} onSelect={onSelect} />
    ) : (
      <span className="block px-2 py-1 font-mono text-sm text-muted" aria-hidden="true">
        …
      </span>
    );

  return (
    <nav aria-label="Moves" className="flex min-h-0 flex-col">
      <button
        type="button"
        onClick={() => onSelect(0)}
        aria-current={currentPly === 0 ? "true" : undefined}
        className={`mb-1 rounded px-2 py-1 text-left text-sm ${currentPly === 0 ? "bg-accent text-accent-contrast" : "text-muted hover:bg-surface-2"}`}
      >
        Start position
      </button>
      {plies.length === 0 ? (
        <p className="px-2 text-sm text-muted">This game has no moves.</p>
      ) : (
        <ol ref={listRef} className="max-h-[50vh] overflow-y-auto lg:max-h-[60vh]">
          {rows.map((row) => (
            <li key={row.number} className="grid grid-cols-[2.75rem_1fr_1fr] items-center gap-1">
              <span className="pr-1 text-right font-mono text-sm text-muted">{row.number}.</span>
              {cell(row.white)}
              {cell(row.black)}
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
