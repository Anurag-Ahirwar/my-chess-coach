import { Chess } from "chess.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { replayUciLine } from "@/core/chess/position";
import type { RawAnalysis } from "@/core/engine/analysis";
import type { Score } from "@/core/engine/types";
import type { GameRecord } from "@/core/game/types";
import { METHODOLOGY_V1, configHash } from "@/core/methodology/v1";
import { EMPTY_OPENING_INDEX } from "@/core/openings";
import { deriveReview, turningPoint } from "@/core/review";
import { gameFromUci } from "../../../helpers/games";
import { realOpeningIndex } from "../../../helpers/openings";
import { mirrorFen, mirrorUci, negate, rawFromScores, type SyntheticPosition } from "../../../helpers/review";

const C = METHODOLOGY_V1;
const cp = (value: number): Score => ({ kind: "cp", value });
const at = (value: number): SyntheticPosition => ({ score: cp(value) });

describe("deriveReview", () => {
  it("labels every move, converts every line to legal SAN and reports full coverage", async () => {
    const game = await gameFromUci(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5c6", "d7c6"]);
    const raw = rawFromScores(game, [20, 25, 20, 30, 25, 30, 35, 30, 30].map(at));
    const review = deriveReview({ game, raw, index: realOpeningIndex().index, config: C });
    expect(review.moves).toHaveLength(8);
    expect(review.coverage).toEqual({ total: 9, analysed: 9, failed: 0, pending: 0, complete: true });
    expect(review.moves.every((m) => m.graded)).toBe(true);
    expect(review.moves.slice(0, 6).map((m) => m.label)).toEqual(["book", "book", "book", "book", "book", "book"]);
    expect(review.opening).toMatchObject({ eco: "C68", ply: 7 });
    for (const m of review.moves) {
      const fen = new Chess(game.startFen);
      for (const p of game.plies.slice(0, m.plyIndex - 1)) fen.move(p.san);
      if (m.bestMove) expect(replayUciLine(fen.fen(), [m.bestMove.uci]).illegalAt).toBeUndefined();
      expect(m.bestLineSan.length).toBeGreaterThan(0);
    }
    expect(review.methodologyVersion).toBe("1.0.0");
    expect(review.configHash).toBe(configHash(C));
    expect(review.white.accuracy).toBeDefined();
    expect(review.keyMoments).toEqual([]);
  }, 60_000); // the first use builds the real opening index

  it("leaves moves next to a failed position unlabelled and counts them as not included", async () => {
    const game = await gameFromUci(["d2d4", "d7d5", "c2c4", "e7e6", "b1c3", "g8f6"]);
    const scores = [20, 25, 20, 30, 25, 30, 35].map(at);
    scores[3] = { score: cp(0), status: "failed" };
    const review = deriveReview({ game, raw: rawFromScores(game, scores), index: EMPTY_OPENING_INDEX, config: C });
    expect(review.coverage).toMatchObject({ failed: 1, pending: 0, complete: false });
    expect(review.moves[2]).toMatchObject({ graded: false, labelReasons: ["missing:eval"] });
    expect(review.moves[3]).toMatchObject({ graded: false, labelReasons: ["missing:eval"] });
    expect(review.winSeries[3]).toBeNull();
    // Accuracy is still final (the run finished), with the gap reported.
    expect(review.white.accuracy).toBeDefined();
    expect(review.white.excludedMissingWeight + review.black.excludedMissingWeight).toBeGreaterThan(0);
    expect(review.turningPoint).toBeUndefined(); // only for complete analyses
  });

  it("never shows final-looking numbers while positions are still pending", async () => {
    const game = await gameFromUci(["d2d4", "d7d5", "c2c4", "e7e6"]);
    const scores: SyntheticPosition[] = [at(20), at(25), at(20), { score: cp(0), status: "pending" }, { score: cp(0), status: "pending" }];
    const review = deriveReview({ game, raw: rawFromScores(game, scores), index: EMPTY_OPENING_INDEX, config: C });
    expect(review.coverage).toMatchObject({ pending: 2, complete: false });
    expect(review.moves[2]!.labelReasons).toEqual(["pending:eval"]);
    expect(review.moves[0]!.graded).toBe(true);
    for (const side of [review.white, review.black]) {
      expect(side.accuracy).toBeUndefined();
      expect(side.acpl).toBeUndefined();
      expect(side.accuracyByPhase).toEqual({});
    }
  });

  it("uses Wprev from the position before the opponent's previous move (Miss)", async () => {
    // Position 1 is equal (+0.20). Black's 1...f6 (position 2: +4.00 for White) hands White a
    // chance; White's 2.a3 throws it back (position 3: +0.30). Wprev for move 3 is position 1.
    const game = await gameFromUci(["e2e4", "f7f6", "a2a3"]);
    const raw = rawFromScores(game, [at(20), at(20), at(400), at(30)]);
    const review = deriveReview({ game, raw, index: EMPTY_OPENING_INDEX, config: C });
    expect(review.moves[1]!.severity).toBe("blunder");
    expect(review.moves[2]!.label).toBe("miss");
  });

  it("refuses an analysis of another game or with the wrong length", async () => {
    const game = await gameFromUci(["e2e4"]);
    const other = await gameFromUci(["d2d4"]);
    expect(() => deriveReview({ game, raw: rawFromScores(other, [at(0), at(0)]), index: EMPTY_OPENING_INDEX, config: C })).toThrow(/another game/);
    const raw = rawFromScores(game, [at(0), at(0)]);
    expect(() => deriveReview({ game, raw: { ...raw, totalCount: 3, positions: [...raw.positions, null] }, index: EMPTY_OPENING_INDEX, config: C })).toThrow(/positions/);
  });
});

describe("turning point (AI_COACH_DESIGN §10, M13)", () => {
  it("is the largest swing that crosses 50, the earliest on ties", () => {
    expect(turningPoint([50, 60, 40, 45, 80, 20])).toBe(5); // 80 → 20 (60) beats 60 → 40 (20) and 45 → 80 (35)
    expect(turningPoint([60, 40, 60, 40])).toBe(1);
    expect(turningPoint([50, 60, 70])).toBeUndefined(); // touching 50 is not crossing
    expect(turningPoint([60, null, 40])).toBeUndefined();
  });
});

/** A random legal game (up to 30 plies) with random scores and second lines. */
const gameArb = fc
  .record({
    choices: fc.array(fc.nat(), { minLength: 1, maxLength: 30 }),
    scores: fc.array(fc.integer({ min: -1200, max: 1200 }), { minLength: 31, maxLength: 31 }),
    seconds: fc.array(fc.integer({ min: -1200, max: 1200 }), { minLength: 31, maxLength: 31 }),
    bests: fc.array(fc.nat(), { minLength: 31, maxLength: 31 }),
  })
  .map(({ choices, scores, seconds, bests }) => {
    const chess = new Chess();
    const moves: string[] = [];
    const bestMoves: string[] = [];
    const secondMoves: string[] = [];
    for (const choice of choices) {
      const legal = chess.moves({ verbose: true });
      if (legal.length === 0) break;
      const uci = (m: (typeof legal)[number]) => `${m.from}${m.to}${m.promotion ?? ""}`;
      bestMoves.push(uci(legal[bests[moves.length]! % legal.length]!));
      secondMoves.push(uci(legal[(bests[moves.length]! + 1) % legal.length]!));
      const move = legal[choice % legal.length]!;
      chess.move(move);
      moves.push(uci(move));
    }
    return { moves, scores, seconds, bestMoves, secondMoves };
  });

async function build(spec: { moves: string[]; scores: number[]; seconds: number[]; bestMoves: string[]; secondMoves: string[] }, mirrored: boolean) {
  const start = new Chess().fen();
  const game = await gameFromUci(mirrored ? spec.moves.map(mirrorUci) : spec.moves, mirrored ? mirrorFen(start) : start);
  const positions: SyntheticPosition[] = spec.scores.map((value, k) => ({
    score: mirrored ? negate(cp(value)) : cp(value),
    ...(spec.bestMoves[k] ? { best: mirrored ? mirrorUci(spec.bestMoves[k]) : spec.bestMoves[k] } : {}),
    ...(spec.secondMoves[k]
      ? { second: { uci: mirrored ? mirrorUci(spec.secondMoves[k]) : spec.secondMoves[k], score: mirrored ? negate(cp(spec.seconds[k]!)) : cp(spec.seconds[k]!) } }
      : {}),
  }));
  return { game, raw: rawFromScores(game, positions) };
}

describe("properties (fast-check)", () => {
  it("mirror: flipping the board, swapping colours and negating scores gives the same labels and accuracies", async () => {
    await fc.assert(
      fc.asyncProperty(gameArb, async (spec) => {
        const a = await build(spec, false);
        const b = await build(spec, true);
        const ra = deriveReview({ ...a, index: EMPTY_OPENING_INDEX, config: C });
        const rb = deriveReview({ ...b, index: EMPTY_OPENING_INDEX, config: C });
        // Labels, reasons and phases must be identical. Numbers must agree to 1e-9: the colour-swapped
        // path computes them with different arithmetic (e.g. Black's Win% is 100 − x), which can
        // differ in the last bit.
        const exact = (r: typeof ra) => r.moves.map((m) => ({ label: m.label, severity: m.severity, reasons: m.labelReasons, phase: m.phase, counts: m.countsTowardAccuracy }));
        expect(exact(rb)).toEqual(exact(ra));
        ra.moves.forEach((m, i) => {
          const n = rb.moves[i]!;
          for (const key of ["winLoss", "accuracy", "volatilityWeight", "cpLoss"] as const) {
            expect(n[key] === undefined).toBe(m[key] === undefined);
            if (m[key] !== undefined) expect(Math.abs(n[key]! - m[key])).toBeLessThan(1e-9);
          }
        });
        expect(rb.black.accuracy).toBeCloseTo(ra.white.accuracy ?? Number.NaN, 9);
        expect(rb.white.accuracy ?? null).toEqual(ra.black.accuracy === undefined ? null : expect.closeTo(ra.black.accuracy, 9));
        expect(rb.black.labelCounts).toEqual(ra.white.labelCounts);
      }),
      { numRuns: 60 },
    );
  }, 120_000);

  it("derivation is deterministic and never modifies its inputs", async () => {
    await fc.assert(
      fc.asyncProperty(gameArb, async (spec) => {
        const { game, raw } = await build(spec, false);
        const before = structuredClone({ game, raw });
        const deepFreeze = <T>(v: T): T => {
          if (v && typeof v === "object") {
            for (const child of Object.values(v)) deepFreeze(child);
            Object.freeze(v);
          }
          return v;
        };
        const frozen = deepFreeze({ game: structuredClone<GameRecord>(game), raw: structuredClone<RawAnalysis>(raw) });
        const first = deriveReview({ ...frozen, index: EMPTY_OPENING_INDEX, config: C });
        const second = deriveReview({ ...frozen, index: EMPTY_OPENING_INDEX, config: C });
        expect(second).toEqual(first);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        expect({ game: frozen.game, raw: frozen.raw }).toEqual(before);
      }),
      { numRuns: 40 },
    );
  }, 120_000);
});
