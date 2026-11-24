import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAVE_WAIT_MS, addGamesWithin, useGames } from "@/app/games";
import { resetRepositoriesForTests, useStorageStatus } from "@/app/storage";
import { StorageError } from "@/infra/storage/errors";
import { memoryRepositories, type Repositories } from "@/infra/storage/repositories";
import { gameFromUci } from "../../helpers/games";

/** Repositories whose game save is settled by the test, one call at a time. */
function controlled() {
  const base = memoryRepositories();
  const calls: { id: string; finish: () => void; fail: (error: unknown) => void }[] = [];
  const repos: Repositories = {
    ...base,
    games: {
      ...base.games,
      put: (game, now) =>
        new Promise((resolve, reject) => {
          calls.push({ id: game.id, finish: () => resolve({ ...game, schemaVersion: 1, createdAt: now, updatedAt: now }), fail: reject });
        }),
    },
  };
  return { repos, calls };
}
const until = (check: () => void) => vi.waitFor(check);
const unsaved = () => useGames.getState().unsaved;

beforeEach(() => {
  useGames.setState({ byId: {}, order: [], listLoaded: false, missing: {}, unsaved: {} });
});
afterEach(() => {
  resetRepositoriesForTests();
  vi.useRealTimers();
});

describe("importing with slow storage (capped wait)", () => {
  it("waits for a normal save: the game is stored before it resolves, and nothing is left unsaved", async () => {
    const repos = memoryRepositories();
    resetRepositoriesForTests(Promise.resolve(repos));
    const game = await gameFromUci(["e2e4", "a7a6"]);
    expect(await addGamesWithin([game])).toBe("finished");
    expect(await repos.games.get(game.id)).toBeDefined();
    expect(unsaved()).toEqual({});
  });

  it("stops waiting at the limit, marks the game as saving, and clears that when the save finishes later", async () => {
    const { repos, calls } = controlled();
    resetRepositoriesForTests(Promise.resolve(repos));
    const game = await gameFromUci(["d2d4", "a7a6"]);
    expect(await addGamesWithin([game], 30)).toBe("still-saving");
    expect(useGames.getState().byId[game.id]).toBeDefined();
    expect(unsaved()).toEqual({ [game.id]: "saving" });
    calls[0]!.finish();
    await until(() => expect(unsaved()).toEqual({}));
  });

  it("waits exactly SAVE_WAIT_MS (3 s) by default, even when storage never opens", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetRepositoriesForTests(new Promise<Repositories>(() => undefined));
    const game = await gameFromUci(["c2c4", "a7a6"]);
    let result: string | undefined;
    void addGamesWithin([game]).then((r) => (result = r));
    expect(SAVE_WAIT_MS).toBe(3000);
    await vi.advanceTimersByTimeAsync(2999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe("still-saving");
    expect(unsaved()).toEqual({ [game.id]: "saving" });
  });

  it("marks a save that fails after the limit as failed and reports the problem", async () => {
    const { repos, calls } = controlled();
    resetRepositoriesForTests(Promise.resolve(repos));
    const game = await gameFromUci(["g1f3", "a7a6"]);
    expect(await addGamesWithin([game], 30)).toBe("still-saving");
    calls[0]!.fail(new StorageError("quota", "full"));
    await until(() => expect(unsaved()).toEqual({ [game.id]: "failed" }));
    expect(useStorageStatus.getState().problem?.kind).toBe("quota");
    expect(useGames.getState().byId[game.id]).toBeDefined();
  });

  it("with several games, only those not yet stored are unsaved", async () => {
    const { repos, calls } = controlled();
    resetRepositoriesForTests(Promise.resolve(repos));
    const first = await gameFromUci(["b2b4", "a7a6"]);
    const second = await gameFromUci(["b2b3", "a7a6"]);
    await addGamesWithin([first, second], 30);
    calls[0]!.finish();
    await until(() => expect(unsaved()).toEqual({ [second.id]: "saving" }));
    await until(() => expect(calls).toHaveLength(2));
    calls[1]!.fail(new StorageError("quota", "full"));
    await until(() => expect(unsaved()).toEqual({ [second.id]: "failed" }));
  });

  it("an earlier save of the same game finishing doesn't hide a later one still running", async () => {
    const { repos, calls } = controlled();
    resetRepositoriesForTests(Promise.resolve(repos));
    const game = await gameFromUci(["f2f4", "a7a6"]);
    await addGamesWithin([game], 10);
    await addGamesWithin([game], 10);
    await until(() => expect(calls).toHaveLength(2));
    calls[0]!.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unsaved()).toEqual({ [game.id]: "saving" });
    calls[1]!.finish();
    await until(() => expect(unsaved()).toEqual({}));
  });
});
