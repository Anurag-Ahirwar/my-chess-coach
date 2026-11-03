// Records real Chess.com games and API responses as frozen test fixtures.
// Run manually: node scripts/fetch-chesscom-fixtures.mjs
// Requests are serial, as the Published-Data API asks.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { anonymiseFixtures } from "./anonymise-fixtures.mjs";

const API = "https://api.chess.com/pub/player";
const HEADERS = { "User-Agent": "chess-coach-fixtures/0.1 (local test fixture recorder)", Accept: "application/json" };
const ACCOUNTS = ["hikaru", "magnuscarlsen", "danielnaroditsky", "gothamchess", "erik"];
const PER_TIME_CLASS = { bullet: 6, blitz: 8, rapid: 8, daily: 8 };
const OUT_PGN = "tests/fixtures/pgn/chesscom";
const OUT_API = "tests/fixtures/chesscom/api";

async function getJson(url) {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.json();
}

const picked = new Map();
const counts = Object.fromEntries(Object.keys(PER_TIME_CLASS).map((k) => [k, 0]));
const terminations = new Set();

for (const account of ACCOUNTS) {
  const { archives } = await getJson(`${API}/${account}/games/archives`);
  for (const archiveUrl of archives.slice(-6).reverse()) {
    const { games } = await getJson(archiveUrl);
    for (const game of games) {
      if (game.rules !== "chess" || !game.pgn) continue;
      const tc = game.time_class;
      if (!(tc in PER_TIME_CLASS) || counts[tc] >= PER_TIME_CLASS[tc]) continue;
      const termination = /\[Termination "([^"]*)"\]/.exec(game.pgn)?.[1] ?? "";
      const kind = termination.replace(/^.* won /, "won ").replace(/^.* drawn /, "drawn ");
      // Prefer variety of endings: take a game if its ending is new, or while the class is under half full.
      if (terminations.has(kind) && counts[tc] >= PER_TIME_CLASS[tc] / 2) continue;
      terminations.add(kind);
      counts[tc]++;
      picked.set(game.uuid ?? game.url, game);
    }
  }
}

await mkdir(OUT_PGN, { recursive: true });
await mkdir(OUT_API, { recursive: true });
let n = 0;
for (const game of picked.values()) {
  n++;
  const name = `${String(n).padStart(2, "0")}-${game.time_class}.pgn`;
  await writeFile(join(OUT_PGN, name), game.pgn.endsWith("\n") ? game.pgn : `${game.pgn}\n`);
}

// API fixtures for the client tests: a profile, an archive list, and one small month.
const profile = await getJson(`${API}/hikaru`);
await writeFile(join(OUT_API, "profile-hikaru.json"), JSON.stringify(profile, null, 2));
const archives = await getJson(`${API}/hikaru/games/archives`);
await writeFile(join(OUT_API, "archives-hikaru.json"), JSON.stringify({ archives: archives.archives.slice(-4) }, null, 2));
const month = await getJson(archives.archives.at(-2));
await writeFile(join(OUT_API, "month-hikaru.json"), JSON.stringify({ games: month.games.slice(0, 6) }, null, 2));

console.log(`Saved ${picked.size} games:`, counts, [...terminations]);

// Fixtures are committed: pseudonymise everyone except the public account the tests use.
const anonymised = anonymiseFixtures();
console.log(`Pseudonymised ${anonymised.players} players, ${anonymised.links} game links, ${anonymised.uuids} UUIDs.`);
