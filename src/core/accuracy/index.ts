import type { Color } from "../chess/types";
import type { Score } from "../engine/types";
import { whiteCp, winPercent } from "../eval";
import { LICHESS_ACCURACY_V1, type AccuracyMode } from "../methodology/v1";

/**
 * Move, game and phase accuracy and ACPL (docs/CHESS_ANALYSIS_METHODOLOGY.md §6), a
 * re-implementation of lila's AccuracyPercent / AccuracyCP from the documented formulas.
 * Positions are indexed 0..n; move i goes from position i to i + 1.
 */

const L = LICHESS_ACCURACY_V1;

/** §6.1: accuracy of one move from the mover's Win% before and after. */
export function moveAccuracy(winBefore: number, winAfter: number): number {
  if (winAfter >= winBefore) return 100;
  const raw = L.accA * Math.exp(-L.accK * (winBefore - winAfter)) + L.accB + L.uncertaintyBonus;
  return Math.max(0, Math.min(100, raw));
}

/** §6.2 step 2: ws = clamp(floor(n / 10), 2, 8), n = number of positions − 1. */
export function windowSize(positionCount: number): number {
  const n = Math.max(0, positionCount - 1);
  return Math.max(L.windowMin, Math.min(L.windowMax, Math.floor(n / L.windowDivisor)));
}

/**
 * §6.2 step 3: one window (a list of position indices) per move, exactly lila's
 * `List.fill(lead)(take(ws)) ::: sliding(ws)`; a series shorter than ws is one window.
 */
export function volatilityWindows(positionCount: number): number[][] {
  const moves = Math.max(0, positionCount - 1);
  const ws = windowSize(positionCount);
  const all = Array.from({ length: positionCount }, (_, i) => i);
  const lead = Math.max(0, Math.min(ws, positionCount) - 2);
  const windows: number[][] = [];
  for (let i = 0; i < lead; i++) windows.push(all.slice(0, ws));
  if (positionCount < ws) windows.push(all);
  else for (let start = 0; start + ws <= positionCount; start++) windows.push(all.slice(start, start + ws));
  return windows.slice(0, moves);
}

/** Population standard deviation (divides by the count). */
export function populationSd(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
}

export interface AccuracyInput {
  /** White-perspective score per position 0..n; undefined where the evaluation is missing. */
  scores: readonly (Score | undefined)[];
  /** Side to move at position 0. */
  startColor: Color;
  /** Per move: the only legal move (excluded from aggregation in default mode, §6.3). */
  forced?: readonly boolean[];
  mode: AccuracyMode;
}

export interface MoveAccuracy {
  color: Color;
  /** §6.1; undefined if either evaluation is missing. */
  accuracy?: number;
  /** Volatility weight; undefined if any position in the window is missing (§6.2 step 4). */
  weight?: number;
  forced: boolean;
  /** Has both an accuracy and a weight, and is not a Forced move in default mode (§6.2 step 7, §6.3). */
  counts: boolean;
}

export interface PlayerAccuracy {
  /** (weighted + harmonic) / 2, full precision; undefined with no counted moves. */
  accuracy?: number;
  weighted?: number;
  harmonic?: number;
  countedMoves: number;
  /** Forced moves left out (default mode only). */
  excludedForced: number;
  /** Moves left out because their accuracy or weight is missing (§6.4). */
  excludedMissing: number;
}

export interface GameAccuracy {
  windowSize: number;
  moves: MoveAccuracy[];
  white: PlayerAccuracy;
  black: PlayerAccuracy;
}

function aggregate(moves: readonly MoveAccuracy[], color: Color): PlayerAccuracy {
  const own = moves.filter((m) => m.color === color);
  const counted = own.filter((m) => m.counts);
  const result: PlayerAccuracy = {
    countedMoves: counted.length,
    excludedForced: own.filter((m) => !m.counts && m.forced && m.accuracy !== undefined && m.weight !== undefined).length,
    excludedMissing: own.filter((m) => m.accuracy === undefined || m.weight === undefined).length,
  };
  if (counted.length === 0) return result;
  const weightSum = counted.reduce((sum, m) => sum + m.weight!, 0);
  if (weightSum === 0) return result;
  const weighted = counted.reduce((sum, m) => sum + m.accuracy! * m.weight!, 0) / weightSum;
  const harmonic = counted.length / counted.reduce((sum, m) => sum + 1 / Math.max(L.harmonicFloor, m.accuracy!), 0);
  return { ...result, weighted, harmonic, accuracy: (weighted + harmonic) / 2 };
}

const opposite = (color: Color): Color => (color === "w" ? "b" : "w");

/** §6.2–§6.4: game accuracy per player. */
export function gameAccuracy(input: AccuracyInput): GameAccuracy {
  const wins = input.scores.map((score) => (score === undefined ? undefined : winPercent(score, "w")));
  const windows = volatilityWindows(wins.length);
  const moves: MoveAccuracy[] = windows.map((window, i) => {
    const color = i % 2 === 0 ? input.startColor : opposite(input.startColor);
    const before = wins[i];
    const after = wins[i + 1];
    const forced = input.forced?.[i] === true;
    const move: MoveAccuracy = { color, forced, counts: false };
    if (before !== undefined && after !== undefined) {
      move.accuracy = color === "w" ? moveAccuracy(before, after) : moveAccuracy(100 - before, 100 - after);
    }
    const values = window.map((k) => wins[k]);
    if (values.every((v): v is number => v !== undefined)) {
      move.weight = Math.max(L.weightMin, Math.min(L.weightMax, populationSd(values)));
    }
    move.counts = move.accuracy !== undefined && move.weight !== undefined && !(forced && input.mode === "default");
    return move;
  });
  return { windowSize: windowSize(wins.length), moves, white: aggregate(moves, "w"), black: aggregate(moves, "b") };
}

/**
 * Lichess reports accuracy for neither player when either has none (testing §4.5 layer 3).
 * Used only by the compatibility tests.
 */
export function lichessPair(result: GameAccuracy): { white: number; black: number } | undefined {
  const { white, black } = result;
  return white.accuracy === undefined || black.accuracy === undefined ? undefined : { white: white.accuracy, black: black.accuracy };
}

export type Phase = "opening" | "middlegame" | "endgame";
export const PHASES: readonly Phase[] = ["opening", "middlegame", "endgame"];

/** One phase's accuracy per player, with the number of counted moves (§6.5). */
export interface PhaseAccuracy {
  /** First and last position index of the slice. */
  slice: [number, number];
  white: PlayerAccuracy;
  black: PlayerAccuracy;
}

/**
 * §6.5: for each phase, the positions where the position itself or the next one belongs to the
 * phase (lila's slicing, which includes the boundary position), run through §6.2 with the side
 * to move at the slice's first position. Display requires ≥ minMoves counted moves.
 */
export function phaseAccuracy(input: AccuracyInput, phaseOfPosition: readonly Phase[]): Partial<Record<Phase, PhaseAccuracy>> {
  const result: Partial<Record<Phase, PhaseAccuracy>> = {};
  for (const phase of PHASES) {
    const members: number[] = [];
    for (let k = 0; k < input.scores.length; k++) {
      if (phaseOfPosition[k] === phase || phaseOfPosition[k + 1] === phase) members.push(k);
    }
    if (members.length < 2) continue;
    const first = members[0]!;
    const last = members[members.length - 1]!;
    const startColor = first % 2 === 0 ? input.startColor : opposite(input.startColor);
    const slice = gameAccuracy({
      scores: input.scores.slice(first, last + 1),
      startColor,
      ...(input.forced ? { forced: input.forced.slice(first, last) } : {}),
      mode: input.mode,
    });
    result[phase] = { slice: [first, last], white: slice.white, black: slice.black };
  }
  return result;
}

/**
 * §6.6 ACPL (lila AccuracyCP): per move, the ceiled White-POV scores before and after, loss
 * max(0, (after − before) × (White ? −1 : +1)); the mean over the player's moves where both
 * scores exist, rounded to the nearest integer. Every move counts, Forced moves included.
 */
export function acpl(scores: readonly (Score | undefined)[], startColor: Color): { white?: number; black?: number } {
  const losses: Record<Color, number[]> = { w: [], b: [] };
  for (let i = 0; i + 1 < scores.length; i++) {
    const before = scores[i];
    const after = scores[i + 1];
    if (before === undefined || after === undefined) continue;
    const color = i % 2 === 0 ? startColor : opposite(startColor);
    losses[color].push(Math.max(0, (whiteCp(after) - whiteCp(before)) * (color === "w" ? -1 : 1)));
  }
  const mean = (values: number[]) => (values.length === 0 ? undefined : Math.round(values.reduce((s, v) => s + v, 0) / values.length));
  const white = mean(losses.w);
  const black = mean(losses.b);
  return { ...(white !== undefined ? { white } : {}), ...(black !== undefined ? { black } : {}) };
}
