import { STANDARD_START_FEN } from "../chess/position";
import type { Fen, Uci } from "../chess/types";

/**
 * `position` command with the full move history from the game's start position, so the
 * engine can see repetitions (docs/TECHNICAL_ARCHITECTURE.md D9). Never a bare FEN of
 * the analysed position.
 */
export function positionCommand(startFen: Fen, moves: readonly Uci[]): string {
  const base = startFen === STANDARD_START_FEN ? "position startpos" : `position fen ${startFen}`;
  return moves.length > 0 ? `${base} moves ${moves.join(" ")}` : base;
}

/** Node-limited search with a depth cap (docs/TECHNICAL_ARCHITECTURE.md D8). */
export function goCommand(nodes: number, maxDepth: number): string {
  if (!Number.isInteger(nodes) || nodes <= 0) throw new RangeError(`Invalid node budget: ${nodes}`);
  if (!Number.isInteger(maxDepth) || maxDepth <= 0) throw new RangeError(`Invalid depth cap: ${maxDepth}`);
  return `go nodes ${nodes} depth ${maxDepth}`;
}
