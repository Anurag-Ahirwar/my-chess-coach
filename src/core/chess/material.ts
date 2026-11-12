import type { Color, Fen } from "./types";

/** Material values (methodology §5.10 `material`, §5.11). Kings count 0. */
export interface MaterialValues {
  readonly p: number;
  readonly n: number;
  readonly b: number;
  readonly r: number;
  readonly q: number;
}

export type PieceType = "p" | "n" | "b" | "r" | "q" | "k";

/** Piece counts per side, read from a FEN's placement field. */
export interface PieceCounts {
  w: Record<PieceType, number>;
  b: Record<PieceType, number>;
  /** Pieces of each side on its own first rank (rank 1 for White, rank 8 for Black), any type. */
  backRank: { w: number; b: number };
}

const empty = (): Record<PieceType, number> => ({ p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 });

export function pieceCounts(fen: Fen): PieceCounts {
  const placement = fen.trim().split(/\s+/)[0] ?? "";
  const ranks = placement.split("/");
  if (ranks.length !== 8) throw new RangeError(`Invalid FEN placement "${placement}"`);
  const counts: PieceCounts = { w: empty(), b: empty(), backRank: { w: 0, b: 0 } };
  ranks.forEach((rank, i) => {
    for (const char of rank) {
      if (/[1-8]/.test(char)) continue;
      const lower = char.toLowerCase() as PieceType;
      if (!"pnbrqk".includes(lower)) throw new RangeError(`Invalid piece "${char}" in FEN`);
      const color: Color = char === lower ? "b" : "w";
      counts[color][lower]++;
      if (color === "b" && i === 0) counts.backRank.b++;
      if (color === "w" && i === 7) counts.backRank.w++;
    }
  });
  return counts;
}

/** Knights, bishops, rooks and queens of both sides (methodology §7 "pieces"). */
export function majorsAndMinors(counts: PieceCounts): number {
  return (["w", "b"] as const).reduce((sum, c) => sum + counts[c].n + counts[c].b + counts[c].r + counts[c].q, 0);
}

export function materialOf(counts: PieceCounts, color: Color, values: MaterialValues): number {
  const side = counts[color];
  return side.p * values.p + side.n * values.n + side.b * values.b + side.r * values.r + side.q * values.q;
}

/** Material balance for `color`: its material minus the opponent's (methodology §5.11). */
export function materialBalance(fen: Fen, color: Color, values: MaterialValues): number {
  const counts = pieceCounts(fen);
  return materialOf(counts, color, values) - materialOf(counts, color === "w" ? "b" : "w", values);
}
