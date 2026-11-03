// Pseudonymises recorded Chess.com fixtures before they are committed.
// Every player except the accounts in KEEP becomes "player-NN"; game links and
// UUIDs become synthetic values; the profile fixture is trimmed to the fields the app uses.
// The moves, clocks, results and positions are unchanged.
// Run: node scripts/anonymise-fixtures.mjs   (fetch-chesscom-fixtures.mjs runs it automatically)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const KEEP = new Set(["hikaru"]); // public account the tests are written against
const PGN_DIR = "tests/fixtures/pgn/chesscom";
const API_DIR = "tests/fixtures/chesscom/api";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function anonymiseFixtures() {
  const files = [
    ...readdirSync(PGN_DIR).filter((f) => f.endsWith(".pgn")).map((f) => join(PGN_DIR, f)),
    ...readdirSync(API_DIR).filter((f) => f.endsWith(".json")).map((f) => join(API_DIR, f)),
  ];
  const texts = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));

  // 1. Collect usernames from PGN tags and JSON player objects.
  const names = new Set();
  for (const text of texts.values()) {
    for (const match of text.matchAll(/^\[(?:White|Black) "([^"]+)"\]/gm)) names.add(match[1]);
    for (const match of text.matchAll(/\\?"username\\?":\s*\\?"([^"\\]+)\\?"/g)) names.add(match[1]);
  }
  const pseudonyms = new Map();
  [...names]
    .filter((name) => !KEEP.has(name.toLowerCase()) && !/^player-\d+$/.test(name))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .forEach((name, i) => pseudonyms.set(name.toLowerCase(), `player-${String(i + 1).padStart(2, "0")}`));

  const nameRegex = pseudonyms.size
    ? new RegExp(`(?<![A-Za-z0-9_-])(${[...pseudonyms.keys()].map(escape).join("|")})(?![A-Za-z0-9_-])`, "gi")
    : null;

  // 2. Synthetic, stable replacements for game links and UUIDs.
  const links = new Map();
  const uuids = new Map();
  const syntheticUuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

  for (const [file, original] of texts) {
    let text = original;
    if (nameRegex) text = text.replace(nameRegex, (match) => pseudonyms.get(match.toLowerCase()));
    text = text.replace(/https:\/\/www\.chess\.com\/game\/(live|daily)\/(\d+)/g, (url, kind) => {
      if (!links.has(url)) links.set(url, `https://www.chess.com/game/${kind}/${100000 + links.size + 1}`);
      return links.get(url);
    });
    text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (uuid) => {
      if (uuid.startsWith("00000000-0000-4000-8000-")) return uuid;
      if (!uuids.has(uuid)) uuids.set(uuid, syntheticUuid(uuids.size + 1));
      return uuids.get(uuid);
    });
    if (file.endsWith("profile-hikaru.json")) {
      const profile = JSON.parse(text);
      text = `${JSON.stringify({ "@id": profile["@id"], url: profile.url, username: profile.username }, null, 2)}\n`;
    }
    if (text !== original) writeFileSync(file, text);
  }
  return { players: pseudonyms.size, links: links.size, uuids: uuids.size };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = anonymiseFixtures();
  console.log(`Pseudonymised ${result.players} players, ${result.links} game links, ${result.uuids} UUIDs.`);
}
