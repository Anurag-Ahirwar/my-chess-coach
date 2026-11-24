// Node benchmark of review derivation (docs/BENCHMARKS.md §6). Report only, never a gate.
//   BENCH_REVIEW=<output.json> npm run bench:review
// 5 warm-up runs, then 30 measured runs per game. Skipped unless BENCH_REVIEW is set.
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { Chess } from "chess.js";
import { describe, it } from "vitest";
import { acpl, gameAccuracy, phaseAccuracy } from "@/core/accuracy";
import { positionsOf, replayUciLine } from "@/core/chess/position";
import { SPECIAL_RULES, classifyMove, type PositionEval } from "@/core/classify";
import type { RawAnalysis } from "@/core/engine/analysis";
import type { GameRecord } from "@/core/game/types";
import { METHODOLOGY_V1 } from "@/core/methodology/v1";
import { dividePhases } from "@/core/phases";
import { deriveReview } from "@/core/review";
import { readFixture } from "../helpers/fixtures";
import { gameFromPgn, gameFromUci } from "../helpers/games";
import { realOpeningIndex } from "../helpers/openings";
import { rawFromScores } from "../helpers/review";

const OUT = process.env["BENCH_REVIEW"];
const GAMES = ["23-daily", "07-bullet", "06-blitz", "02-blitz", "21-daily", "10-bullet", "19-rapid", "12-blitz", "16-rapid", "14-blitz"];

function measure(run: () => void) {
  for (let i = 0; i < 5; i++) run();
  const times = Array.from({ length: 30 }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 10) / 10;
  return { median: round((times[14]! + times[15]!) / 2), p95: round(times[28]!), max: round(times[29]!) };
}

const uciOf = (m: { from: string; to: string; promotion?: string | undefined }) => `${m.from}${m.to}${m.promotion ?? ""}`;

/** A 300-ply game of seeded pseudo-random legal moves, with 20-ply lines (a synthetic long game). */
async function syntheticGame(): Promise<{ game: GameRecord; raw: RawAnalysis }> {
  for (let seed = 1; ; seed++) {
    let state = seed;
    const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) >> 8;
    const chess = new Chess();
    const moves: string[] = [];
    while (moves.length < 300 && !chess.isGameOver()) {
      const legal = chess.moves({ verbose: true });
      const move = legal[next() % legal.length]!;
      chess.move(move);
      moves.push(uciOf(move));
    }
    if (moves.length < 300) continue;
    const game = await gameFromUci(moves);
    const raw = rawFromScores(
      game,
      Array.from({ length: 301 }, () => ({ score: { kind: "cp" as const, value: (next() % 400) - 200 } })),
    );
    for (const [k, position] of raw.positions.entries()) {
      if (position?.status !== "done") continue;
      const replay = new Chess(k === 0 ? game.startFen : game.plies[k - 1]!.fenAfter);
      const pv: string[] = [];
      while (pv.length < 20 && !replay.isGameOver()) {
        const legal = replay.moves({ verbose: true });
        const move = pv.length === 0 ? legal.find((m) => uciOf(m) === position.bestMove)! : legal[next() % legal.length]!;
        replay.move(move);
        pv.push(uciOf(move));
      }
      position.lines[0]!.pv = pv;
      position.lines.push({ ...position.lines[0]!, rank: 2 });
    }
    return { game, raw };
  }
}

function split(game: GameRecord, raw: RawAnalysis) {
  const fens = positionsOf(game.startFen, game.plies);
  const evals = raw.positions.map((p): PositionEval | undefined => {
    if (p?.status === "done") return { score: p.lines[0]!.score, lines: p.lines, bestMove: p.bestMove };
    return p?.status === "terminal" ? { score: p.terminal, lines: [] } : undefined;
  });
  const scores = evals.map((e) => e?.score);
  const startColor = game.startFen.split(" ")[1] === "b" ? ("b" as const) : ("w" as const);
  const phases = dividePhases(fens, undefined, METHODOLOGY_V1.phases).phases;
  const input = { scores, startColor, mode: "default" as const };
  return {
    sanOfTopLines: measure(() => {
      raw.positions.forEach((p, k) => {
        if (p?.status === "done") replayUciLine(fens[k]!, p.lines[0]!.pv);
      });
    }),
    classification: measure(() => {
      game.plies.forEach((ply, i) => {
        classifyMove(
          {
            color: ply.color,
            uci: ply.uci,
            fenBefore: fens[i]!,
            legalMoves: 20,
            bookChain: false,
            before: evals[i],
            after: evals[i + 1],
            analysis: { multiPv: 2, allowsSpecialLabels: true },
          },
          METHODOLOGY_V1,
          SPECIAL_RULES,
        );
      });
    }),
    accuracy: measure(() => {
      gameAccuracy(input);
      phaseAccuracy(input, phases);
      acpl(scores, startColor);
    }),
    phases: measure(() => {
      dividePhases(fens, undefined, METHODOLOGY_V1.phases);
    }),
  };
}

describe.skipIf(!OUT)("review derivation benchmark (Node)", () => {
  it("measures every game", { timeout: 900_000 }, async () => {
    const { index } = realOpeningIndex();
    const rows = [];
    for (const name of [...GAMES, "synthetic-300"]) {
      const { game, raw } =
        name === "synthetic-300"
          ? await syntheticGame()
          : {
              game: await gameFromPgn(readFixture("pgn", "chesscom", `${name}.pgn`)),
              raw: JSON.parse(readFileSync(new URL(`../fixtures/review/raw/${name}.standard.json`, import.meta.url), "utf8")) as RawAnalysis,
            };
      const total = measure(() => {
        deriveReview({ game, raw, index, config: METHODOLOGY_V1 });
      });
      rows.push({ name, plies: game.plies.length, total, split: split(game, raw) });
    }
    const machine = { cpu: os.cpus()[0]?.model, cores: os.cpus().length, node: process.version };
    writeFileSync(OUT!, `${JSON.stringify({ ...machine, warmups: 5, runs: 30, unit: "ms", rows }, null, 1)}\n`);
  });
});
