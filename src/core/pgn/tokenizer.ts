export interface SourcePosition {
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

export type PgnToken =
  | { type: "header"; name: string; value: string; pos: SourcePosition }
  | { type: "comment"; text: string; pos: SourcePosition }
  | { type: "nag"; value: number; pos: SourcePosition }
  | { type: "ravOpen"; pos: SourcePosition }
  | { type: "ravClose"; pos: SourcePosition }
  | { type: "moveNumber"; value: number; pos: SourcePosition }
  | { type: "san"; text: string; pos: SourcePosition }
  | { type: "result"; value: "1-0" | "0-1" | "1/2-1/2" | "*"; pos: SourcePosition }
  | { type: "error"; message: string; pos: SourcePosition };

const SYMBOL_STOP = new Set([" ", "\t", "\n", "{", "}", "(", ")", "[", "]", ";", "$", '"']);
const RESULTS = new Set(["1-0", "0-1", "1/2-1/2", "*"]);

/** Removes a UTF-8 BOM and normalises CRLF / CR line endings to LF. */
const BYTE_ORDER_MARK = 0xfeff;

export function normalisePgnText(text: string): string {
  const withoutBom = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, "\n");
}

/**
 * Splits PGN text (any number of games) into tokens with source positions.
 * It never throws: malformed input becomes `error` tokens so the parser can
 * report the exact location and carry on with the next game.
 */
export function tokenizePgn(input: string): PgnToken[] {
  const text = normalisePgnText(input);
  const tokens: PgnToken[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  const advance = (count = 1) => {
    for (let k = 0; k < count && i < text.length; k++) {
      if (text[i] === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
      i++;
    }
  };
  const here = (): SourcePosition => ({ line, column });
  const skipToEndOfLine = () => {
    while (i < text.length && text[i] !== "\n") advance();
  };

  while (i < text.length) {
    const ch = text[i] as string;

    if (ch === " " || ch === "\t" || ch === "\n") {
      advance();
      continue;
    }

    // "%" in the first column is an escape line, ignored by the PGN standard.
    if (ch === "%" && column === 1) {
      skipToEndOfLine();
      continue;
    }

    const pos = here();

    if (ch === "[") {
      const header = readHeader(text, i);
      if (header.ok) {
        tokens.push({ type: "header", name: header.name, value: header.value, pos });
        advance(header.length);
      } else {
        tokens.push({ type: "error", message: header.message, pos });
        skipToEndOfLine();
      }
      continue;
    }

    if (ch === "{") {
      const end = text.indexOf("}", i + 1);
      if (end === -1) {
        tokens.push({ type: "error", message: "Unterminated comment: missing '}'", pos });
        advance(text.length - i);
      } else {
        tokens.push({ type: "comment", text: text.slice(i + 1, end), pos });
        advance(end - i + 1);
      }
      continue;
    }

    if (ch === ";") {
      const start = i + 1;
      skipToEndOfLine();
      tokens.push({ type: "comment", text: text.slice(start, i), pos });
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "ravOpen", pos });
      advance();
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "ravClose", pos });
      advance();
      continue;
    }

    if (ch === "$") {
      let j = i + 1;
      while (j < text.length && /\d/.test(text[j] as string)) j++;
      if (j === i + 1) tokens.push({ type: "error", message: "'$' must be followed by a number", pos });
      else tokens.push({ type: "nag", value: Number(text.slice(i + 1, j)), pos });
      advance(j - i);
      continue;
    }

    if (ch === "}" || ch === "]" || ch === '"') {
      tokens.push({ type: "error", message: `Unexpected '${ch}'`, pos });
      advance();
      continue;
    }

    // A symbol: move number, SAN, result, or annotation glyphs.
    let j = i;
    while (j < text.length && !SYMBOL_STOP.has(text[j] as string)) j++;
    const symbol = text.slice(i, j);
    classifySymbol(symbol, pos, tokens);
    advance(j - i);
  }

  return tokens;
}

function classifySymbol(symbol: string, pos: SourcePosition, out: PgnToken[]): void {
  if (RESULTS.has(symbol)) {
    out.push({ type: "result", value: symbol as "1-0" | "0-1" | "1/2-1/2" | "*", pos });
    return;
  }
  if (symbol === "½-½") {
    out.push({ type: "result", value: "1/2-1/2", pos });
    return;
  }
  // Standalone annotation glyphs ("!", "?!") and dots carry no move.
  if (/^[!?]+$/.test(symbol) || /^\.+$/.test(symbol)) return;

  // "12." / "12..." optionally glued to the move: "12.Nf3", "12...e5".
  const numbered = /^(\d+)(\.+)(.*)$/.exec(symbol);
  if (numbered) {
    const [, digits, , rest] = numbered;
    out.push({ type: "moveNumber", value: Number(digits), pos });
    if (rest) {
      const restPos = { line: pos.line, column: pos.column + symbol.length - rest.length };
      classifySymbol(rest, restPos, out);
    }
    return;
  }
  out.push({ type: "san", text: symbol, pos });
}

type HeaderRead = { ok: true; name: string; value: string; length: number } | { ok: false; message: string };

function readHeader(text: string, start: number): HeaderRead {
  let j = start + 1;
  const skipSpaces = () => {
    while (text[j] === " " || text[j] === "\t") j++;
  };
  skipSpaces();
  const nameStart = j;
  while (j < text.length && /[A-Za-z0-9_]/.test(text[j] as string)) j++;
  const name = text.slice(nameStart, j);
  if (!name) return { ok: false, message: "Malformed tag: missing tag name" };
  skipSpaces();
  if (text[j] !== '"') return { ok: false, message: `Malformed tag [${name}]: missing opening quote` };
  j++;
  let value = "";
  while (j < text.length && text[j] !== '"') {
    if (text[j] === "\n") return { ok: false, message: `Malformed tag [${name}]: unterminated value` };
    if (text[j] === "\\" && (text[j + 1] === '"' || text[j + 1] === "\\")) {
      value += text[j + 1];
      j += 2;
      continue;
    }
    value += text[j];
    j++;
  }
  if (text[j] !== '"') return { ok: false, message: `Malformed tag [${name}]: unterminated value` };
  j++;
  skipSpaces();
  if (text[j] !== "]") return { ok: false, message: `Malformed tag [${name}]: missing ']'` };
  j++;
  return { ok: true, name, value, length: j - start };
}
