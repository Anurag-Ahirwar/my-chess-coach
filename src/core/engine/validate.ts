import { replayUciLine } from "../chess/position";
import type { Fen, Uci } from "../chess/types";
import type { PositionResult } from "./analysis";
import type { EngineLine } from "./types";

/** The parts of an engine search result that validation needs. */
export interface EngineOutcome {
  lines: EngineLine[];
  bestMove: Uci | null;
  timeMs: number;
  anomalies: string[];
}

/**
 * Turns an engine result into a stored PositionResult. Anything untrustworthy makes the
 * position `failed` with an error, never `done`: anomalies (e.g. mate 0), no evaluation,
 * no best move, or any illegal move in the best move or a PV (an engine or parser bug).
 * A bestmove that differs from the last exact top line is valid (decision D16).
 */
export function resultFromOutcome(positionIndex: number, fen: Fen, multiPv: number, outcome: EngineOutcome): PositionResult {
  const fail = (error: string): PositionResult => ({ positionIndex, status: "failed", error, lines: [] });

  if (outcome.anomalies.length > 0) return fail(`Engine anomaly: ${outcome.anomalies.join("; ")}`);
  if (outcome.lines.length === 0) return fail("The engine returned no evaluation.");
  if (outcome.lines.length > multiPv) return fail(`The engine returned ${outcome.lines.length} lines for MultiPV ${multiPv}.`);
  if (outcome.lines[0]!.rank !== 1) return fail("The engine returned no top line (MultiPV 1).");
  if (outcome.bestMove === null) return fail("The engine returned no best move for a position with legal moves.");
  if (replayUciLine(fen, [outcome.bestMove]).illegalAt !== undefined) {
    return fail(`The engine's best move ${outcome.bestMove} is illegal in this position.`);
  }
  for (const line of outcome.lines) {
    if (line.pv.length === 0) return fail(`Line ${line.rank} has an empty PV.`);
    const { illegalAt } = replayUciLine(fen, line.pv);
    if (illegalAt !== undefined) {
      return fail(`Line ${line.rank} has an illegal move ${line.pv[illegalAt]} at PV ply ${illegalAt + 1}.`);
    }
  }
  return { positionIndex, status: "done", lines: outcome.lines, bestMove: outcome.bestMove, timeMs: outcome.timeMs };
}
