import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisController, type AnalysisJobState, type LockManagerLike } from "@/app/analysis/analysisController";
import { PRESETS, type RawAnalysis } from "@/core/engine/analysis";
import type { AppDatabase } from "@/infra/storage/db";
import { StorageError } from "@/infra/storage/errors";
import { dexieRepositories, type AnalysisRepository } from "@/infra/storage/repositories";
import { FakeSearcher, delayedLegalReply, legalReply } from "../../helpers/fakeSearcher";
import { gameFromUci } from "../../helpers/games";
import { testDatabase } from "../../helpers/storage";

const opened: AppDatabase[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  vi.useRealTimers();
});

function repository(name?: string): AnalysisRepository {
  const db = testDatabase(name);
  opened.push(db);
  return dexieRepositories(db, () => undefined).analyses;
}

/** Wraps a repository to count saves. */
function counting(repo: AnalysisRepository) {
  const saves: RawAnalysis[] = [];
  const wrapped: AnalysisRepository = {
    ...repo,
    save: async (analysis, now) => {
      saves.push(analysis);
      return repo.save(analysis, now);
    },
  };
  return { repo: wrapped, saves };
}

function controller(options: { repo: AnalysisRepository; searcher: FakeSearcher; locks?: LockManagerLike; onStorageError?: (e: unknown) => void }) {
  const states: AnalysisJobState[] = [];
  const instance = new AnalysisController({
    searcher: () => options.searcher,
    analyses: () => Promise.resolve(options.repo),
    onState: (state) => states.push(state),
    saveIntervalMs: 250,
    ...(options.locks ? { locks: options.locks } : {}),
    ...(options.onStorageError ? { onStorageError: options.onStorageError } : {}),
  });
  return { instance, states };
}

const game12 = () => gameFromUci(["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6", "e1g1", "f8e7", "f1e1", "b7b5"]);

describe("AnalysisController", () => {
  it("analyses, saves the complete analysis, and reports pending → running → completed", async () => {
    const game = await game12();
    const repo = repository();
    const { instance, states } = controller({ repo, searcher: new FakeSearcher() });
    const final = await instance.start(game, PRESETS.quick);
    expect(final).toMatchObject({ status: "completed", reused: false });
    expect(states[0]!.status).toBe("pending");
    expect(states.some((s) => s.status === "running")).toBe(true);
    const stored = await repo.get(final.analysisId);
    expect(stored?.completedCount).toBe(13);
    expect(stored?.completedAt).toBeDefined();
  });

  it("throttles saves while running and always saves at the end (decision D12)", async () => {
    const game = await game12();
    const { repo, saves } = counting(repository());
    // Every position answers immediately: 13 updates arrive well within one 250 ms interval.
    const { instance } = controller({ repo, searcher: new FakeSearcher() });
    await instance.start(game, PRESETS.quick);
    expect(saves.length).toBeGreaterThanOrEqual(1);
    expect(saves.length).toBeLessThan(13);
    expect(saves.at(-1)!.completedCount).toBe(13);
  });

  it("saves during a long run, at most once per interval", async () => {
    const game = await game12();
    const { repo, saves } = counting(repository());
    // Results arrive one every 60 ms over ≈ 0.8 s (like a pool working through the queue),
    // with a 250 ms save interval: a few saves, not 13.
    const searcher = new FakeSearcher((request, index) => delayedLegalReply((index + 1) * 60)(request));
    const { instance } = controller({ repo, searcher });
    await instance.start(game, PRESETS.quick);
    expect(saves.length).toBeGreaterThanOrEqual(2); // at least one mid-run save plus the final one
    expect(saves.length).toBeLessThanOrEqual(6);
    expect(saves.at(-1)!.completedCount).toBe(13);
  });

  it("resumes after a reload: only unanalysed positions are searched", async () => {
    const game = await game12();
    const name = `resume-${Date.now()}`;

    // First page: 5 positions finish, the rest are still running when the user stops.
    const firstSearcher = new FakeSearcher((request, index) => (index < 5 ? legalReply(request) : new Promise(() => undefined)));
    const first = controller({ repo: repository(name), searcher: firstSearcher });
    const running = first.instance.start(game, PRESETS.quick);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await first.instance.cancel();
    expect((await running).status).toBe("cancelled");

    // The "reload": a new controller, a new connection to the same database.
    const searcher = new FakeSearcher();
    const second = controller({ repo: repository(name), searcher });
    const resumed = await second.instance.start(game, PRESETS.quick);
    expect(resumed.status).toBe("completed");
    expect(searcher.requests.length).toBe(13 - 5);
    expect(new Set(searcher.requests.map((r) => r.moves.length)).has(0)).toBe(false);
  });

  it("reuses a complete saved analysis with no engine work", async () => {
    const game = await gameFromUci(["e2e4"]);
    const repo = repository();
    await controller({ repo, searcher: new FakeSearcher() }).instance.start(game, PRESETS.quick);
    const searcher = new FakeSearcher();
    const again = await controller({ repo, searcher }).instance.start(game, PRESETS.quick);
    expect(again).toMatchObject({ status: "completed", reused: true });
    expect(searcher.requests).toEqual([]);
  });

  it("keeps Quick and Standard analyses of one game separate", async () => {
    const game = await gameFromUci(["e2e4"]);
    const repo = repository();
    const quick = await controller({ repo, searcher: new FakeSearcher() }).instance.start(game, PRESETS.quick);
    const standard = await controller({ repo, searcher: new FakeSearcher() }).instance.start(game, PRESETS.standard);
    expect(quick.analysisId).not.toBe(standard.analysisId);
    expect(await repo.listForGame(game.id)).toHaveLength(2);
  });

  it("cancels the previous run when a new one starts", async () => {
    const game = await game12();
    // The first game's positions after move 2 never finish by themselves; the second game's do.
    const searcher = new FakeSearcher((request) =>
      request.moves[0] === "e2e4" && request.moves.length >= 2 ? new Promise(() => undefined) : legalReply(request),
    );
    const { instance, states } = controller({ repo: repository(), searcher });
    const first = instance.start(game, PRESETS.quick);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const other = await gameFromUci(["d2d4"]);
    const second = await instance.start(other, PRESETS.quick);
    await first;
    expect(states.some((s) => s.gameId === game.id && s.status === "cancelled")).toBe(true);
    expect(second.gameId).toBe(other.id);
  });

  it("refuses to run when another tab holds the lock for this analysis", async () => {
    const game = await gameFromUci(["e2e4"]);
    const searcher = new FakeSearcher();
    const locks: LockManagerLike = { request: (_name, _options, callback) => callback(null) };
    const result = await controller({ repo: repository(), searcher, locks }).instance.start(game, PRESETS.quick);
    expect(result).toMatchObject({ status: "failed", error: "This game is already being analysed in another tab." });
    expect(searcher.requests).toEqual([]);
  });

  it("takes a lock named after the analysis when locks are available", async () => {
    const game = await gameFromUci(["e2e4"]);
    const names: string[] = [];
    const locks: LockManagerLike = {
      request: (name, _options, callback) => {
        names.push(name);
        return callback({});
      },
    };
    const result = await controller({ repo: repository(), searcher: new FakeSearcher(), locks }).instance.start(game, PRESETS.quick);
    expect(names).toEqual([`chess-coach:analysis:${result.analysisId}`]);
    expect(result.status).toBe("completed");
  });

  it("keeps analysing in memory when saving fails, and says so", async () => {
    const game = await gameFromUci(["e2e4", "e7e5"]);
    const base = repository();
    const failing: AnalysisRepository = { ...base, save: () => Promise.reject(new StorageError("quota", "full")) };
    const onStorageError = vi.fn();
    const result = await controller({ repo: failing, searcher: new FakeSearcher(), onStorageError }).instance.start(game, PRESETS.quick);
    expect(result.status).toBe("completed");
    expect(result.analysis?.completedCount).toBe(3);
    expect(result.error).toContain("Saving failed");
    expect(onStorageError).toHaveBeenCalled();
  });

  it("does not write over a stored analysis it can't read", async () => {
    const game = await gameFromUci(["e2e4"]);
    const base = repository();
    const save = vi.fn((analysis: RawAnalysis, now: number) => base.save(analysis, now));
    const unreadable: AnalysisRepository = { ...base, get: () => Promise.reject(new StorageError("invalid_record", "bad")), save };
    const result = await controller({ repo: unreadable, searcher: new FakeSearcher(), onStorageError: vi.fn() }).instance.start(game, PRESETS.quick);
    expect(result.status).toBe("completed");
    expect(result.error).toContain("not being saved");
    expect(save).not.toHaveBeenCalled();
  });
});
