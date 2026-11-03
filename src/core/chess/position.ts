import { Chess, DEFAULT_POSITION, validateFen } from "chess.js";
import { parseUci, toUci } from "./notation";
import type { Color, Fen, Ply, San, TerminalState, Uci } from "./types";

export const STANDARD_START_FEN: Fen = DEFAULT_POSITION;

export type FenCheck = { ok: true } | { ok: false; error: string };

export function checkFen(fen: Fen): FenCheck {
  const result = validateFen(fen);
  return result.ok ? { ok: true } : { ok: false, error: result.error ?? "Invalid FEN" };
}

export interface AppliedMove {
  uci: Uci;
  san: San;
  color: Color;
  fenAfter: Fen;
}

/**
 * A game in progress, replayed move by move from a start position.
 *
 * All chess rules come from chess.js. Keeping one chess.js instance for the
 * whole game matters: threefold repetition is only detectable from the move
 * history, not from a single FEN.
 */
export class GameReplay {
  private readonly chess: Chess;
  readonly startFen: Fen;

  constructor(startFen: Fen = STANDARD_START_FEN) {
    const check = checkFen(startFen);
    if (!check.ok) throw new InvalidFenError(startFen, check.error);
    this.chess = new Chess(startFen);
    this.startFen = startFen;
  }

  get fen(): Fen {
    return this.chess.fen();
  }

  get turn(): Color {
    return this.chess.turn();
  }

  /** Applies a SAN move (permissive parsing, as found in real PGNs). Throws IllegalMoveError. */
  playSan(san: string): AppliedMove {
    const color = this.chess.turn();
    let move;
    try {
      move = this.chess.move(san, { strict: false });
    } catch {
      throw new IllegalMoveError(san, this.chess.fen());
    }
    return { uci: toUci(move), san: move.san, color, fenAfter: move.after };
  }

  /** Applies a UCI move. Throws IllegalMoveError. */
  playUci(uci: Uci): AppliedMove {
    const parts = parseUci(uci);
    if (!parts) throw new IllegalMoveError(uci, this.chess.fen());
    const color = this.chess.turn();
    let move;
    try {
      move = this.chess.move(parts);
    } catch {
      throw new IllegalMoveError(uci, this.chess.fen());
    }
    return { uci: toUci(move), san: move.san, color, fenAfter: move.after };
  }

  legalMoveCount(): number {
    return this.chess.moves().length;
  }

  /** Rule-based terminal state of the current position, or null if play can continue normally. */
  terminalState(): TerminalState | null {
    const chess = this.chess;
    if (chess.isCheckmate()) return { kind: "checkmate", winner: chess.turn() === "w" ? "b" : "w" };
    if (chess.isStalemate()) return { kind: "stalemate" };
    if (chess.isInsufficientMaterial()) return { kind: "insufficient_material" };
    if (chess.isThreefoldRepetition()) return { kind: "threefold_repetition" };
    if (chess.isDrawByFiftyMoves()) return { kind: "fifty_move_rule" };
    return null;
  }
}

/** Replays a line of UCI moves from a FEN, e.g. an engine PV. Stops at the first illegal move. */
export function replayUciLine(
  startFen: Fen,
  line: readonly Uci[],
): { moves: AppliedMove[]; illegalAt?: number } {
  const replay = new GameReplay(startFen);
  const moves: AppliedMove[] = [];
  for (let i = 0; i < line.length; i++) {
    try {
      moves.push(replay.playUci(line[i] ?? ""));
    } catch {
      return { moves, illegalAt: i };
    }
  }
  return { moves };
}

/** The positions of a game: index 0 is the start, index k is after ply k. */
export function positionsOf(startFen: Fen, plies: readonly Ply[]): Fen[] {
  return [startFen, ...plies.map((ply) => ply.fenAfter)];
}

export class InvalidFenError extends Error {
  constructor(
    readonly fen: string,
    readonly reason: string,
  ) {
    super(`Invalid FEN "${fen}": ${reason}`);
    this.name = "InvalidFenError";
  }
}

export class IllegalMoveError extends Error {
  constructor(
    readonly move: string,
    readonly fen: string,
  ) {
    super(`Illegal move "${move}" in position ${fen}`);
    this.name = "IllegalMoveError";
  }
}
