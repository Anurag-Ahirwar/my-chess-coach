import { fenMoveInfo, moveNumberLabel } from "../chess/notation";
import { STANDARD_START_FEN } from "../chess/position";
import type { Fen, GameResult, Ply } from "../chess/types";
import { formatClock } from "./clock";

export interface ExportableGame {
  headers: Record<string, string>;
  startFen: Fen;
  plies: readonly Ply[];
  result: GameResult;
}

export interface PgnExportOptions {
  /** Write `{[%clk …]}` after each move that has a clock value. Default true. */
  includeClock?: boolean;
  /** Maximum movetext line width. Default 80 (the PGN export-format convention). */
  maxLineWidth?: number;
}

const SEVEN_TAG_ROSTER: readonly [string, string][] = [
  ["Event", "?"],
  ["Site", "?"],
  ["Date", "????.??.??"],
  ["Round", "?"],
  ["White", "?"],
  ["Black", "?"],
  ["Result", "*"],
];

export function exportPgn(game: ExportableGame, options: PgnExportOptions = {}): string {
  const { includeClock = true, maxLineWidth = 80 } = options;
  return `${exportHeaders(game)}\n\n${exportMovetext(game, includeClock, maxLineWidth)}\n`;
}

function exportHeaders(game: ExportableGame): string {
  const tags = new Map<string, string>();
  for (const [name, fallback] of SEVEN_TAG_ROSTER) tags.set(name, game.headers[name] ?? fallback);
  tags.set("Result", game.result);
  for (const [name, value] of Object.entries(game.headers)) {
    if (!tags.has(name) && name !== "SetUp" && name !== "FEN") tags.set(name, value);
  }
  if (game.startFen !== STANDARD_START_FEN) {
    tags.set("SetUp", "1");
    tags.set("FEN", game.startFen);
  }
  return [...tags].map(([name, value]) => `[${name} "${escapeTagValue(value)}"]`).join("\n");
}

function escapeTagValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function exportMovetext(game: ExportableGame, includeClock: boolean, maxLineWidth: number): string {
  const tokens: string[] = [];
  let { fullmove } = fenMoveInfo(game.startFen);
  let needsNumber = true;

  for (const ply of game.plies) {
    if (ply.color === "w") tokens.push(moveNumberLabel(fullmove, "w"));
    else if (needsNumber) tokens.push(moveNumberLabel(fullmove, "b"));
    tokens.push(ply.san);
    needsNumber = false;
    if (includeClock && ply.clockSeconds !== undefined) {
      tokens.push(`{[%clk ${formatClock(ply.clockSeconds)}]}`);
      needsNumber = true; // after a comment, a Black move repeats its number ("12...")
    }
    if (ply.color === "b") fullmove++;
  }
  tokens.push(game.result);
  return wrap(tokens, maxLineWidth);
}

function wrap(tokens: readonly string[], maxLineWidth: number): string {
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    if (line && line.length + 1 + token.length > maxLineWidth) {
      lines.push(line);
      line = token;
    } else {
      line = line ? `${line} ${token}` : token;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}
