#!/usr/bin/env node
/**
 * Builds the opening index (docs/CHESS_ANALYSIS_METHODOLOGY.md §5.8, architecture D13) from the
 * pinned Lichess `chess-openings` dataset (CC0) in data/openings/.
 *
 * For every named line it replays the moves with chess.js and records the EPD of every position
 * along the line (the Book set) and the name and ECO of the line's end position. EPDs are the
 * first four fields of chess.js's FEN, exactly like the app's toEpd(), so the en passant field
 * follows the same rule on both sides.
 *
 * When two named lines end in the same position, the shorter line's name wins, then the first in
 * dataset order (a.tsv … e.tsv, top to bottom). Deterministic: the same input gives byte-identical
 * output.
 *
 * Usage: node scripts/build-openings.mjs [--out <file>]   (prints statistics; writes JSON with --out)
 * Plain Node + chess.js, no app imports (decision D9).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";

export const OPENINGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "openings");

/** The pinned dataset: commit and SHA-256 of each file as committed (LF line endings). */
export const PINNED = {
  source: "lichess-org/chess-openings",
  commit: "3ba6b20d31b2e6125cb0e6a2e792f400717d9d39",
  files: {
    "a.tsv": "3282e4c9155289a29224f9a85fba0decb46efa35c2fa5e39662d2ac48fb0f793",
    "b.tsv": "2744a3890879bd9dce79093147fe5b6c3a9d9d42a3388af698e67b6829be1c48",
    "c.tsv": "447bbd4b15d68067b150faf12bf66aa14b18582cf80d736aaa7c0081131806ef",
    "d.tsv": "1cf4057a8aece94f27bb3f278ad410ee2844831a642364eeceaafa091dbcceda",
    "e.tsv": "48c6f6645b031a5937c8386839debab0e2e48837251687ba1afb6369677f8546",
  },
};

const epd = (fen) => fen.split(" ").slice(0, 4).join(" ");

/** Reads and verifies the pinned TSV files; throws if any file differs from the pin. */
export function readDataset(dir = OPENINGS_DIR) {
  const rows = [];
  for (const [file, expected] of Object.entries(PINNED.files)) {
    const text = readFileSync(join(dir, file), "utf8");
    const actual = createHash("sha256").update(text, "utf8").digest("hex");
    if (actual !== expected) throw new Error(`${file} does not match the pinned dataset (sha256 ${actual}).`);
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    if (lines[0] !== "eco\tname\tpgn") throw new Error(`${file}: unexpected header "${lines[0]}"`);
    for (const line of lines.slice(1)) {
      const [eco, name, pgn] = line.split("\t");
      if (!eco || !name || !pgn) throw new Error(`${file}: malformed row "${line}"`);
      rows.push({ eco, name, pgn });
    }
  }
  return rows;
}

/** Builds the index from dataset rows (pure apart from chess.js). */
export function buildOpeningIndex(rows) {
  const book = new Set();
  const named = new Map();
  let sameEndDifferentName = 0;
  rows.forEach((row, order) => {
    const chess = new Chess();
    const sans = row.pgn.replace(/\d+\.(\.\.)?/g, " ").trim().split(/\s+/);
    for (const san of sans) {
      try {
        chess.move(san);
      } catch {
        throw new Error(`Illegal move "${san}" in ${row.eco} ${row.name}: ${row.pgn}`);
      }
      book.add(epd(chess.fen()));
    }
    const end = epd(chess.fen());
    const existing = named.get(end);
    if (existing && existing.name !== row.name) sameEndDifferentName++;
    if (!existing || sans.length < existing.plies) named.set(end, { eco: row.eco, name: row.name, plies: sans.length, order });
  });
  const names = {};
  for (const key of [...named.keys()].sort()) {
    const { eco, name } = named.get(key);
    names[key] = [eco, name];
  }
  return {
    source: PINNED.source,
    commit: PINNED.commit,
    licence: "CC0-1.0",
    lines: rows.length,
    positions: book.size,
    named: named.size,
    sameEndDifferentName,
    // Named positions are book positions too; they are listed once, in `names`.
    book: [...book].filter((key) => !named.has(key)).sort(),
    names,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const outIndex = process.argv.indexOf("--out");
  const index = buildOpeningIndex(readDataset());
  const json = JSON.stringify(index);
  console.log(
    `Opening index from ${PINNED.source}@${PINNED.commit.slice(0, 7)}: ${index.lines} named lines, ${index.positions} book positions, ` +
      `${index.named} named positions (${index.sameEndDifferentName} end positions shared by differently named lines), ${json.length} bytes of JSON.`,
  );
  if (outIndex !== -1) {
    const out = process.argv[outIndex + 1];
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
    console.log(`Written to ${out}`);
  }
}
