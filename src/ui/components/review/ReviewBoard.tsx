import { memo, type CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import type { Label } from "@/core/classify";
import { parseUci } from "@/core/chess/notation";
import type { Fen, Uci } from "@/core/chess/types";
import { LABEL_INFO } from "@/ui/review/presentation";

const LIGHT_SQUARE: CSSProperties = { backgroundColor: "var(--board-light)" };
const DARK_SQUARE: CSSProperties = { backgroundColor: "var(--board-dark)" };
const HIGHLIGHT: CSSProperties = { backgroundColor: "var(--highlight)" };

/** Arrow colours: the played move and the engine's best move are always distinct (F2.3). */
const ARROW_COLOURS = { played: "rgba(40, 95, 143, 0.75)", best: "rgba(45, 106, 48, 0.85)" } as const;

export interface BoardArrow {
  uci: Uci;
  kind: keyof typeof ARROW_COLOURS;
}

export interface ReviewBoardProps {
  fen: Fen;
  orientation: "white" | "black";
  /** The move that led to this position, highlighted on the board. */
  lastMove?: Uci;
  /** Accessible description, e.g. "Position after 12... e5". */
  label: string;
  /** Played-move and best-move arrows (Phase 3). */
  arrows?: readonly BoardArrow[];
  /** The label of the move that led here, shown on its destination square (F2.4). */
  badge?: { square: string; label: Label } | undefined;
}

/** Position of a square as a fraction of the board, from the top-left corner, for an orientation. */
function squareOffset(square: string, orientation: "white" | "black"): { left: number; top: number } {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return orientation === "white" ? { left: file / 8, top: (7 - rank) / 8 } : { left: (7 - file) / 8, top: rank / 8 };
}

/** Read-only board for reviewing a game, with the review's arrows and label badge. Memoised. */
export const ReviewBoard = memo(function ReviewBoard({ fen, orientation, lastMove, label, arrows = [], badge }: ReviewBoardProps) {
  const move = lastMove ? parseUci(lastMove) : null;
  const squareStyles: Record<string, CSSProperties> = move ? { [move.from]: HIGHLIGHT, [move.to]: HIGHLIGHT } : {};
  const boardArrows = arrows.flatMap((arrow) => {
    const parts = parseUci(arrow.uci);
    return parts ? [{ startSquare: parts.from, endSquare: parts.to, color: ARROW_COLOURS[arrow.kind] }] : [];
  });
  const badgeAt = badge ? squareOffset(badge.square, orientation) : undefined;
  const badgeInfo = badge ? LABEL_INFO[badge.label] : undefined;

  // The board is display-only. react-chessboard still renders every piece as a focusable,
  // unnamed drag handle, so the board itself is inert (no tab stops, hidden from assistive
  // technology) and the wrapper describes the position instead.
  return (
    <div role="img" aria-label={label} className="relative aspect-square w-full overflow-hidden rounded-md shadow-sm">
      <div inert className="h-full w-full">
        <Chessboard
          options={{
            id: "review-board",
            position: fen,
            boardOrientation: orientation,
            allowDragging: false,
            allowDrawingArrows: false,
            arrows: boardArrows,
            showAnimations: true,
            animationDurationInMs: 150,
            lightSquareStyle: LIGHT_SQUARE,
            darkSquareStyle: DARK_SQUARE,
            squareStyles,
          }}
        />
      </div>
      {badge && badgeAt && badgeInfo && (
        <span
          aria-hidden="true"
          data-testid="board-badge"
          data-label={badge.label}
          data-square={badge.square}
          className={`label-chip ${badgeInfo.className} pointer-events-none absolute flex h-[4.5%] min-w-[4.5%] -translate-x-full translate-y-[15%] items-center justify-center rounded-full px-1 text-[clamp(8px,1.6vw,13px)] font-bold shadow`}
          style={{ left: `${(badgeAt.left + 0.125) * 100}%`, top: `${badgeAt.top * 100}%` }}
        >
          {badgeInfo.symbol}
        </span>
      )}
      <span className="sr-only" data-testid="board-arrows">
        {boardArrows.map((a, i) => `${arrows[i]!.kind} ${a.startSquare}-${a.endSquare}`).join(", ")}
      </span>
    </div>
  );
});
