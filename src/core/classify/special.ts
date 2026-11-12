import { Chess } from "chess.js";
import { materialBalance } from "../chess/material";
import { parseUci } from "../chess/notation";
import { nullMoveFen, pieceSquares, see } from "../chess/see";
import { povScore, winPercent } from "../eval";
import type { SpecialLabelRule } from "./pipeline";
import type { MoveInput } from "./types";

/** Experimental labels (docs/CHESS_ANALYSIS_METHODOLOGY.md §5.6, §5.7). "Undefined" = no label. */

function playedMove(input: MoveInput) {
  const parts = parseUci(input.uci);
  if (!parts) return undefined;
  try {
    const chess = new Chess(input.fenBefore);
    const inCheck = chess.inCheck();
    const move = chess.move(parts);
    return { move, inCheck, fenAfter: chess.fen() };
  } catch {
    return undefined;
  }
}

/** §5.6 Great: the only move that keeps the evaluation. */
export const GREAT_RULE: SpecialLabelRule = {
  label: "great",
  evaluate(input, { wb }, config) {
    if (!config.great.enabled || !input.analysis.allowsSpecialLabels || input.analysis.multiPv < 2) return undefined;
    const before = input.before;
    const best1 = before?.lines[0];
    const best2 = before?.lines[1];
    if (!before || !best1 || !best2 || before.bestMove === undefined) return undefined;
    // M9: best1 and best2 can't be told apart when the bestmove and the top line disagree.
    if (before.bestMove !== best1.pv[0]) return undefined;
    // 1. Best and the engine's move.
    if (input.uci !== before.bestMove) return undefined;
    // 2. At least two legal moves, and a second line.
    if (input.legalMoves < 2) return undefined;
    // 3. The second-best move is clearly worse.
    const gap = winPercent(best1.score, input.color) - winPercent(best2.score, input.color);
    if (gap < config.great.minGap) return undefined;
    // 4. Not already decided.
    if (wb < config.great.minWb || wb > config.great.maxWb) return undefined;
    const played = playedMove(input);
    if (!played) return undefined;
    // 5. Not an obvious recapture.
    const previous = input.previousMove;
    if (previous?.capture && played.move.captured !== undefined && parseUci(previous.uci)?.to === played.move.to) return undefined;
    // 6. Not a king move out of check with at most two legal moves.
    if (played.inCheck && played.move.piece === "k" && input.legalMoves <= 2) return undefined;
    return ["great", `great:gap:${gap.toFixed(1)}`];
  },
};

/** The square a piece on `square` at P′ stood on at P (the moved piece, or a castling rook). */
function originAt(square: string, move: { from: string; to: string; flags: string }): string {
  if (square === move.to) return move.from;
  const rank = move.from[1];
  if (move.flags.includes("k") && square === `f${rank}`) return `h${rank}`;
  if (move.flags.includes("q") && square === `d${rank}`) return `a${rank}`;
  return square;
}

/** §5.7 Brilliant: a sound sacrifice that is also the best move. */
export const BRILLIANT_RULE: SpecialLabelRule = {
  label: "brilliant",
  evaluate(input, { wb, wa }, config) {
    const b = config.brilliant;
    if (!b.enabled || !input.analysis.allowsSpecialLabels || input.analysis.multiPv < 2) return undefined;
    const { before, after, color } = input;
    const top = before?.lines[0];
    if (!before || !after || !top) return undefined;
    // 1. Best, and best1 or within 1.0 Win% of it (M15).
    const isBest1 = before.bestMove !== undefined && input.uci === before.bestMove;
    if (!isBest1 && winPercent(top.score, color) - wa > b.bestWithin) return undefined;
    // 4–5. Not losing after, not already crushing before.
    if (wa < b.minWa || wb >= b.maxWb) return undefined;
    // P′ must be an engine position (a delivered mate has no reply to sacrifice to).
    const reply = after.lines[0];
    if (!reply || after.bestMove === undefined) return undefined;
    if (after.bestMove !== reply.pv[0]) return undefined; // D16: the PV is not certain
    const played = playedMove(input);
    if (!played) return undefined;
    // D4: mover in check at P → P* isn't legal → not evaluated.
    if (played.inCheck) return undefined;
    const pStar = nullMoveFen(input.fenBefore);
    if (pStar === undefined) return undefined;

    // 2. The sacrificed set S.
    const sacrificed: string[] = [];
    for (const square of pieceSquares(played.fenAfter, color)) {
      const now = see(played.fenAfter, square, config.material);
      if (!now.certain) return undefined; // an uncertain SEE can't be checked
      if (now.value < b.minSacrifice) continue;
      const earlier = see(pStar, originAt(square, played.move), config.material);
      if (!earlier.certain) return undefined;
      if (earlier.value < b.minSacrifice) sacrificed.push(square); // not already lost before the move (D3)
    }
    if (sacrificed.length === 0) return undefined;

    // Mate exception (D2): P′'s top line is a forced mate for the mover.
    const replyScore = povScore(reply.score, color);
    if (replyScore.kind === "mate" && replyScore.moves > 0) {
      return ["brilliant", `brilliant:sacrifice:${sacrificed.join(",")}`, "brilliant:mate-exception"];
    }

    // 6. A PV of at least 4 plies; 3. accepted on ply 1 and not recovered through ply 4 (D1).
    if (reply.pv.length < b.minPersistPlies) return undefined;
    const chess = new Chess(played.fenAfter);
    const balanceBefore = materialBalance(input.fenBefore, color, config.material);
    for (let ply = 0; ply < b.minPersistPlies; ply++) {
      const parts = parseUci(reply.pv[ply]!);
      if (!parts) return undefined;
      let move;
      try {
        move = chess.move(parts);
      } catch {
        return undefined;
      }
      if (ply === 0) {
        const capturedOn = move.isEnPassant() ? `${move.to[0]}${move.from[1]}` : move.to;
        if (move.captured === undefined || !sacrificed.includes(capturedOn)) return undefined; // not accepted
      }
      if (materialBalance(chess.fen(), color, config.material) > balanceBefore - b.minSacrifice) return undefined; // recovered
    }
    return ["brilliant", `brilliant:sacrifice:${sacrificed.join(",")}`];
  },
};

/** The experimental rules in §5.2 order: Brilliant takes precedence over Great. */
export const SPECIAL_RULES: readonly SpecialLabelRule[] = [BRILLIANT_RULE, GREAT_RULE];

