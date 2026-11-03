import type { Epd, Fen, Uci } from "./types";

export interface UciParts {
  from: string;
  to: string;
  promotion?: "q" | "r" | "b" | "n";
}

const UCI_PATTERN = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;
const SQUARE_PATTERN = /^[a-h][1-8]$/;

export function isSquare(value: string): boolean {
  return SQUARE_PATTERN.test(value);
}

export function parseUci(uci: Uci): UciParts | null {
  const match = UCI_PATTERN.exec(uci);
  if (!match) return null;
  const [, from, to, promotion] = match;
  if (from === undefined || to === undefined || from === to) return null;
  return promotion === undefined ? { from, to } : { from, to, promotion: promotion as "q" | "r" | "b" | "n" };
}

export function toUci(move: { from: string; to: string; promotion?: string | undefined }): Uci {
  return `${move.from}${move.to}${move.promotion ?? ""}`;
}

export function toEpd(fen: Fen): Epd {
  return fen.trim().split(/\s+/).slice(0, 4).join(" ");
}

/** Full-move number and side to move, read from a FEN. */
export function fenMoveInfo(fen: Fen): { fullmove: number; turn: "w" | "b" } {
  const fields = fen.trim().split(/\s+/);
  const turn = fields[1] === "b" ? "b" : "w";
  const fullmove = Number.parseInt(fields[5] ?? "1", 10);
  return { turn, fullmove: Number.isFinite(fullmove) && fullmove > 0 ? fullmove : 1 };
}

const ANNOTATION_SUFFIX = /[!?]+$/;

/**
 * Normalises a SAN token from PGN movetext before it is handed to chess.js:
 * strips annotation glyphs ("e4!?") and converts zero-castling ("0-0") to "O-O".
 */
export function normaliseSanToken(token: string): string {
  let san = token.replace(ANNOTATION_SUFFIX, "");
  if (/^0-0-0[+#]?$/.test(san)) san = san.replace("0-0-0", "O-O-O");
  else if (/^0-0[+#]?$/.test(san)) san = san.replace("0-0", "O-O");
  return san;
}

/** "12." for White, "12..." for Black. */
export function moveNumberLabel(fullmove: number, color: "w" | "b"): string {
  return color === "w" ? `${fullmove}.` : `${fullmove}...`;
}
