import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGames } from "@/app/games";
import {
  openRepositories,
  reportStorageError,
  requestPersistenceOnce,
  resetRepositoriesForTests,
  useStorageStatus,
} from "@/app/storage";
import { AppDatabase } from "@/infra/storage/db";
import { StorageError } from "@/infra/storage/errors";
import type { Repositories } from "@/infra/storage/repositories";
import { gameFromUci } from "../../helpers/games";
import { testDatabase } from "../../helpers/storage";

beforeEach(() => {
  resetRepositoriesForTests();
  useGames.setState({ byId: {}, order: [], listLoaded: false, missing: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openRepositories", () => {
  it("uses IndexedDB when it opens", async () => {
    const repos = await openRepositories(() => testDatabase());
    expect(useStorageStatus.getState()).toMatchObject({ mode: "indexeddb", problem: undefined });
    const game = await gameFromUci(["e2e4"]);
    await repos.games.put(game, 1);
    expect(await repos.games.get(game.id)).toBeDefined();
  });

  it("falls back to memory and explains why when IndexedDB is unavailable", async () => {
    // Node has no global indexedDB, so a database without the fake fails to open (MissingAPIError).
    const repos = await openRepositories(() => new AppDatabase("no-indexeddb-here"));
    const status = useStorageStatus.getState();
    expect(status.mode).toBe("memory");
    expect(status.problem?.kind).toBe("unavailable");
    expect(status.problem?.message).toContain("isn't letting the app save data");
    const game = await gameFromUci(["e2e4"]);
    await repos.games.put(game, 1);
    expect((await repos.games.list()).map((g) => g.id)).toEqual([game.id]);
  });

  it("falls back to memory when creating the database throws", async () => {
    await openRepositories(() => {
      throw Object.assign(new Error("denied"), { name: "SecurityError" });
    });
    expect(useStorageStatus.getState()).toMatchObject({ mode: "memory", problem: { kind: "unavailable", detail: "denied" } });
  });
});

describe("reportStorageError", () => {
  it("shows a quota problem with its message", () => {
    reportStorageError(new StorageError("quota", "QuotaExceededError"));
    expect(useStorageStatus.getState().problem).toMatchObject({ kind: "quota", detail: "QuotaExceededError" });
    useStorageStatus.getState().dismiss();
    expect(useStorageStatus.getState().problem).toBeUndefined();
  });
});

describe("requestPersistenceOnce (decision D7)", () => {
  it("asks once, after IndexedDB is in use, and records the answer", async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("navigator", { storage: { persist, persisted: () => Promise.resolve(false) } });
    await openRepositories(() => testDatabase());
    await requestPersistenceOnce();
    await requestPersistenceOnce();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(useStorageStatus.getState().persisted).toBe(true);
  });

  it("does not ask again when already persisted, and records a refusal without an error", async () => {
    const persist = vi.fn(() => Promise.resolve(false));
    vi.stubGlobal("navigator", { storage: { persist, persisted: () => Promise.resolve(true) } });
    await openRepositories(() => testDatabase());
    await requestPersistenceOnce();
    expect(persist).not.toHaveBeenCalled();
    expect(useStorageStatus.getState()).toMatchObject({ persisted: true, problem: undefined });
  });

  it("records unsupported when the API is missing, and does nothing in memory mode", async () => {
    vi.stubGlobal("navigator", {});
    await openRepositories(() => testDatabase());
    await requestPersistenceOnce();
    expect(useStorageStatus.getState().persisted).toBe("unsupported");

    resetRepositoriesForTests();
    await openRepositories(() => new AppDatabase("no-indexeddb-here-2"));
    await requestPersistenceOnce();
    expect(useStorageStatus.getState().persisted).toBeUndefined();
  });
});

describe("games store (approved change A10)", () => {
  async function useDatabase(name?: string): Promise<Repositories> {
    const repos = openRepositories(() => testDatabase(name));
    resetRepositoriesForTests(repos);
    return repos;
  }

  it("adds games in memory at once and saves them", async () => {
    const repos = await useDatabase();
    const game = await gameFromUci(["e2e4"]);
    const adding = useGames.getState().add([game]);
    expect(useGames.getState().byId[game.id]).toBeDefined(); // before the save finishes
    await adding;
    expect(await repos.games.get(game.id)).toMatchObject({ id: game.id, schemaVersion: 1 });
  });

  it("resolves only once the game is stored, so navigating right after an import can't lose it", async () => {
    const repos = await useDatabase();
    const game = await gameFromUci(["e2e4", "c7c5"]);
    await useGames.getState().add([game]);
    // Read through a separate path: the record must already be committed.
    expect(await repos.games.get(game.id)).toMatchObject({ id: game.id });
  });

  it("does not wait for a persistence prompt the user hasn't answered", async () => {
    vi.stubGlobal("navigator", { storage: { persisted: () => Promise.resolve(false), persist: () => new Promise<boolean>(() => undefined) } });
    await useDatabase();
    const game = await gameFromUci(["d2d4", "d7d5"]);
    const settled = await Promise.race([
      useGames.getState().add([game]).then(() => "saved"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
    ]);
    expect(settled).toBe("saved");
  });

  it("loads saved games after a reload, and marks unknown ids as missing", async () => {
    const name = `games-reload-${Date.now()}`;
    await useDatabase(name);
    const game = await gameFromUci(["d2d4"]);
    await useGames.getState().add([game]);

    // "Reload": new store state, new connection to the same database.
    useGames.setState({ byId: {}, order: [], listLoaded: false, missing: {} });
    await useDatabase(name);
    await useGames.getState().load(game.id);
    expect(useGames.getState().byId[game.id]?.plies).toHaveLength(1);
    await useGames.getState().load("pgn:nope");
    expect(useGames.getState().missing["pgn:nope"]).toBe(true);

    await useGames.getState().loadAll();
    expect(useGames.getState()).toMatchObject({ listLoaded: true, order: [game.id] });
  });

  it("keeps a game in memory and reports the problem when saving fails", async () => {
    const failing: Repositories = {
      ...(await openRepositories(() => testDatabase())),
    };
    failing.games = { ...failing.games, put: () => Promise.reject(new StorageError("quota", "full")) };
    resetRepositoriesForTests(Promise.resolve(failing));
    const game = await gameFromUci(["c2c4"]);
    await useGames.getState().add([game]);
    expect(useGames.getState().byId[game.id]).toBeDefined();
    expect(useStorageStatus.getState().problem?.kind).toBe("quota");
  });

  it("lists memory-only games next to saved ones", async () => {
    await useDatabase();
    const saved = await gameFromUci(["e2e4"]);
    await useGames.getState().add([saved]);
    const memoryOnly = await gameFromUci(["g1f3"]);
    useGames.setState((s) => ({ byId: { ...s.byId, [memoryOnly.id]: memoryOnly }, order: [memoryOnly.id, ...s.order] }));
    await useGames.getState().loadAll();
    expect(useGames.getState().order).toEqual([memoryOnly.id, saved.id]);
  });
});
