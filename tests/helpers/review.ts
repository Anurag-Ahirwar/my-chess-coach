import { Chess } from "chess.js";
import { PRESETS, type PositionResult, type RawAnalysis } from "@/core/engine/analysis";
import { terminalScore } from "@/core/engine/jobs";
import type { EngineLine, Score } from "@/core/engine/types";
import type { GameRecord } from "@/core/game/types";

/** Hand-written engine data for one position: a score, the bestmove and an optional second line. */
export interface SyntheticPosition {
  score: Score;
  best?: string;
  second?: { uci: string; score: Score };
  status?: "failed" | "pending";
}

const line = (rank: number, score: Score, pv: string[]): EngineLine => ({ rank, score, depth: 20, nodes: 1, pv });

/**
 * A RawAnalysis for a game built from synthetic scores (TEST HELPER). A position whose best move
 * isn't given uses its first legal move. The final position uses the rules (D6) when terminal.
 */
export function rawFromScores(game: GameRecord, positions: readonly SyntheticPosition[], preset: "quick" | "standard" = "standard"): RawAnalysis {
  const fens = [game.startFen, ...game.plies.map((p) => p.fenAfter)];
  const results: (PositionResult | null)[] = fens.map((fen, k) => {
    const terminal = terminalScore(game, k);
    if (terminal) return { positionIndex: k, status: "terminal", terminal, lines: [] };
    const spec = positions[k];
    if (!spec || spec.status === "pending") return null;
    if (spec.status === "failed") return { positionIndex: k, status: "failed", error: "synthetic failure", lines: [] };
    const legal = new Chess(fen).moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion ?? ""}`);
    const best = spec.best ?? legal[0]!;
    const lines = [line(1, spec.score, [best])];
    if (preset !== "quick" && spec.second) lines.push(line(2, spec.second.score, [spec.second.uci]));
    return { positionIndex: k, status: "done", lines, bestMove: best, timeMs: 0 };
  });
  const complete = results.every((r) => r?.status === "done" || r?.status === "terminal");
  return {
    id: `${game.id}|test|${preset}`,
    schemaVersion: 1,
    gameId: game.id,
    engine: { name: "stockfish", version: "19.0.1", flavour: "lite-single" },
    settings: { ...PRESETS[preset] },
    settingsHash: "0000000000000000",
    positions: results,
    completedCount: results.filter((r) => r?.status === "done" || r?.status === "terminal").length,
    totalCount: fens.length,
    startedAt: 0,
    ...(complete ? { completedAt: 0 } : {}),
  };
}

/** Mirror a FEN: ranks flipped, colours swapped (methodology §2.2 test invariant). */
export function mirrorFen(fen: string): string {
  const [placement, side, castling, ep, half, full] = fen.split(" ");
  const swapCase = (s: string) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");
  const ranks = placement!.split("/").reverse().map(swapCase).join("/");
  const rights = castling === "-" ? "-" : ["K", "Q", "k", "q"].filter((r) => swapCase(castling!).includes(r)).join("") || "-";
  const epSquare = ep === "-" ? "-" : `${ep![0]}${9 - Number(ep![1])}`;
  return [ranks, side === "w" ? "b" : "w", rights, epSquare, half, full].join(" ");
}

export const mirrorUci = (uci: string): string => `${uci[0]}${9 - Number(uci[1])}${uci[2]}${9 - Number(uci[3])}${uci.slice(4)}`;

export function negate(score: Score): Score {
  if (score.kind === "cp") return { kind: "cp", value: -score.value + 0 };
  if (score.kind === "mate") return { kind: "mate", moves: -score.moves };
  return { kind: "terminal", result: score.result === "1-0" ? "0-1" : score.result === "0-1" ? "1-0" : "1/2-1/2" };
}
