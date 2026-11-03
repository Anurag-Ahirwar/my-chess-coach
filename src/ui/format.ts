import type { GameResult } from "@/core/chess/types";
import type { PlayerInfo } from "@/core/game/types";

export function formatPlayer(player: PlayerInfo): string {
  return player.rating ? `${player.name} (${player.rating})` : player.name;
}

export function formatResult(result: GameResult): string {
  return result === "1/2-1/2" ? "½–½" : result === "*" ? "Unfinished" : result.replace("-", "–");
}

export function formatDate(epochMs: number | undefined): string {
  if (epochMs === undefined) return "Unknown date";
  return new Date(epochMs).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(epochMs: number | undefined): string {
  if (epochMs === undefined) return "Unknown date";
  return new Date(epochMs).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatMonth(year: number, month: number): string {
  return `${MONTHS[month - 1] ?? month} ${year}`;
}
