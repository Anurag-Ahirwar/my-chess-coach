// Decision U4 evidence: compares the lite and full single-threaded Stockfish 19.0.1 builds from
// the pinned npm package, run as Node child processes, at the Deep preset on the same positions.
// Measures load time, memory, speed, and how often the two builds agree.
//   npm run bench:builds   -> docs/benchmarks/<date>-builds.json
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Chess } from "chess.js";

const require = createRequire(import.meta.url);
const stockfish = require("stockfish");
const DEEP = { nodes: 2_500_000, maxDepth: 30, multiPv: 2 };
const STANDARD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/** Every 4th position of two real games plus the hand-made fixture positions. */
function positions() {
  const list = [];
  for (const file of ["02-blitz.pgn", "21-daily.pgn"]) {
    const chess = new Chess();
    chess.loadPgn(readFileSync(join("tests/fixtures/pgn/chesscom", file), "utf8"));
    const moves = chess.history({ verbose: true }).map((m) => m.lan);
    for (let k = 0; k < moves.length; k += 8) list.push({ id: `${file}#${k}`, startFen: STANDARD, moves: moves.slice(0, k) });
  }
  const fixtures = JSON.parse(readFileSync("tests/fixtures/engine/positions.json", "utf8")).positions;
  for (const p of fixtures) list.push({ id: p.id, startFen: p.startFen, moves: p.moves });
  return list;
}

function memoryMB(pid) {
  if (process.platform !== "win32") return undefined;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).PrivateMemorySize64`], { encoding: "utf8" });
  return Math.round(Number(out.trim()) / 2 ** 20);
}

function startEngine(flavour) {
  const child = spawn(process.execPath, [stockfish.findEngine(flavour)], { stdio: ["pipe", "pipe", "inherit"] });
  const waiters = [];
  let collect = null;
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (collect) collect.push(line);
    if (waiters[0]?.test(line)) waiters.shift().resolve(line);
  });
  return {
    child,
    send: (c) => child.stdin.write(`${c}\n`),
    until: (re) => new Promise((resolve) => waiters.push({ test: (l) => re.test(l), resolve })),
    collect: () => (collect = []),
    take: () => {
      const lines = collect;
      collect = null;
      return lines;
    },
  };
}

/** Last exact (non-bound) score of multipv 1, from the side to move's view. */
function topLine(lines) {
  let top;
  for (const line of lines) {
    if (!/^info .*\bmultipv 1\b/.test(line) || /bound/.test(line)) continue;
    const score = / score (cp|mate) (-?\d+)/.exec(line);
    const nodes = / nodes (\d+)/.exec(line);
    const time = / time (\d+)/.exec(line);
    if (score && nodes) top = { kind: score[1], value: Number(score[2]), nodes: Number(nodes[1]), timeMs: Number(time?.[1] ?? 0) };
  }
  return top;
}

async function run(flavour, list) {
  const t0 = performance.now();
  const engine = startEngine(flavour);
  engine.send("uci");
  await engine.until(/^uciok$/);
  for (const o of ["Threads value 1", "Hash value 16", "UCI_ShowWDL value true", `MultiPV value ${DEEP.multiPv}`]) engine.send(`setoption name ${o}`);
  engine.send("isready");
  await engine.until(/^readyok$/);
  const loadMs = Math.round(performance.now() - t0);
  const idleMB = memoryMB(engine.child.pid);
  const results = [];
  let peakMB = idleMB ?? 0;
  for (const p of list) {
    engine.send("ucinewgame");
    engine.send("isready");
    await engine.until(/^readyok$/);
    engine.collect();
    const base = p.startFen === STANDARD ? "position startpos" : `position fen ${p.startFen}`;
    engine.send(p.moves.length ? `${base} moves ${p.moves.join(" ")}` : base);
    const started = performance.now();
    engine.send(`go nodes ${DEEP.nodes} depth ${DEEP.maxDepth}`);
    const best = await engine.until(/^bestmove /);
    const wallMs = Math.round(performance.now() - started);
    const top = topLine(engine.take());
    results.push({ id: p.id, bestMove: best.split(" ")[1], top, wallMs });
    peakMB = Math.max(peakMB, memoryMB(engine.child.pid) ?? 0);
  }
  engine.send("quit");
  return { flavour, loadMs, idleMB, peakMB, results };
}

const list = positions();
console.log(`${list.length} positions at Deep (${DEEP.nodes} nodes, depth ${DEEP.maxDepth}, MultiPV ${DEEP.multiPv})`);
const lite = await run("lite-single", list);
console.log(`lite-single done: load ${lite.loadMs} ms`);
const full = await run("single", list);
console.log(`full single done: load ${full.loadMs} ms`);

const comparison = list.map((p, i) => {
  const a = lite.results[i];
  const b = full.results[i];
  const cpDiff = a.top?.kind === "cp" && b.top?.kind === "cp" ? Math.abs(a.top.value - b.top.value) : null;
  return { id: p.id, sameBestMove: a.bestMove === b.bestMove, cpDiff, liteMs: a.wallMs, fullMs: b.wallMs };
});
const out = {
  machine: { cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, ramGB: Math.round(os.totalmem() / 2 ** 30), node: process.version, date: new Date().toISOString() },
  settings: DEEP,
  builds: { lite, full },
  comparison,
};
mkdirSync("docs/benchmarks", { recursive: true });
const file = `docs/benchmarks/${new Date().toISOString().slice(0, 10)}-builds.json`;
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`Wrote ${file}`);
