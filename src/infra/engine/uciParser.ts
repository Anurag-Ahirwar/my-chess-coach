import type { Color, Uci } from "@/core/chess/types";
import { MAX_PV_PLIES, type EngineLine, type Score, type Wdl } from "@/core/engine/types";

/**
 * Pure UCI output parser (docs/TECHNICAL_ARCHITECTURE.md §6.1). No Worker dependency.
 * Scores and WDL are converted from the side to move's perspective to WHITE's
 * perspective here, and nowhere else.
 */

export interface UciInfo {
  depth?: number;
  selDepth?: number;
  /** 1-based; defaults to 1 when the engine omits it. */
  multiPv: number;
  /** White's perspective. A `mate 0` from the engine is kept as moves 0 and flagged by the accumulator. */
  score?: { kind: "cp"; value: number } | { kind: "mate"; moves: number };
  bound?: "lower" | "upper";
  /** White's perspective. */
  wdl?: Wdl;
  nodes?: number;
  nps?: number;
  timeMs?: number;
  pv?: Uci[];
  /** Text of an `info string …` line. */
  string?: string;
}

export type UciEvent =
  | { type: "id"; field: "name" | "author"; value: string }
  | { type: "option"; name: string; default?: string }
  | { type: "uciok" }
  | { type: "readyok" }
  | { type: "info"; info: UciInfo }
  | { type: "bestmove"; move: Uci | null; ponder?: Uci }
  | { type: "unknown"; line: string };

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const INTEGER = /^-?\d+$/;

/** Parses one line of engine output. Never throws: anything unrecognised is `unknown`. */
export function parseUciLine(line: string, sideToMove: Color): UciEvent {
  const text = line.trim();
  if (text === "uciok") return { type: "uciok" };
  if (text === "readyok") return { type: "readyok" };

  const tokens = text.split(/\s+/);
  const command = tokens[0] ?? "";
  switch (command) {
    case "id":
      if ((tokens[1] === "name" || tokens[1] === "author") && tokens.length > 2) {
        return { type: "id", field: tokens[1], value: tokens.slice(2).join(" ") };
      }
      break;
    case "option":
      return parseOption(text) ?? { type: "unknown", line };
    case "bestmove":
      return parseBestMove(tokens) ?? { type: "unknown", line };
    case "info":
      return parseInfo(tokens, sideToMove) ?? { type: "unknown", line };
  }
  return { type: "unknown", line };
}

function parseOption(text: string): UciEvent | undefined {
  const match = /^option name (.+?) type \S+(?: default (.*?))?(?: min .*| max .*| var .*)?$/.exec(text);
  if (!match) return undefined;
  const name = match[1]!;
  const value = match[2];
  return value === undefined || value === "" ? { type: "option", name } : { type: "option", name, default: value };
}

function parseBestMove(tokens: string[]): UciEvent | undefined {
  const move = tokens[1];
  if (move === "(none)") return { type: "bestmove", move: null };
  if (!move || !UCI_MOVE.test(move)) return undefined;
  const ponder = tokens[2] === "ponder" && tokens[3] && UCI_MOVE.test(tokens[3]) ? tokens[3] : undefined;
  return ponder ? { type: "bestmove", move, ponder } : { type: "bestmove", move };
}

const INTEGER_FIELDS = {
  depth: "depth",
  seldepth: "selDepth",
  multipv: "multiPv",
  nodes: "nodes",
  nps: "nps",
  time: "timeMs",
} as const;

/** Fields that take one value we don't use. */
const SKIPPED_ONE = new Set(["hashfull", "tbhits", "currmove", "currmovenumber", "cpuload", "refutation", "currline"]);

function parseInfo(tokens: string[], sideToMove: Color): UciEvent | undefined {
  const info: UciInfo = { multiPv: 1 };
  const sign = sideToMove === "w" ? 1 : -1;
  let i = 1;
  while (i < tokens.length) {
    const key = tokens[i]!;
    if (key === "string") {
      info.string = tokens.slice(i + 1).join(" ");
      break;
    }
    if (key in INTEGER_FIELDS) {
      const value = tokens[i + 1];
      if (value === undefined || !INTEGER.test(value)) return undefined;
      info[INTEGER_FIELDS[key as keyof typeof INTEGER_FIELDS]] = Number(value);
      i += 2;
      continue;
    }
    if (key === "score") {
      const kind = tokens[i + 1];
      const value = tokens[i + 2];
      if ((kind !== "cp" && kind !== "mate") || value === undefined || !INTEGER.test(value)) return undefined;
      // `+ 0` turns -0 into 0 for a mate-0 seen from Black.
      const white = Number(value) * sign + 0;
      info.score = kind === "cp" ? { kind: "cp", value: white } : { kind: "mate", moves: white };
      i += 3;
      if (tokens[i] === "lowerbound" || tokens[i] === "upperbound") {
        // Bounds are from the side to move's view, so they swap for Black; the accumulator discards both.
        info.bound = tokens[i] === "lowerbound" ? (sign > 0 ? "lower" : "upper") : sign > 0 ? "upper" : "lower";
        i++;
      }
      continue;
    }
    if (key === "wdl") {
      const values = tokens.slice(i + 1, i + 4);
      if (values.length < 3 || !values.every((v) => INTEGER.test(v))) return undefined;
      const [w, d, l] = values.map(Number) as Wdl;
      info.wdl = sideToMove === "w" ? [w, d, l] : [l, d, w];
      i += 4;
      continue;
    }
    if (key === "pv") {
      const moves = tokens.slice(i + 1);
      if (!moves.every((m) => UCI_MOVE.test(m))) return undefined;
      info.pv = moves;
      break;
    }
    if (SKIPPED_ONE.has(key)) {
      i += 2;
      continue;
    }
    // Unknown key: skip it alone so a future field doesn't break parsing.
    i++;
  }
  return { type: "info", info };
}

/**
 * Collects the result of one search: for each MultiPV index, the last line with an
 * exact score (bound lines are discarded). A search interrupted by its node limit can
 * leave some lines at the previous depth; each line keeps its own depth.
 */
export class SearchAccumulator {
  private readonly lines = new Map<number, EngineLine>();
  readonly anomalies: string[] = [];

  add(info: UciInfo): void {
    // Checked first: Stockfish reports a mated root as "info depth 0 score mate 0" with no nodes field.
    if (info.score?.kind === "mate" && info.score.moves === 0) {
      this.anomalies.push("engine reported mate 0 (position should have been resolved by rules)");
      return;
    }
    if (!info.score || info.bound || info.depth === undefined || info.nodes === undefined) return;
    const score: Score = info.score;
    const line: EngineLine = {
      rank: info.multiPv,
      score,
      depth: info.depth,
      nodes: info.nodes,
      pv: (info.pv ?? []).slice(0, MAX_PV_PLIES),
      ...(info.wdl ? { wdl: info.wdl } : {}),
      ...(info.selDepth !== undefined ? { selDepth: info.selDepth } : {}),
    };
    this.lines.set(info.multiPv, line);
  }

  /** Lines ordered by rank. */
  result(): EngineLine[] {
    return [...this.lines.values()].sort((a, b) => a.rank - b.rank);
  }
}
