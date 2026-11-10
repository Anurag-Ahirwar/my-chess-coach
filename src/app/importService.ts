import { buildGameRecord } from "@/core/game/record";
import type { Color } from "@/core/chess/types";
import type { GameRecord } from "@/core/game/types";
import { describePgnError, parsePgn, type PgnError } from "@/core/pgn";
import { ChessComClient, type ChessComGame, type PastMonthCache } from "@/infra/chesscom";
import { getRepositories } from "./storage";

/** Past months are kept in IndexedDB (decision D5), or in memory if storage is unavailable. */
const storedPastMonths: PastMonthCache = {
  get: async (url) => (await getRepositories()).pastMonths.get(url),
  set: async (url, body) => (await getRepositories()).pastMonths.set(url, body),
};

export const chessComClient = new ChessComClient({ pastMonthCache: storedPastMonths });

export interface PgnImportResult {
  records: GameRecord[];
  errors: PgnError[];
}

export async function importPgnText(text: string, fileName?: string): Promise<PgnImportResult> {
  const { games, errors } = parsePgn(text);
  const source = fileName ? { kind: "pgn" as const, fileName } : { kind: "pgn" as const };
  const records = await Promise.all(games.map((game) => buildGameRecord(game, source)));
  return { records, errors };
}

export class GameImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameImportError";
  }
}

/** Builds a record from a Chess.com archive entry. Throws GameImportError if it can't be analysed. */
export async function importChessComGame(game: ChessComGame): Promise<GameRecord> {
  if (!isAnalysable(game)) throw new GameImportError(`This ${game.rules} game can't be analysed: only standard chess is supported.`);
  const { games, errors } = parsePgn(game.pgn!);
  const parsed = games[0];
  if (!parsed) {
    const first = errors[0];
    throw new GameImportError(first ? describePgnError(first) : "The game's PGN could not be read.");
  }
  return buildGameRecord(
    parsed,
    {
      kind: "chesscom",
      url: game.url,
      rules: game.rules,
      timeClass: game.time_class,
      ...(game.uuid ? { uuid: game.uuid } : {}),
      ...(game.end_time ? { endTime: game.end_time } : {}),
      ...(game.accuracies ? { reportedAccuracy: { white: game.accuracies.white, black: game.accuracies.black } } : {}),
    },
    game.pgn,
  );
}

export function isAnalysable(game: ChessComGame): boolean {
  return game.rules === "chess" && typeof game.pgn === "string" && game.pgn.length > 0;
}

const DRAW_RESULTS = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);

export type Outcome = "win" | "loss" | "draw";

export interface ChessComGameSummary {
  game: ChessComGame;
  userColor?: Color;
  /** From the user's point of view when their colour is known, otherwise White's. */
  outcome: Outcome;
  opponent: { username: string; rating?: number };
  opening?: string;
  analysable: boolean;
}

export function summariseChessComGame(game: ChessComGame, username: string): ChessComGameSummary {
  const user = username.trim().replace(/^@/, "").toLowerCase();
  const userColor: Color | undefined =
    game.white.username.toLowerCase() === user ? "w" : game.black.username.toLowerCase() === user ? "b" : undefined;
  const me = userColor === "b" ? game.black : game.white;
  const opponent = userColor === "b" ? game.white : game.black;
  const outcome: Outcome = me.result === "win" ? "win" : DRAW_RESULTS.has(me.result) ? "draw" : "loss";
  const opening = openingFromEcoUrl(game.eco);
  return {
    game,
    outcome,
    opponent: opponent.rating === undefined ? { username: opponent.username } : { username: opponent.username, rating: opponent.rating },
    analysable: isAnalysable(game),
    ...(userColor ? { userColor } : {}),
    ...(opening ? { opening } : {}),
  };
}

/** "https://www.chess.com/openings/Kings-Indian-Defense-Fianchetto..." -> "Kings Indian Defense Fianchetto...". */
export function openingFromEcoUrl(url: string | undefined): string | undefined {
  const slug = url?.split("/openings/")[1];
  if (!slug) return undefined;
  try {
    return decodeURIComponent(slug).replace(/-/g, " ").replace(/\s+/g, " ").trim() || undefined;
  } catch {
    return undefined;
  }
}
