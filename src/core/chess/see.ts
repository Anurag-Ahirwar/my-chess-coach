import { Chess, type Move } from "chess.js";
import type { MaterialValues } from "./material";
import type { Color, Fen } from "./types";

/**
 * Static exchange evaluation (docs/CHESS_ANALYSIS_METHODOLOGY.md §5.11): a DETERMINISTIC
 * least-valuable-attacker estimate of the material the side to move wins by starting captures
 * on one square, when either side may stop before any capture. Not an exact search.
 *
 * - Every step uses chess.js LEGAL moves on the actual position, so pins, checks, king safety,
 *   en passant and promotion follow the rules (x-ray attackers appear as pieces move away).
 * - The least valuable capturer goes first; ties: knight before bishop, then the lowest starting
 *   square (a1, b1, …, h8). Promotions are to a queen (+8 gain).
 * - Equal-value capturers on different squares can reveal different things (e.g. a discovered
 *   check that makes the recapture illegal), so the tie-break may differ from the best order.
 *   Every alternative order at a tie is also played out; if any changes the result, the estimate
 *   is reported as NOT certain, and Brilliant treats it as "can't be checked".
 * - Limitations: static, captures on one square only; ignores in-between moves, checks elsewhere,
 *   pins against non-king pieces, threats created by the exchange, and stalemate.
 */

export interface SeeResult {
  /** Material won (≥ 0) with the deterministic tie-break. */
  value: number;
  /** False when another order of equal-value capturers gives a different result. */
  certain: boolean;
}

const MAX_CAPTURES = 32;
const ORDER: Record<string, number> = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
const squareIndex = (square: string) => square.charCodeAt(0) - 97 + (Number(square[1]) - 1) * 8;

function pieceValue(type: string, values: MaterialValues): number {
  switch (type) {
    case "p":
      return values.p;
    case "n":
      return values.n;
    case "b":
      return values.b;
    case "r":
      return values.r;
    case "q":
      return values.q;
    default:
      return 1000; // the king: never captured, and only ever the last capturer
  }
}

/** Legal captures of the piece on `target` (en passant: the captured pawn stands on `target`). */
function capturesOf(chess: Chess, target: string): Move[] {
  return chess
    .moves({ verbose: true })
    .filter((m) => m.captured !== undefined && (m.promotion === undefined || m.promotion === "q"))
    .filter((m) => (m.isEnPassant() ? `${m.to[0]}${m.from[1]}` === target : m.to === target));
}

function exchange(chess: Chess, target: string, values: MaterialValues, depth: number): SeeResult {
  if (depth >= MAX_CAPTURES) return { value: 0, certain: true };
  const captures = capturesOf(chess, target);
  if (captures.length === 0) return { value: 0, certain: true };
  const cheapest = Math.min(...captures.map((m) => pieceValue(m.piece, values)));
  const candidates = captures
    .filter((m) => pieceValue(m.piece, values) === cheapest)
    .sort((a, b) => ORDER[a.piece]! - ORDER[b.piece]! || squareIndex(a.from) - squareIndex(b.from));
  const results = candidates.map((move) => {
    const gain = pieceValue(move.captured!, values) + (move.promotion ? values.q - values.p : 0);
    chess.move(move);
    // After an en passant capture the exchange continues on the capturing pawn's new square.
    const reply = exchange(chess, move.to, values, depth + 1);
    chess.undo();
    return { value: Math.max(0, gain - reply.value), certain: reply.certain };
  });
  const chosen = results[0]!;
  return { value: chosen.value, certain: results.every((r) => r.certain && r.value === chosen.value) };
}

/** SEE for the side to move in `fen`, capturing on `square`. Throws on an invalid FEN. */
export function see(fen: Fen, square: string, values: MaterialValues): SeeResult {
  return exchange(new Chess(fen), square, values, 0);
}

/**
 * The null-move position P* of methodology §5.11: `fen` with the other side to move and no en
 * passant square. Undefined when the side to move is in check (P* would not be legal).
 */
export function nullMoveFen(fen: Fen): Fen | undefined {
  if (new Chess(fen).inCheck()) return undefined;
  const fields = fen.trim().split(/\s+/);
  fields[1] = fields[1] === "w" ? "b" : "w";
  fields[3] = "-";
  return fields.join(" ");
}

/** Squares of `color`'s pieces other than the king. */
export function pieceSquares(fen: Fen, color: Color): string[] {
  const board = new Chess(fen).board();
  const squares: string[] = [];
  for (const row of board) for (const cell of row) if (cell && cell.color === color && cell.type !== "k") squares.push(cell.square);
  return squares;
}
