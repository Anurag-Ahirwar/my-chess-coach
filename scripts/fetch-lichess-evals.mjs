#!/usr/bin/env node
/**
 * Collects the Lichess cross-check fixtures (docs/TESTING_STRATEGY.md §3 `lichess-evals/`,
 * Phase 3 decision Q2): public games that already have Lichess computer analysis, with Lichess's
 * own per-ply evaluations, accuracies, ACPL, phase division and phase accuracies.
 *
 * Usage: node scripts/fetch-lichess-evals.mjs --users <a,b,c> [--per-user 100] [--count 50]
 *
 * - Endpoint (parameters confirmed against Lichess's API spec, 2026-11-13):
 *   GET https://lichess.org/api/games/user/{user}?analysed=true&evals=true&accuracy=true
 *       &division=true&opening=true&clocks=false&perfType=bullet,blitz,rapid,classical
 *   with Accept: application/x-ndjson. Requests are serial; a 429 waits 60 s and retries once.
 * - Selection rule (deterministic for a given pool): standard games with an analysis entry per
 *   ply, grouped by volatility window size ws = clamp(floor(plies / 10), 2, 8); for each ws from 2
 *   to 8, up to `count / 7` games, taken round-robin over the endings mate, draw, outoftime and
 *   anything else; within an ending, alternate accounts and take the newest first. The rest is
 *   filled from the whole pool in the same account-alternating order. (Games ending in checkmate
 *   have no Lichess eval for the final position; that is kept as it is.)
 * - Pseudonymised before writing (the repository is public): players become player-NN, game ids
 *   become lichess-NN, and ratings, titles, dates, clocks and links are dropped. Moves, evaluations,
 *   judgments, accuracies, ACPL, division, phase accuracies and the opening are unchanged.
 * - The account names are not written to the output.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "lichess-evals", "games.json");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const users = (arg("users", "") ?? "").split(",").filter(Boolean);
const perUser = Number(arg("per-user", "100"));
const count = Number(arg("count", "50"));
if (users.length === 0) {
  console.error("Give the public Lichess accounts to sample: --users a,b,c");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchUser(user) {
  const params = new URLSearchParams({
    max: String(perUser),
    analysed: "true",
    evals: "true",
    accuracy: "true",
    division: "true",
    opening: "true",
    clocks: "false",
    perfType: "bullet,blitz,rapid,classical",
  });
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(user)}?${params}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    try {
      response = await fetch(url, { headers: { Accept: "application/x-ndjson", "User-Agent": "chess-coach-fixture-fetch/1.0" } });
    } catch (error) {
      console.log(`Network error (${error.cause?.code ?? error.message}); retrying in 5 s`);
      await sleep(5000);
      continue;
    }
    if (response.status === 429) {
      console.log("429 from Lichess: waiting 60 s");
      await sleep(60_000);
      continue;
    }
    if (!response.ok) throw new Error(`Lichess returned ${response.status} for an account`);
    const text = await response.text();
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  throw new Error("Lichess kept returning 429");
}

const windowSize = (plies) => Math.max(2, Math.min(8, Math.floor(plies / 10)));
const ENDING_PREFERENCE = ["mate", "draw", "outoftime"];

const pool = [];
for (const [accountIndex, user] of users.entries()) {
  const games = await fetchUser(user);
  for (const game of games) {
    const plies = game.moves ? game.moves.split(" ").length : 0;
    if (game.variant !== "standard" || game.initialFen || plies === 0) continue;
    if (!Array.isArray(game.analysis) || game.analysis.length < plies - 1) continue;
    pool.push({ game, accountIndex, plies, ws: windowSize(plies) });
  }
  await sleep(1500);
}
// Newest first, then alternate accounts: interleave by rank within each account.
const rankInAccount = new Map();
pool.sort((a, b) => b.game.createdAt - a.game.createdAt);
for (const entry of pool) {
  const rank = rankInAccount.get(entry.accountIndex) ?? 0;
  entry.rank = rank;
  rankInAccount.set(entry.accountIndex, rank + 1);
}
pool.sort((a, b) => a.rank - b.rank || a.accountIndex - b.accountIndex);

const chosen = [];
const take = (entry) => {
  if (!chosen.includes(entry) && chosen.length < count) chosen.push(entry);
};
const perWs = Math.floor(count / 7);
for (let ws = 2; ws <= 8; ws++) {
  const bucket = pool.filter((e) => e.ws === ws);
  // Round-robin over endings: mate, draw, outoftime, anything else, mate, …
  const groups = [...ENDING_PREFERENCE.map((status) => bucket.filter((e) => e.game.status === status)), bucket.filter((e) => !ENDING_PREFERENCE.includes(e.game.status))];
  const ordered = [];
  for (let i = 0; groups.some((g) => i < g.length); i++) for (const group of groups) if (group[i]) ordered.push(group[i]);
  let taken = 0;
  for (const entry of ordered) {
    if (taken >= perWs) break;
    if (!chosen.includes(entry)) {
      take(entry);
      taken++;
    }
  }
}
for (const entry of pool) take(entry);

let playerNumber = 0;
const pseudonym = () => `player-${String(++playerNumber).padStart(2, "0")}`;
const player = (side) => ({
  name: pseudonym(),
  analysis: side.analysis ?? null,
});
const games = chosen.map(({ game, ws }, i) => ({
  id: `lichess-${String(i + 1).padStart(2, "0")}`,
  speed: game.speed,
  status: game.status,
  winner: game.winner ?? null,
  windowSize: ws,
  opening: game.opening ?? null,
  division: game.division ?? null,
  players: { white: player(game.players.white), black: player(game.players.black) },
  moves: game.moves,
  analysis: game.analysis.map((entry) => ({
    ...(entry.eval !== undefined ? { eval: entry.eval } : {}),
    ...(entry.mate !== undefined ? { mate: entry.mate } : {}),
    ...(entry.judgment ? { judgment: entry.judgment.name } : {}),
  })),
}));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      comment:
        "Lichess cross-check fixtures (docs/TESTING_STRATEGY.md §3, decision Q2). Public analysed games, pseudonymised; selection rule in scripts/fetch-lichess-evals.mjs. analysis[i] is Lichess's evaluation of the position after ply i + 1 (White POV); position 0 has none.",
      fetched: new Date().toISOString().slice(0, 10),
      pool: pool.length,
      games,
    },
    null,
    1,
  )}\n`,
);
const tally = (key) => games.reduce((acc, g) => ({ ...acc, [g[key]]: (acc[g[key]] ?? 0) + 1 }), {});
console.log(`Pool ${pool.length} games; wrote ${games.length} to ${OUT}`);
console.log("By window size:", tally("windowSize"));
console.log("By ending:", tally("status"));
