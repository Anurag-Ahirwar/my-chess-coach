import type { Color } from "../chess/types";
import { exportPgn } from "../pgn/export";
import type { ParsedGame } from "../pgn/parse";
import type { GameRecord, GameSource, PlayerInfo, TimeControl } from "./types";

/**
 * Builds a GameRecord from a parsed PGN game. `originalPgn` is kept verbatim
 * when available (Chess.com); otherwise a normalised export is stored.
 */
export async function buildGameRecord(
  parsed: ParsedGame,
  source: GameSource,
  originalPgn?: string,
): Promise<GameRecord> {
  const headers = parsed.headers;
  const record: Omit<GameRecord, "id"> = {
    source,
    pgn: originalPgn ?? exportPgn(parsed),
    headers,
    startFen: parsed.startFen,
    plies: parsed.plies,
    white: playerFromHeaders(headers, "White"),
    black: playerFromHeaders(headers, "Black"),
    result: parsed.result,
    terminal: parsed.terminal,
    warnings: parsed.warnings,
    ...optional("termination", headers["Termination"]),
    ...optional("playedAt", parsePlayedAt(headers)),
    ...optional("timeControl", headers["TimeControl"] ? parseTimeControl(headers["TimeControl"]) : undefined),
  };
  return { id: await gameId(record), ...record };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

async function gameId(record: Omit<GameRecord, "id">): Promise<string> {
  if (record.source.kind === "chesscom") {
    return `cc:${record.source.uuid ?? (await sha256Hex(record.source.url)).slice(0, 32)}`;
  }
  // Identity of a PGN game = its start position and moves. The same game imported twice gets the same id.
  const identity = [record.startFen, ...record.plies.map((ply) => ply.uci)].join(" ");
  return `pgn:${(await sha256Hex(identity)).slice(0, 32)}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function playerFromHeaders(headers: Record<string, string>, side: "White" | "Black"): PlayerInfo {
  const name = headers[side]?.trim() || "?";
  const rating = Number.parseInt(headers[`${side}Elo`] ?? "", 10);
  return Number.isFinite(rating) && rating > 0 ? { name, rating } : { name };
}

/** PGN TimeControl tag: "180", "180+2", "1/86400" (daily), "-" or "?" (unknown). */
export function parseTimeControl(raw: string): TimeControl {
  const value = raw.trim();
  const live = /^(\d+)(?:\+(\d+))?$/.exec(value);
  if (live) return { kind: "live", initialSeconds: Number(live[1]), incrementSeconds: Number(live[2] ?? 0) };
  const daily = /^1\/(\d+)$/.exec(value);
  if (daily) return { kind: "daily", secondsPerMove: Number(daily[1]) };
  return { kind: "unknown", raw: value };
}

export function describeTimeControl(tc: TimeControl): string {
  switch (tc.kind) {
    case "live": {
      const minutes = tc.initialSeconds / 60;
      const base = Number.isInteger(minutes) ? `${minutes} min` : `${tc.initialSeconds} s`;
      return tc.incrementSeconds ? `${base} + ${tc.incrementSeconds} s` : base;
    }
    case "daily": {
      const days = tc.secondsPerMove / 86_400;
      return Number.isInteger(days) ? `${days} day${days === 1 ? "" : "s"} / move` : `${tc.secondsPerMove} s / move`;
    }
    case "unknown":
      return tc.raw || "Unknown";
  }
}

/** Epoch ms from UTCDate + UTCTime, falling back to Date (taken as UTC midnight). */
export function parsePlayedAt(headers: Record<string, string>): number | undefined {
  const date = parsePgnDate(headers["UTCDate"]) ?? parsePgnDate(headers["Date"]);
  if (!date) return undefined;
  // Only UTCTime is unambiguous; StartTime may be local time, so it is not used.
  const time = headers["UTCDate"] ? /^(\d{2}):(\d{2}):(\d{2})$/.exec(headers["UTCTime"] ?? "") : null;
  const [h, m, s] = time ? [Number(time[1]), Number(time[2]), Number(time[3])] : [0, 0, 0];
  return Date.UTC(date.year, date.month - 1, date.day, h, m, s);
}

function parsePgnDate(value: string | undefined): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(value ?? "");
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { year, month, day };
}

/** The colour the given username played, compared case-insensitively. */
export function resolveUserColor(game: Pick<GameRecord, "white" | "black">, username: string | undefined): Color | undefined {
  const user = username?.trim().toLowerCase();
  if (!user) return undefined;
  if (game.white.name.toLowerCase() === user) return "w";
  if (game.black.name.toLowerCase() === user) return "b";
  return undefined;
}
