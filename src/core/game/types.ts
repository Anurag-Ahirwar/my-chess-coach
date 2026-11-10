import type { Color, Fen, GameResult, Ply, TerminalState } from "../chess/types";

export type GameSource =
  | {
      kind: "chesscom";
      url: string;
      uuid?: string;
      timeClass?: string;
      rules: string;
      endTime?: number;
      /** Chess.com's own accuracy when it has computed one. Shown only if the user opts in (U6). */
      reportedAccuracy?: { white: number; black: number };
    }
  | { kind: "pgn"; fileName?: string };

export type TimeControl =
  | { kind: "live"; initialSeconds: number; incrementSeconds: number }
  | { kind: "daily"; secondsPerMove: number }
  | { kind: "unknown"; raw: string };

export interface PlayerInfo {
  name: string;
  rating?: number;
}

export interface GameRecord {
  /** "cc:<uuid>" for Chess.com games, "pgn:<sha-256 prefix>" for PGN imports. */
  id: string;
  source: GameSource;
  /** PGN text for export: the original for Chess.com games, a normalised export for file imports. */
  pgn: string;
  headers: Record<string, string>;
  startFen: Fen;
  plies: Ply[];
  white: PlayerInfo;
  black: PlayerInfo;
  result: GameResult;
  termination?: string;
  /** Epoch milliseconds, from UTCDate/UTCTime (or Date) tags. */
  playedAt?: number;
  timeControl?: TimeControl;
  terminal: TerminalState | null;
  warnings: string[];
}

/**
 * A game as stored in IndexedDB (decision D2): the Phase 1 record plus a schema version and
 * timestamps. `userColor`, `opening` and `tags` are not stored: the first is derived from the
 * username preference at render time, the others belong to later phases.
 */
export interface StoredGame extends GameRecord {
  schemaVersion: 1;
  /** First import. Kept when the same game is imported again. */
  createdAt: number;
  /** Latest import. */
  updatedAt: number;
}

export type { Color };
