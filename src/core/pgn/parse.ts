import { fenMoveInfo, moveNumberLabel, normaliseSanToken } from "../chess/notation";
import { GameReplay, STANDARD_START_FEN, checkFen } from "../chess/position";
import type { Fen, GameResult, Ply, TerminalState } from "../chess/types";
import { parseClockComment } from "./clock";
import { tokenizePgn, type PgnToken, type SourcePosition } from "./tokenizer";

export interface ParsedGame {
  /** 0-based position of the game in the source text. */
  index: number;
  /** Tag pairs in source order. */
  headers: Record<string, string>;
  startFen: Fen;
  plies: Ply[];
  result: GameResult;
  /** Rule-based state of the final position (checkmate, stalemate, draw claims). */
  terminal: TerminalState | null;
  warnings: string[];
}

export type PgnErrorKind =
  | "syntax"
  | "illegal_move"
  | "invalid_fen"
  | "unsupported_variant"
  | "unbalanced_variation";

export interface PgnError {
  gameIndex: number;
  /** "White vs Black" from the tags, or "Game N". */
  gameLabel: string;
  kind: PgnErrorKind;
  message: string;
  line: number;
  column: number;
  /** The offending move text, for illegal moves. */
  san?: string;
  /** "12." or "12...", for illegal moves. */
  moveLabel?: string;
}

export interface PgnParseResult {
  games: ParsedGame[];
  errors: PgnError[];
}

const SUPPORTED_VARIANTS = new Set(["", "standard", "chess"]);

/**
 * Parses PGN text containing any number of games. A game with an error is
 * reported in `errors` and left out of `games`; the other games still parse.
 * Variations (RAVs) and NAGs are skipped; only the main line is kept.
 */
export function parsePgn(text: string): PgnParseResult {
  const games: ParsedGame[] = [];
  const errors: PgnError[] = [];
  let builder = new GameBuilder(0);

  const finish = () => {
    const outcome = builder.finish();
    if (outcome.ok) games.push(outcome.game);
    else errors.push(outcome.error);
    builder = new GameBuilder(builder.index + 1);
  };

  for (const token of tokenizePgn(text)) {
    if (token.type === "header" && builder.movetextSeen) finish();
    const done = builder.accept(token);
    if (done) finish();
  }
  if (builder.hasContent) finish();

  return { games, errors };
}

class GameBuilder {
  readonly headers: Record<string, string> = {};
  movetextSeen = false;
  private replay: GameReplay | null = null;
  private readonly plies: Ply[] = [];
  private depth = 0;
  private movetextResult: GameResult | undefined;
  private error: PgnError | undefined;
  private readonly warnings: string[] = [];
  private firstPos: SourcePosition | undefined;

  constructor(readonly index: number) {}

  get hasContent(): boolean {
    return this.movetextSeen || this.error !== undefined || Object.keys(this.headers).length > 0;
  }

  /** Consumes a token; returns true when the token ends the game (a result in the main line). */
  accept(token: PgnToken): boolean {
    this.firstPos ??= token.pos;
    switch (token.type) {
      case "header":
        if (token.name in this.headers) this.warnings.push(`Duplicate tag [${token.name}]; the last value is used.`);
        this.headers[token.name] = token.value;
        return false;
      case "error":
        this.fail("syntax", token.message, token.pos);
        return false;
      case "comment":
        this.movetextSeen ||= this.plies.length > 0;
        if (this.depth === 0) this.attachComment(token.text);
        return false;
      case "nag":
      case "moveNumber":
        this.movetextSeen = true;
        return false;
      case "ravOpen":
        this.movetextSeen = true;
        this.depth++;
        return false;
      case "ravClose":
        if (this.depth === 0) this.fail("unbalanced_variation", "Unexpected ')' without a matching '('", token.pos);
        else this.depth--;
        return false;
      case "san":
        this.movetextSeen = true;
        if (this.depth === 0) this.playMove(token.text, token.pos);
        return false;
      case "result":
        this.movetextSeen = true;
        if (this.depth > 0) return false; // a result inside a variation is not the game result
        this.movetextResult = token.value;
        return true;
    }
  }

  finish(): { ok: true; game: ParsedGame } | { ok: false; error: PgnError } {
    const pos = this.firstPos ?? { line: 1, column: 1 };
    if (!this.error && this.depth > 0) this.fail("unbalanced_variation", "Variation is missing its closing ')'", pos);
    if (!this.error && !this.replay) this.startReplay(pos);
    if (this.error || !this.replay) return { ok: false, error: this.error ?? this.makeError("syntax", "Empty game", pos) };

    const headerResult = this.headers["Result"];
    const result = this.movetextResult ?? (isResult(headerResult) ? headerResult : "*");
    if (this.movetextResult && isResult(headerResult) && headerResult !== this.movetextResult) {
      this.warnings.push(`The Result tag (${headerResult}) differs from the movetext result (${this.movetextResult}).`);
    }
    return {
      ok: true,
      game: {
        index: this.index,
        headers: this.headers,
        startFen: this.replay.startFen,
        plies: this.plies,
        result,
        terminal: this.replay.terminalState(),
        warnings: this.warnings,
      },
    };
  }

  private playMove(text: string, pos: SourcePosition) {
    if (this.error) return;
    if (!this.replay && !this.startReplay(pos)) return;
    const replay = this.replay as GameReplay;
    const before = fenMoveInfo(replay.fen);
    try {
      const move = replay.playSan(normaliseSanToken(text));
      this.plies.push({ index: this.plies.length + 1, ...move });
    } catch {
      const moveLabel = moveNumberLabel(before.fullmove, before.turn);
      const side = before.turn === "w" ? "White" : "Black";
      this.fail("illegal_move", `Illegal or unreadable move "${text}" at ${moveLabel} (${side} to move)`, pos, {
        san: text,
        moveLabel,
      });
    }
  }

  private startReplay(pos: SourcePosition): boolean {
    const variant = (this.headers["Variant"] ?? "").trim().toLowerCase();
    if (!SUPPORTED_VARIANTS.has(variant)) {
      this.fail("unsupported_variant", `Variant "${this.headers["Variant"]}" is not supported (standard chess only)`, pos);
      return false;
    }
    const fen = this.headers["FEN"]?.trim() || STANDARD_START_FEN;
    const check = checkFen(fen);
    if (!check.ok) {
      this.fail("invalid_fen", `Invalid FEN tag: ${check.error}`, pos);
      return false;
    }
    this.replay = new GameReplay(fen);
    return true;
  }

  private attachComment(text: string) {
    const last = this.plies.at(-1);
    if (!last || last.clockSeconds !== undefined) return;
    const clock = parseClockComment(text);
    if (clock !== undefined) last.clockSeconds = clock;
  }

  private fail(kind: PgnErrorKind, message: string, pos: SourcePosition, extra: Partial<PgnError> = {}) {
    this.error ??= { ...this.makeError(kind, message, pos), ...extra };
  }

  private makeError(kind: PgnErrorKind, message: string, pos: SourcePosition): PgnError {
    return { gameIndex: this.index, gameLabel: this.label(), kind, message, line: pos.line, column: pos.column };
  }

  private label(): string {
    const white = this.headers["White"];
    const black = this.headers["Black"];
    return white || black ? `${white ?? "?"} vs ${black ?? "?"}` : `Game ${this.index + 1}`;
  }
}

function isResult(value: string | undefined): value is GameResult {
  return value === "1-0" || value === "0-1" || value === "1/2-1/2" || value === "*";
}

/** One-line, human-readable form of a parse error, including its location. */
export function describePgnError(error: PgnError): string {
  return `Game ${error.gameIndex + 1} (${error.gameLabel}), line ${error.line}, column ${error.column}: ${error.message}`;
}
