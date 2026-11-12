import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAnalysis } from "@/app/analysis/analysisStore";
import { useGames } from "@/app/games";
import { requestReview, startReviewSync, stopReviewSyncForTests, useReview } from "@/app/review/reviewStore";
import type { ReviewDeriver } from "@/app/review/reviewService";
import { openRepositories, resetRepositoriesForTests } from "@/app/storage";
import type { RawAnalysis } from "@/core/engine/analysis";
import type { GameRecord } from "@/core/game/types";
import { METHODOLOGY_V1 } from "@/core/methodology/v1";
import { EMPTY_OPENING_INDEX } from "@/core/openings";
import { deriveReview } from "@/core/review";
import { gameFromUci } from "../../helpers/games";
import { rawFromScores, type SyntheticPosition } from "../../helpers/review";
import { testDatabase } from "../../helpers/storage";

function deriver() {
  const calls: number[] = [];
  const d: ReviewDeriver = {
    derive: (game, raw) => {
      calls.push(raw.completedCount);
      return Promise.resolve(deriveReview({ game, raw, index: EMPTY_OPENING_INDEX, config: METHODOLOGY_V1 }));
    },
  };
  return { d, calls };
}

const at = (value: number): SyntheticPosition => ({ score: { kind: "cp", value } });
const pending: SyntheticPosition = { score: { kind: "cp", value: 0 }, status: "pending" };

let game: GameRecord;
beforeEach(async () => {
  resetRepositoriesForTests(openRepositories(() => testDatabase()));
  game = await gameFromUci(["e2e4", "e7e5", "g1f3", "b8c6"]);
  useGames.setState({ byId: { [game.id]: game }, order: [game.id], listLoaded: true, missing: {} });
});
afterEach(() => {
  stopReviewSyncForTests();
  useAnalysis.setState({ view: undefined });
  vi.useRealTimers();
});

describe("requestReview", () => {
  it("derives a complete analysis once, then serves it from the cache", async () => {
    const raw = rawFromScores(game, [20, 25, 20, 30, 25].map(at));
    const { d, calls } = deriver();
    await requestReview(game, raw, d);
    expect(useReview.getState()).toMatchObject({ status: "ready", source: "derived", analysisId: raw.id });
    expect(useReview.getState().timings!.totalMs).toBeGreaterThanOrEqual(0);
    await requestReview(game, raw, d);
    expect(useReview.getState()).toMatchObject({ status: "ready", source: "cache" });
    expect(calls).toEqual([5]);
  });

  it("the latest request wins; an earlier one never overwrites it", async () => {
    const raw = rawFromScores(game, [20, 25, 20, 30, 25].map(at));
    let release: () => void = () => undefined;
    const slow: ReviewDeriver = {
      derive: (g, r) => new Promise((resolve) => (release = () => resolve(deriveReview({ game: g, raw: r, index: EMPTY_OPENING_INDEX, config: METHODOLOGY_V1 })))),
    };
    const partial = rawFromScores(game, [at(20), at(25), pending, pending, pending]);
    const first = requestReview(game, partial, slow);
    const { d } = deriver();
    await requestReview(game, raw, d);
    release();
    await first;
    expect(useReview.getState().review!.coverage.complete).toBe(true);
  });

  it("reports a failed derivation as an error", async () => {
    const raw = rawFromScores(game, [20, 25, 20, 30, 25].map(at));
    await requestReview(game, raw, { derive: () => Promise.reject(new Error("worker crashed")) });
    expect(useReview.getState()).toMatchObject({ status: "error", error: "worker crashed" });
  });
});

describe("following the analysis store (partial analyses)", () => {
  const view = (raw: RawAnalysis, status: "running" | "completed" | "saved") =>
    useAnalysis.setState({ view: { gameId: game.id, preset: "standard", analysisId: raw.id, status, analysis: raw, reused: false } });

  it("refreshes a running analysis at most every 500 ms, then at once when it completes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { d, calls } = deriver();
    startReviewSync({ deriver: d });
    view(rawFromScores(game, [at(20), pending, pending, pending, pending]), "running");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([1]);
    view(rawFromScores(game, [at(20), at(25), pending, pending, pending]), "running");
    view(rawFromScores(game, [at(20), at(25), at(20), pending, pending]), "running");
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([1]); // throttled
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual([1, 3]); // only the latest partial analysis
    const partial = useReview.getState().review!;
    expect(partial.coverage).toMatchObject({ pending: 2, complete: false });
    expect(partial.white.accuracy).toBeUndefined(); // no final-looking numbers
    // A complete analysis is reviewed at once (no throttle); it first checks the IndexedDB cache.
    vi.useRealTimers();
    view(rawFromScores(game, [20, 25, 20, 30, 25].map(at)), "completed");
    await vi.waitFor(() => expect(calls).toEqual([1, 3, 5]));
    await vi.waitFor(() => expect(useReview.getState().status).toBe("ready"));
    expect(useReview.getState().review!.coverage.complete).toBe(true);
    expect(useReview.getState().review!.white.accuracy).toBeDefined();
  });

  it("reviews a saved analysis at once, and clears the review when the analysis goes away", async () => {
    const { d } = deriver();
    startReviewSync({ deriver: d });
    view(rawFromScores(game, [20, 25, 20, 30, 25].map(at)), "saved");
    await vi.waitFor(() => expect(useReview.getState().status).toBe("ready"));
    useAnalysis.setState({ view: undefined });
    await vi.waitFor(() => expect(useReview.getState()).toMatchObject({ status: "idle", review: undefined }));
  });
});
