import { GameReplay, STANDARD_START_FEN } from "@/core/chess/position";
import type { Ply } from "@/core/chess/types";
import { buildGameRecord } from "@/core/game/record";
import type { GameRecord } from "@/core/game/types";
import { parsePgn } from "@/core/pgn";

/** Builds a GameRecord from a start FEN and UCI moves, through the same code as a PGN import. */
export async function gameFromUci(moves: readonly string[], startFen = STANDARD_START_FEN): Promise<GameRecord> {
  const replay = new GameReplay(startFen);
  const plies: Ply[] = moves.map((uci, i) => ({ index: i + 1, ...replay.playUci(uci) }));
  return buildGameRecord(
    { index: 0, headers: {}, startFen, plies, result: "*", terminal: replay.terminalState(), warnings: [] },
    { kind: "pgn" },
  );
}

export async function gameFromPgn(pgn: string): Promise<GameRecord> {
  const { games, errors } = parsePgn(pgn);
  if (!games[0]) throw new Error(`Bad test PGN: ${JSON.stringify(errors)}`);
  return buildGameRecord(games[0], { kind: "pgn" });
}
