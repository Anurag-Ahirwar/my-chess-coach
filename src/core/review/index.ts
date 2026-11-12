import { Chess } from "chess.js";
import { PHASES, acpl, gameAccuracy, phaseAccuracy, type Phase, type PlayerAccuracy } from "../accuracy";
import { parseUci } from "../chess/notation";
import { positionsOf, replayUciLine } from "../chess/position";
import type { Color, Fen, San, Uci } from "../chess/types";
import { LABELS, SPECIAL_RULES, classifyMove, type Label, type MoveVerdict, type PositionEval, type Severity } from "../classify";
import type { PositionResult, RawAnalysis } from "../engine/analysis";
import type { EngineLine, Score } from "../engine/types";
import { whiteCp, winPercent, winSeries } from "../eval";
import type { GameRecord } from "../game/types";
import { configHash, type AccuracyMode, type MethodologyConfig } from "../methodology/v1";
import { bookChainLength, openingOf, type OpeningIndex } from "../openings";
import { dividePhases } from "../phases";

/**
 * Derives the GameReview (docs/DATA_MODELS.md §6) from a stored RawAnalysis and its game, with
 * one methodology config and opening index. Pure and deterministic: the same inputs always give
 * an identical object, and the inputs are never modified. Every SAN comes from UCI replayed
 * legally with chess.js.
 */

export interface MoveAnalysis {
  plyIndex: number;
  color: Color;
  san: San;
  uci: Uci;
  scoreBefore?: Score;
  scoreAfter?: Score;
  winBefore?: number;
  winAfter?: number;
  winLoss?: number;
  cpLoss?: number;
  bestMove?: { uci: Uci; san: San; winAfter: number };
  secondBest?: { uci: Uci; san: San; winAfter: number };
  bestLineSan: San[];
  refutationSan: San[];
  severity?: Severity;
  label?: Label;
  labelReasons: string[];
  accuracy?: number;
  volatilityWeight?: number;
  countsTowardAccuracy: boolean;
  phase: Phase;
  motifs: never[];
  clockSeconds?: number;
  graded: boolean;
}

export interface PlayerSummary {
  accuracy?: number;
  accuracyMode: AccuracyMode;
  accuracyByPhase: Partial<Record<Phase, number>>;
  acpl?: number;
  labelCounts: Record<Label, number>;
  gradedMoves: number;
  ungradedMoves: number;
  countedMoves: number;
  excludedForced: number;
  excludedMissingWeight: number;
}

export interface GameReview {
  gameId: string;
  rawAnalysisId: string;
  methodologyVersion: string;
  configHash: string;
  accuracyMode: AccuracyMode;
  moves: MoveAnalysis[];
  white: PlayerSummary;
  black: PlayerSummary;
  winSeries: (number | null)[];
  phaseBoundaries: { middlegameStartPly?: number; endgameStartPly?: number };
  opening?: { eco: string; name: string; ply: number };
  turningPoint?: number;
  coverage: { total: number; analysed: number; failed: number; pending: number; complete: boolean };
  keyMoments: number[];
}

export interface DeriveInput {
  game: GameRecord;
  raw: RawAnalysis;
  index: OpeningIndex;
  config: MethodologyConfig;
}

function positionEval(result: PositionResult | null): PositionEval | undefined {
  if (result?.status === "done") return { score: result.lines[0]!.score, lines: result.lines, bestMove: result.bestMove };
  if (result?.status === "terminal") return { score: result.terminal, lines: [] };
  return undefined;
}

function sanLine(fen: Fen, pv: readonly Uci[]): San[] {
  return replayUciLine(fen, pv).moves.map((m) => m.san);
}

/** The best line shown for a position: the stored line starting with bestMove (M9), else none. */
function bestLine(before: PositionEval): EngineLine | undefined {
  return before.lines.find((line) => line.pv[0] === before.bestMove);
}

/** Turning point (AI_COACH_DESIGN §10, M13): the largest Win% swing crossing 50; earliest on ties. */
export function turningPoint(series: readonly (number | null)[]): number | undefined {
  let best: { ply: number; swing: number } | undefined;
  for (let i = 0; i + 1 < series.length; i++) {
    const a = series[i];
    const b = series[i + 1];
    if (a === null || a === undefined || b === null || b === undefined) continue;
    if ((a - 50) * (b - 50) >= 0) continue;
    const swing = Math.abs(b - a);
    if (!best || swing > best.swing) best = { ply: i + 1, swing };
  }
  return best?.ply;
}

const emptyCounts = (): Record<Label, number> => Object.fromEntries(LABELS.map((l) => [l, 0])) as Record<Label, number>;

export function deriveReview({ game, raw, index, config }: DeriveInput): GameReview {
  const n = game.plies.length;
  if (raw.gameId !== game.id) throw new Error(`Analysis ${raw.id} belongs to another game.`);
  if (raw.totalCount !== n + 1 || raw.positions.length !== n + 1) throw new Error(`Analysis ${raw.id} has ${raw.totalCount} positions; the game has ${n + 1}.`);

  const fens = positionsOf(game.startFen, game.plies);
  const evals = raw.positions.map(positionEval);
  const scores = evals.map((e) => e?.score);
  const startColor: Color = game.startFen.split(" ")[1] === "b" ? "b" : "w";

  const analysed = raw.positions.filter((p) => p?.status === "done" || p?.status === "terminal").length;
  const failed = raw.positions.filter((p) => p?.status === "failed").length;
  const pending = raw.positions.filter((p) => p === null).length;
  const coverage = { total: n + 1, analysed, failed, pending, complete: analysed === n + 1 };

  // Rules facts per move, replayed with chess.js.
  const chess = new Chess(game.startFen);
  const facts = game.plies.map((ply) => {
    const legalMoves = chess.moves().length;
    const move = chess.move(parseUci(ply.uci));
    return { legalMoves, capture: move.captured !== undefined };
  });

  const chain = bookChainLength(fens, index);
  const division = dividePhases(fens, chain > 0 ? chain : undefined, config.phases);
  const forced = facts.map((f) => f.legalMoves === 1);
  const accuracy = gameAccuracy({ scores, startColor, forced, mode: config.accuracyMode });
  const allowsSpecialLabels = raw.settings.preset !== "quick";

  const verdicts: MoveVerdict[] = [];
  const moves: MoveAnalysis[] = game.plies.map((ply, i) => {
    const before = evals[i];
    const after = evals[i + 1];
    const previous = i > 0 ? verdicts[i - 1] : undefined;
    // Wprev (§5.1): the mover's Win% at the position before the opponent's previous move, i.e.
    // position i − 1 for the move from position i.
    const prevPrev = i > 0 ? evals[i - 1] : undefined;
    let verdict = classifyMove(
      {
        color: ply.color,
        uci: ply.uci,
        fenBefore: fens[i]!,
        legalMoves: facts[i]!.legalMoves,
        bookChain: i + 1 <= chain,
        before,
        after,
        previousSeverity: previous?.severity,
        winPrev: prevPrev ? winPercent(prevPrev.score, ply.color) : undefined,
        previousMove: i > 0 ? { uci: game.plies[i - 1]!.uci, capture: facts[i - 1]!.capture } : undefined,
        analysis: { multiPv: raw.settings.multiPv, allowsSpecialLabels },
      },
      config,
      SPECIAL_RULES,
    );
    if (!before || !after) {
      const waiting = raw.positions[i] === null || raw.positions[i + 1] === null;
      verdict = { reasons: [waiting ? "pending:eval" : "missing:eval"] };
    }
    verdicts.push(verdict);

    const sign = ply.color === "w" ? 1 : -1;
    const acc = accuracy.moves[i]!;
    const analysis: MoveAnalysis = {
      plyIndex: ply.index,
      color: ply.color,
      san: ply.san,
      uci: ply.uci,
      bestLineSan: [],
      refutationSan: [],
      labelReasons: verdict.reasons,
      countsTowardAccuracy: acc.counts,
      phase: division.phases[i]!,
      motifs: [],
      graded: verdict.label !== undefined,
    };
    if (before) analysis.scoreBefore = before.score;
    if (after) analysis.scoreAfter = after.score;
    if (verdict.winBefore !== undefined) analysis.winBefore = verdict.winBefore;
    if (verdict.winAfter !== undefined) analysis.winAfter = verdict.winAfter;
    if (verdict.winLoss !== undefined) analysis.winLoss = verdict.winLoss;
    if (before && after) analysis.cpLoss = Math.max(0, (whiteCp(before.score) - whiteCp(after.score)) * sign);
    if (before?.bestMove) {
      const [san] = sanLine(fens[i]!, [before.bestMove]);
      if (san) analysis.bestMove = { uci: before.bestMove, san, winAfter: winPercent(before.score, ply.color) };
      const line = bestLine(before);
      if (line) analysis.bestLineSan = sanLine(fens[i]!, line.pv);
      const second = before.lines[1];
      const secondUci = second?.pv[0];
      if (second && secondUci) {
        const [secondSan] = sanLine(fens[i]!, [secondUci]);
        if (secondSan) analysis.secondBest = { uci: secondUci, san: secondSan, winAfter: winPercent(second.score, ply.color) };
      }
    }
    const reply = after?.lines[0];
    if (reply) analysis.refutationSan = sanLine(fens[i + 1]!, reply.pv);
    if (verdict.severity) analysis.severity = verdict.severity;
    if (verdict.label) analysis.label = verdict.label;
    if (acc.accuracy !== undefined) analysis.accuracy = acc.accuracy;
    if (acc.weight !== undefined) analysis.volatilityWeight = acc.weight;
    if (ply.clockSeconds !== undefined) analysis.clockSeconds = ply.clockSeconds;
    return analysis;
  });

  // Aggregates only once no position is still waiting for the engine (never final-looking numbers).
  const final = pending === 0;
  const phases = phaseAccuracy({ scores, startColor, forced, mode: config.accuracyMode }, division.phases);
  const acpls = acpl(scores, startColor);
  const summary = (color: Color, player: PlayerAccuracy): PlayerSummary => {
    const own = moves.filter((m) => m.color === color);
    const labelCounts = emptyCounts();
    for (const m of own) if (m.label) labelCounts[m.label]++;
    const byPhase: Partial<Record<Phase, number>> = {};
    if (final) {
      for (const phase of PHASES) {
        const p = phases[phase]?.[color === "w" ? "white" : "black"];
        if (p?.accuracy !== undefined && p.countedMoves >= config.phases.minMovesForPhaseAccuracy) byPhase[phase] = p.accuracy;
      }
    }
    const result: PlayerSummary = {
      accuracyMode: config.accuracyMode,
      accuracyByPhase: byPhase,
      labelCounts,
      gradedMoves: own.filter((m) => m.graded).length,
      ungradedMoves: own.filter((m) => !m.graded).length,
      countedMoves: player.countedMoves,
      excludedForced: player.excludedForced,
      excludedMissingWeight: player.excludedMissing,
    };
    const acplValue = color === "w" ? acpls.white : acpls.black;
    if (final && player.accuracy !== undefined) result.accuracy = player.accuracy;
    if (final && acplValue !== undefined) result.acpl = acplValue;
    return result;
  };

  const series = winSeries(scores);
  const review: GameReview = {
    gameId: game.id,
    rawAnalysisId: raw.id,
    methodologyVersion: config.version,
    configHash: configHash(config),
    accuracyMode: config.accuracyMode,
    moves,
    white: summary("w", accuracy.white),
    black: summary("b", accuracy.black),
    winSeries: series,
    phaseBoundaries: {
      ...(division.middlegameStart !== undefined ? { middlegameStartPly: division.middlegameStart } : {}),
      ...(division.endgameStart !== undefined ? { endgameStartPly: division.endgameStart } : {}),
    },
    coverage,
    keyMoments: [],
  };
  const opening = openingOf(fens, index);
  if (opening) review.opening = opening;
  if (coverage.complete) {
    const tp = turningPoint(series);
    if (tp !== undefined) review.turningPoint = tp;
  }
  return review;
}
