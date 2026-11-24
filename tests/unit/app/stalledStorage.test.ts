import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisController, type AnalysisJobState } from "@/app/analysis/analysisController";
import { useAnalysis } from "@/app/analysis/analysisStore";
import { storedPastMonths } from "@/app/importService";
import { loadReview } from "@/app/review/reviewService";
import { STORAGE_WAIT_MS, resetRepositoriesForTests, withinStorageWait } from "@/app/storage";
import { PRESETS, type RawAnalysis } from "@/core/engine/analysis";
import { METHODOLOGY_V1 } from "@/core/methodology/v1";
import { EMPTY_OPENING_INDEX } from "@/core/openings";
import { deriveReview } from "@/core/review";
import { StorageError } from "@/infra/storage/errors";
import { memoryRepositories, type AnalysisRepository, type Repositories } from "@/infra/storage/repositories";
import type * as EngineModule from "@/app/analysis/engine";
import { FakeSearcher, delayedLegalReply, legalReply } from "../../helpers/fakeSearcher";
import { gameFromUci } from "../../helpers/games";
import { rawFromScores } from "../../helpers/review";

// The store's engine, replaced so the real store can run without a browser.
vi.mock("@/app/analysis/engine", async (original) => ({
  ...(await original<typeof EngineModule>()),
  getEnginePool: () => new FakeSearcher(),
}));

const WAIT = 40;
const never = <T>() => new Promise<T>(() => undefined);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function run(analyses: () => Promise<AnalysisRepository>, searcher = new FakeSearcher()) {
  const states: AnalysisJobState[] = [];
  const problems: unknown[] = [];
  const instance = new AnalysisController({
    searcher: () => searcher,
    analyses,
    onState: (s) => states.push(s),
    onStorageError: (e) => problems.push(e),
    saveIntervalMs: 5,
    storageWaitMs: WAIT,
  });
  return { instance, states, problems, searcher };
}
const game3 = () => gameFromUci(["e2e4", "e7e5"]);

beforeEach(() => useAnalysis.setState({ view: undefined }));
afterEach(() => {
  resetRepositoriesForTests();
  vi.useRealTimers();
});

describe("withinStorageWait", () => {
  it("passes results and errors through, and rejects as slow at the limit (3 s by default)", async () => {
    expect(STORAGE_WAIT_MS).toBe(3000);
    expect(await withinStorageWait(Promise.resolve(7))).toBe(7);
    await expect(withinStorageWait(Promise.reject(new StorageError("quota", "full")))).rejects.toMatchObject({ kind: "quota" });
    await expect(withinStorageWait(never(), 10)).rejects.toMatchObject({ kind: "slow" });
  });
});

describe("analysis with stalled or slow storage", () => {
  it("runs to the end in memory when storage never answers, and says so", async () => {
    const { instance, problems, searcher } = run(() => never());
    const result = await instance.start(await game3(), PRESETS.quick);
    expect(result).toMatchObject({ status: "completed" });
    expect(result.analysis?.completedCount).toBe(3);
    expect(result.error).toContain("storage is slow");
    expect(searcher.requests).toHaveLength(3);
    expect(problems).toMatchObject([{ kind: "slow" }]);
  });

  it("saves once storage answers during the run", async () => {
    const repo = memoryRepositories().analyses;
    const open = deferred<AnalysisRepository>();
    const { instance } = run(() => open.promise, new FakeSearcher(delayedLegalReply(60)));
    const done = instance.start(await game3(), PRESETS.quick);
    await pause(WAIT + 20);
    open.resolve(repo);
    const result = await done;
    expect(result.error).toBeUndefined();
    expect((await repo.get(result.analysisId))?.completedCount).toBe(3);
  });

  it("saves after the run when storage answers only then, and takes the notice away", async () => {
    const repo = memoryRepositories().analyses;
    const open = deferred<AnalysisRepository>();
    const { instance, states } = run(() => open.promise);
    const result = await instance.start(await game3(), PRESETS.quick);
    expect(result.error).toContain("storage is slow");
    open.resolve(repo);
    await vi.waitFor(async () => expect((await repo.get(result.analysisId))?.completedCount).toBe(3));
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: "completed", late: true }));
    expect(states.at(-1)!.error).toBeUndefined();
  });

  it("a late save never replaces a stored result", async () => {
    const game = await game3();
    const repo = memoryRepositories().analyses;
    const first = await run(() => Promise.resolve(repo)).instance.start(game, PRESETS.quick);
    // Mark the stored results so a replacement would show, and drop one so there is something to add.
    const stored = structuredClone((await repo.get(first.analysisId))!);
    for (const p of stored.positions) if (p?.status === "done") p.timeMs = 4242;
    stored.positions[2] = null;
    stored.completedCount = 2;
    delete stored.completedAt;
    const fresh = memoryRepositories().analyses;
    await fresh.save(stored, 1);

    const open = deferred<AnalysisRepository>();
    const second = run(() => open.promise);
    await second.instance.start(game, PRESETS.quick);
    open.resolve(fresh);
    await vi.waitFor(async () => expect((await fresh.get(first.analysisId))?.completedCount).toBe(3));
    const after = (await fresh.get(first.analysisId))!;
    expect(after.positions.slice(0, 2)).toEqual(stored.positions.slice(0, 2));
    expect(after.positions[2]).toMatchObject({ status: "done", timeMs: 1 });
  });

  it("does not save over a stored analysis that turns out to be unreadable late", async () => {
    const open = deferred<AnalysisRepository>();
    const save = vi.fn();
    const { instance, states } = run(() => open.promise);
    await instance.start(await game3(), PRESETS.quick);
    open.resolve({ ...memoryRepositories().analyses, get: () => Promise.reject(new StorageError("invalid_record", "bad")), save });
    await vi.waitFor(() => expect(states.at(-1)!.error).toContain("not being saved"));
    expect(save).not.toHaveBeenCalled();
  });

  it("reports, and doesn't save, when what storage held can't be combined with the run", async () => {
    const game = await game3();
    const other = await run(() => Promise.resolve(memoryRepositories().analyses)).instance.start(game, PRESETS.quick);
    const mismatched = { ...structuredClone(other.analysis!), totalCount: 99 };
    const open = deferred<AnalysisRepository>();
    const save = vi.fn();
    const { instance, states, problems } = run(() => open.promise);
    await instance.start(game, PRESETS.quick);
    open.resolve({ ...memoryRepositories().analyses, get: () => Promise.resolve(mismatched), save });
    await vi.waitFor(() => expect(states.at(-1)!.error).toContain("Saving failed"));
    expect(save).not.toHaveBeenCalled();
    expect(problems).toHaveLength(2); // slow, then the failed combination
  });

  it("carries on in memory when asking for storage throws at once", async () => {
    const { instance, problems } = run(() => {
      throw new StorageError("unavailable", "no storage");
    });
    const result = await instance.start(await game3(), PRESETS.quick);
    expect(result).toMatchObject({ status: "completed" });
    expect(result.error).toContain("not being saved");
    expect(problems).toHaveLength(1);
  });

  it("ends the run when a save stalls, and the newest results are saved when it recovers", async () => {
    const base = memoryRepositories().analyses;
    const gate = deferred<void>();
    const saved: RawAnalysis[] = [];
    let writing = 0;
    let mostAtOnce = 0;
    const slow: AnalysisRepository = {
      ...base,
      save: async (analysis, now) => {
        mostAtOnce = Math.max(mostAtOnce, ++writing);
        await gate.promise;
        writing--;
        saved.push(analysis);
        return base.save(analysis, now);
      },
    };
    const { instance, states } = run(() => Promise.resolve(slow), new FakeSearcher((r, i) => delayedLegalReply(20 + 40 * i)(r)));
    const result = await instance.start(await game3(), PRESETS.quick);
    expect(result).toMatchObject({ status: "completed" });
    expect(result.error).toContain("storage is slow");
    gate.resolve();
    await vi.waitFor(async () => expect((await base.get(result.analysisId))?.completedCount).toBe(3));
    await vi.waitFor(() => expect(states.at(-1)!.error).toBeUndefined());
    expect(mostAtOnce).toBe(1);
    expect(saved).toHaveLength(2); // the one that stalled, then the newest results
  });

  it("an older run's late save doesn't lose a newer run's results", async () => {
    const game = await game3();
    const repo = memoryRepositories().analyses;
    const open = deferred<AnalysisRepository>();
    let calls = 0;
    const { instance, states } = run(() => (calls++ === 0 ? open.promise : Promise.resolve(repo)), new FakeSearcher((r, i) => (i === 1 ? new Error("failed once") : legalReply(r))));
    await instance.start(game, PRESETS.quick); // in memory, one position failed
    const newer = await instance.start(game, PRESETS.quick);
    expect((await repo.get(newer.analysisId))?.completedCount).toBe(3);
    open.resolve(repo);
    await pause(30);
    expect((await repo.get(newer.analysisId))?.completedCount).toBe(3);
    expect(states.filter((s) => s.late)).toEqual([]); // the older run no longer speaks for the view
  });

  it("can be cancelled while storage is stalled", async () => {
    const { instance } = run(() => never(), new FakeSearcher(() => never()));
    const done = instance.start(await game3(), PRESETS.quick);
    await pause(WAIT + 20);
    await instance.cancel();
    expect(await done).toMatchObject({ status: "cancelled" });
  });
});

describe("the analysis view and late answers", () => {
  it("a stored analysis that loads late doesn't replace the view of another preset", async () => {
    const game = await game3();
    const answers = [deferred<RawAnalysis | undefined>(), deferred<RawAnalysis | undefined>()];
    let call = 0;
    const base = memoryRepositories();
    const repos: Repositories = { ...base, analyses: { ...base.analyses, get: () => answers[call++]!.promise } };
    resetRepositoriesForTests(Promise.resolve(repos));
    const first = useAnalysis.getState().show(game, "quick");
    await vi.waitFor(() => expect(call).toBe(1));
    const second = useAnalysis.getState().show(game, "standard");
    await vi.waitFor(() => expect(call).toBe(2));
    answers[1]!.resolve(undefined);
    await second;
    answers[0]!.resolve(rawFromScores(game, [0, 0, 0].map(() => ({ score: { kind: "cp" as const, value: 1 } }))));
    await first;
    expect(useAnalysis.getState().view).toMatchObject({ preset: "standard", status: "none" });
  });

  const stalledRun = async () => {
    const game = await game3();
    const open = deferred<Repositories>();
    resetRepositoriesForTests(open.promise);
    await useAnalysis.getState().start(game, "quick"); // waits the real limit, then runs in memory
    expect(useAnalysis.getState().view).toMatchObject({ preset: "quick", status: "completed" });
    expect(useAnalysis.getState().view!.error).toContain("storage is slow");
    return { game, open };
  };

  it("takes the notice away when the finished run is still the one shown", async () => {
    const { open } = await stalledRun();
    open.resolve(memoryRepositories());
    await vi.waitFor(() => expect(useAnalysis.getState().view!.error).toBeUndefined());
    expect(useAnalysis.getState().view).toMatchObject({ preset: "quick", status: "completed" });
  }, 15_000);

  it("a run whose save ends late doesn't replace the view of another preset", async () => {
    const { game, open } = await stalledRun();
    const shown = useAnalysis.getState().show(game, "standard");
    const repositories = memoryRepositories();
    const gate = deferred<void>(); // the save ends only after the newer view is on screen
    const save = repositories.analyses.save.bind(repositories.analyses);
    repositories.analyses.save = async (analysis, now) => {
      await gate.promise;
      return save(analysis, now);
    };
    open.resolve(repositories);
    await shown;
    expect(useAnalysis.getState().view).toMatchObject({ preset: "standard", status: "none" });
    gate.resolve();
    await vi.waitFor(async () => expect(await repositories.analyses.listForGame(game.id)).toHaveLength(1));
    await pause(50);
    expect(useAnalysis.getState().view).toMatchObject({ preset: "standard", status: "none" });
  }, 15_000);
});

describe("the review cache with stalled storage", () => {
  const make = async () => {
    const game = await game3();
    const raw = rawFromScores(game, [0, 1, 2].map((value) => ({ score: { kind: "cp" as const, value } })));
    const deriver = { derive: vi.fn(() => Promise.resolve(deriveReview({ game, raw, index: EMPTY_OPENING_INDEX, config: METHODOLOGY_V1 }))) };
    return { game, raw, deriver };
  };
  it("derives the review when the cache never answers, without raising a storage alarm", async () => {
    const { game, raw, deriver } = await make();
    const onStorageError = vi.fn();
    const result = await loadReview(game, raw, { reviews: () => never(), deriver, onStorageError, storageWaitMs: WAIT });
    expect(result).toMatchObject({ source: "derived", cached: false });
    expect(onStorageError).not.toHaveBeenCalled();
  });
  it("shows the review when storing it stalls", async () => {
    const { game, raw, deriver } = await make();
    const reviews = { ...memoryRepositories().reviews, put: () => never<void>() };
    expect(await loadReview(game, raw, { reviews: () => Promise.resolve(reviews), deriver, storageWaitMs: WAIT })).toMatchObject({ source: "derived", cached: false });
  });
});

describe("the Chess.com month cache with stalled storage", () => {
  it("counts as not cached, and a stalled store doesn't block; other errors still surface", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetRepositoriesForTests(never<Repositories>());
    const get = storedPastMonths.get("https://api.chess.com/x");
    const set = storedPastMonths.set("https://api.chess.com/x", {});
    await vi.advanceTimersByTimeAsync(STORAGE_WAIT_MS);
    expect(await get).toBeUndefined();
    await set;
    vi.useRealTimers();
    const failing = { ...memoryRepositories(), pastMonths: { get: () => Promise.reject(new StorageError("quota", "x")), set: () => Promise.resolve() } };
    resetRepositoriesForTests(Promise.resolve(failing));
    await expect(storedPastMonths.get("u")).rejects.toMatchObject({ kind: "quota" });
  });
});
