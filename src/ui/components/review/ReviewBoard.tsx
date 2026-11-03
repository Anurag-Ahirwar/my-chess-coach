import type { CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import { parseUci } from "@/core/chess/notation";
import type { Fen, Uci } from "@/core/chess/types";

const LIGHT_SQUARE: CSSProperties = { backgroundColor: "var(--board-light)" };
const DARK_SQUARE: CSSProperties = { backgroundColor: "var(--board-dark)" };
const HIGHLIGHT: CSSProperties = { backgroundColor: "var(--highlight)" };

export interface ReviewBoardProps {
  fen: Fen;
  orientation: "white" | "black";
  /** The move that led to this position, highlighted on the board. */
  lastMove?: Uci;
  /** Accessible description, e.g. "Position after 12... e5". */
  label: string;
}

/** Read-only board for reviewing a game. Engine arrows are added in Phase 3. */
export function ReviewBoard({ fen, orientation, lastMove, label }: ReviewBoardProps) {
  const move = lastMove ? parseUci(lastMove) : null;
  const squareStyles: Record<string, CSSProperties> = move ? { [move.from]: HIGHLIGHT, [move.to]: HIGHLIGHT } : {};

  // The board is display-only. react-chessboard still renders every piece as a focusable,
  // unnamed drag handle, so the board itself is inert (no tab stops, hidden from assistive
  // technology) and the wrapper describes the position instead.
  return (
    <div role="img" aria-label={label} className="aspect-square w-full overflow-hidden rounded-md shadow-sm">
      <div inert className="h-full w-full">
        <Chessboard
        options={{
          id: "review-board",
          position: fen,
          boardOrientation: orientation,
          allowDragging: false,
          allowDrawingArrows: false,
          showAnimations: true,
          animationDurationInMs: 150,
          lightSquareStyle: LIGHT_SQUARE,
          darkSquareStyle: DARK_SQUARE,
          squareStyles,
        }}
        />
      </div>
    </div>
  );
}
