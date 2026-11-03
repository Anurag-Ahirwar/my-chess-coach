import { useEffect, useRef } from "react";
import { fenMoveInfo } from "@/core/chess/notation";
import type { Fen, Ply } from "@/core/chess/types";

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
}

export function MoveList({ startFen, plies, currentPly, onSelect }: MoveListProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const rows = buildRows(startFen, plies);

  useEffect(() => {
    const current = listRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    current?.scrollIntoView({ block: "nearest" });
  }, [currentPly]);

  const cell = (ply: Ply | undefined) =>
    ply ? (
      <button
        type="button"
        onClick={() => onSelect(ply.index)}
        aria-current={ply.index === currentPly ? "true" : undefined}
        aria-label={`${ply.color === "w" ? "White" : "Black"}: ${ply.san}`}
        className={`w-full rounded px-2 py-1 text-left font-mono text-sm ${
          ply.index === currentPly ? "bg-accent text-accent-contrast" : "hover:bg-surface-2"
        }`}
      >
        {ply.san}
      </button>
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
