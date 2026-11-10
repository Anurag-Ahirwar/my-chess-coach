// Records golden UCI transcripts from the pinned npm Stockfish build (lite single-threaded),
// run as a Node child process (decision A13). One file per position and preset in
// tests/fixtures/engine/transcripts/, holding every line from `go` to `bestmove`.
//
//   npm run record:engine            write transcripts
//   npm run record:engine -- --verify  re-run and compare byte for byte (determinism check)
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";

const require = createRequire(import.meta.url);
const enginePath = require("stockfish").findEngine("lite-single");
const packageVersion = require("stockfish/package.json").version;
const STANDARD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const FIXTURES = "tests/fixtures/engine";
const OUT = join(FIXTURES, "transcripts");
const verify = process.argv.includes("--verify");
const { positions, presets } = JSON.parse(readFileSync(join(FIXTURES, "positions.json"), "utf8"));

function startEngine() {
  const child = spawn(process.execPath, [enginePath], { stdio: ["pipe", "pipe", "inherit"] });
  const waiters = [];
  let collector = null;
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (collector) collector.push(line);
    const waiter = waiters[0];
    if (waiter && waiter.test(line)) {
      waiters.shift();
      waiter.resolve(line);
    }
  });
  const send = (command) => child.stdin.write(`${command}\n`);
  const until = (pattern) => new Promise((resolve) => waiters.push({ test: (l) => pattern.test(l), resolve }));
  return {
    child,
    send,
    until,
    collect: () => (collector = []),
    stopCollecting: () => {
      const lines = collector;
      collector = null;
      return lines;
    },
  };
}

const engine = startEngine();
engine.collect();
engine.send("uci");
await engine.until(/^uciok$/);
const handshake = engine.stopCollecting();
const idName = handshake.find((l) => l.startsWith("id name "))?.slice(8) ?? "unknown";
const evalFile = /option name EvalFile .* default (\S+)/.exec(handshake.join("\n"))?.[1] ?? "unknown";
for (const option of ["Threads value 1", "Hash value 16", "UCI_ShowWDL value true"]) engine.send(`setoption name ${option}`);

mkdirSync(OUT, { recursive: true });
let mismatches = 0;
let written = 0;
for (const position of positions) {
  for (const [presetName, preset] of Object.entries(presets)) {
    const positionCommand =
      (position.startFen === STANDARD ? "position startpos" : `position fen ${position.startFen}`) +
      (position.moves.length ? ` moves ${position.moves.join(" ")}` : "");
    const goCommand = `go nodes ${preset.nodes} depth ${preset.maxDepth}`;
    engine.send(`setoption name MultiPV value ${preset.multiPv}`);
    engine.send("ucinewgame");
    engine.send("isready");
    await engine.until(/^readyok$/);
    engine.collect();
    engine.send(positionCommand);
    engine.send(goCommand);
    await engine.until(/^bestmove /);
    // Output order is deterministic; "info string" lines describe the host, not the search.
    const lines = engine.stopCollecting().filter((l) => !l.startsWith("info string"));
    const header = [
      `# engine: ${idName} | network: ${evalFile} | npm stockfish ${packageVersion} lite-single (Node child process)`,
      `# position-id: ${position.id}`,
      `# side-to-move: ${position.sideToMove}`,
      `# preset: ${presetName} (multipv ${preset.multiPv})`,
      `# command: setoption name MultiPV value ${preset.multiPv}`,
      `# command: ${positionCommand}`,
      `# command: ${goCommand}`,
    ];
    const text = `${[...header, ...lines].join("\n")}\n`;
    const file = join(OUT, `${position.id}.${presetName}.uci`);
    if (verify) {
      const previous = existsSync(file) ? readFileSync(file, "utf8") : null;
      // nps and time vary with machine load; everything else must match exactly.
      const stable = (s) => s?.replace(/ nps \d+/g, "").replace(/ time \d+/g, "");
      if (stable(previous) !== stable(text)) {
        mismatches++;
        console.error(`MISMATCH ${file}`);
      }
    } else {
      writeFileSync(file, text);
      written++;
    }
  }
}
engine.send("quit");

if (verify) {
  console.log(mismatches === 0 ? `All ${positions.length * Object.keys(presets).length} transcripts reproduced exactly (ignoring nps/time).` : `${mismatches} transcript(s) differ.`);
  process.exitCode = mismatches === 0 ? 0 : 1;
} else {
  console.log(`Wrote ${written} transcripts to ${OUT} (${idName}, ${evalFile}).`);
}
