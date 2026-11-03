/** "w" | "b", matching chess.js. */
export type Color = "w" | "b";
/** UCI long algebraic, e.g. "e2e4", "e7e8q", "e1g1" (castling is the king move). */
export type Uci = string;
/** Standard algebraic notation as produced by chess.js, e.g. "exd8=Q+". */
export type San = string;
export type Fen = string;
/** First four FEN fields: placement, side to move, castling, en passant. */
export type Epd = string;

export type GameResult = "1-0" | "0-1" | "1/2-1/2" | "*";

export interface Ply {
  /** 1-based half-move index. Position k is the position after ply k; position 0 is the start. */
  index: number;
  uci: Uci;
  san: San;
  /** The side that made this move. */
  color: Color;
  fenAfter: Fen;
  /** Mover's remaining clock after the move, from a `[%clk]` comment. */
  clockSeconds?: number;
}

/** Board states where the game is over or a draw can be claimed, detected by rules only. */
export type TerminalState =
  | { kind: "checkmate"; winner: Color }
  | { kind: "stalemate" }
  | { kind: "insufficient_material" }
  | { kind: "threefold_repetition" }
  | { kind: "fifty_move_rule" };

export const opposite = (color: Color): Color => (color === "w" ? "b" : "w");
