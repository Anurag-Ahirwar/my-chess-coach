import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { replayUciLine } from "@/core/chess/position";
import type { RawAnalysis } from "@/core/engine/analysis";
import { METHODOLOGY_V1 } from "@/core/methodology/v1";
import { deriveReview, type GameReview } from "@/core/review";
import { readFixture } from "../../../helpers/fixtures";
import { gameFromPgn } from "../../../helpers/games";
import { realOpeningIndex } from "../../../helpers/openings";

/**
 * Regression snapshots (docs/TESTING_STRATEGY.md §4.5, decision Q3): the GameReview of 10 fixture
 * games, derived from RawAnalyses recorded once with the real engine (tests/fixtures/review/raw).
 * Any change to a snapshot needs a methodology version bump and a changelog entry (§9): with
 * UPDATE_REVIEW_SNAPSHOTS=1 a changed snapshot is only rewritten if the version changed.
 */
const GAMES = ["06-blitz", "19-rapid", "10-bullet", "12-blitz", "14-blitz", "23-daily", "07-bullet", "02-blitz", "16-rapid", "21-daily"];
const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures", "review");
const UPDATE = process.env["UPDATE_REVIEW_SNAPSHOTS"] === "1";

/** Deep equality with a 1e-9 tolerance for numbers (floating-point last bits). */
function differences(a: unknown, b: unknown, path = "$"): string[] {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9 ? [] : [`${path}: ${b} → ${a}`];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [`${path}: length ${b.length} → ${a.length}`];
    return a.flatMap((v, i) => differences(v, b[i], `${path}[${i}]`));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => differences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`));
  }
  return a === b ? [] : [`${path}: ${JSON.stringify(b)} → ${JSON.stringify(a)}`];
}

describe("regression snapshots (10 games, Standard preset)", () => {
  it.each(GAMES)("%s", async (name) => {
    const game = await gameFromPgn(readFixture("pgn", "chesscom", `${name}.pgn`));
    const raw = JSON.parse(readFileSync(join(FIXTURES, "raw", `${name}.standard.json`), "utf8")) as RawAnalysis;
    expect(raw.completedAt).toBeDefined();
    const review = deriveReview({ game, raw, index: realOpeningIndex().index, config: METHODOLOGY_V1 });

    // Every engine move and line replays legally (DoD 9), and every move is labelled or explains why not (DoD 12).
    const fens = [game.startFen, ...game.plies.map((p) => p.fenAfter)];
    review.moves.forEach((m, i) => {
      if (m.bestMove) expect(replayUciLine(fens[i]!, [m.bestMove.uci]).illegalAt).toBeUndefined();
      expect(m.graded || m.labelReasons.length > 0).toBe(true);
    });
    expect(review.coverage.complete).toBe(true);

    const file = join(FIXTURES, "snapshots", `${name}.review.json`);
    const stored = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as GameReview) : undefined;
    const diff = stored ? differences(review, stored) : ["no snapshot yet"];
    if (UPDATE && diff.length > 0) {
      if (stored && stored.methodologyVersion === review.methodologyVersion) {
        throw new Error(
          `${name}: the review changed but the methodology version is still ${review.methodologyVersion}. ` +
            `Bump METHODOLOGY_V1.version and add a changelog entry (methodology §9) before updating snapshots.\n${diff.slice(0, 10).join("\n")}`,
        );
      }
      mkdirSync(join(FIXTURES, "snapshots"), { recursive: true });
      writeFileSync(file, `${JSON.stringify(review, null, 1)}\n`);
      return;
    }
    expect(diff, `${name}: the review differs from its snapshot. A methodology change needs a version bump (§9).`).toEqual([]);
  }, 60_000); // the first game also builds the opening index (seconds, more under coverage)
});
