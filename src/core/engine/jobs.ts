import type { Color, Fen, TerminalState, Uci } from "../chess/types";
import type { GameRecord } from "../game/types";
import type { TerminalScore } from "./analysis";

/** What the engine needs to analyse one position of a game. */
export interface PositionJob {
  positionIndex: number;
  /** The game's start position; the engine also gets every move up to this position (spec D9). */
  startFen: Fen;
  moves: Uci[];
  /** FEN of the analysed position, for validating the engine's moves. */
  fen: Fen;
  sideToMove: Color;
}

/** Position k of a game: k = 0 is the start, k = n the final position. */
export function positionJob(game: Pick<GameRecord, "startFen" | "plies">, positionIndex: number): PositionJob {
  if (!Number.isInteger(positionIndex) || positionIndex < 0 || positionIndex > game.plies.length) {
    throw new RangeError(`Position ${positionIndex} is outside 0..${game.plies.length}`);
  }
  const fen = positionIndex === 0 ? game.startFen : game.plies[positionIndex - 1]!.fenAfter;
  return {
    positionIndex,
    startFen: game.startFen,
    moves: game.plies.slice(0, positionIndex).map((ply) => ply.uci),
    fen,
    sideToMove: fen.split(" ")[1] === "b" ? "b" : "w",
  };
}

/**
 * Rules-based score for a position the engine must not analyse (methodology §3, decision D6).
 * Only the game's FINAL position can be terminal: checkmate, stalemate and insufficient material
 * end the game on the spot, and a threefold-repetition or 50-move position the players
 * continued past was only a claimable draw, so later positions are real and analysed normally.
 */
export function terminalScore(game: Pick<GameRecord, "plies" | "terminal">, positionIndex: number): TerminalScore | null {
  if (positionIndex !== game.plies.length || !game.terminal) return null;
  return { kind: "terminal", result: resultOf(game.terminal) };
}

function resultOf(state: TerminalState): TerminalScore["result"] {
  switch (state.kind) {
    case "checkmate":
      return state.winner === "w" ? "1-0" : "0-1";
    case "stalemate":
    case "insufficient_material":
    case "threefold_repetition":
    case "fifty_move_rule":
      return "1/2-1/2";
  }
}
