import { create } from "zustand";
import { AppDatabase } from "@/infra/storage/db";
import { StorageError, classifyStorageError, storageMessage, type StorageProblemKind } from "@/infra/storage/errors";
import { dexieRepositories, memoryRepositories, type Repositories } from "@/infra/storage/repositories";

export interface StorageProblem {
  kind: StorageProblemKind;
  message: string;
  detail?: string;
}

interface StorageStatus {
  /** "indexeddb": saving works; "memory": IndexedDB failed, data lasts until the tab closes. */
  mode: "opening" | "indexeddb" | "memory";
  /** Latest problem, shown in the banner until dismissed. */
  problem: StorageProblem | undefined;
  /** Result of navigator.storage.persist(): whether the browser promised not to evict our data. */
  persisted: boolean | "unsupported" | undefined;
  report: (kind: StorageProblemKind, detail?: string) => void;
  dismiss: () => void;
}

export const useStorageStatus = create<StorageStatus>((set) => ({
  mode: "opening",
  problem: undefined,
  persisted: undefined,
  report: (kind, detail) => set({ problem: { kind, message: storageMessage(kind), ...(detail ? { detail } : {}) } }),
  dismiss: () => set({ problem: undefined }),
}));

/** Reports a failed storage operation. The caller keeps its data in memory. */
export function reportStorageError(error: unknown): void {
  const kind = error instanceof StorageError ? error.kind : classifyStorageError(error);
  useStorageStatus.getState().report(kind, error instanceof Error ? error.message : String(error));
}

/**
 * Opens IndexedDB. If it can't be opened (missing, disabled, blocked), the app keeps working
 * with in-memory repositories and the banner says why. Never deletes or resets existing data.
 */
export async function openRepositories(createDatabase: () => AppDatabase = () => new AppDatabase()): Promise<Repositories> {
  const status = useStorageStatus.getState();
  try {
    const db = createDatabase();
    db.on("blocked", () => status.report("blocked"));
    db.on("versionchange", () => {
      // Another tab is upgrading the schema: step aside so it isn't blocked, and ask for a reload.
      db.close();
      status.report("closed");
      return false;
    });
    await db.open();
    useStorageStatus.setState({ mode: "indexeddb" });
    return dexieRepositories(db, (kind, detail) => status.report(kind, detail));
  } catch (error) {
    useStorageStatus.setState({ mode: "memory" });
    status.report(classifyStorageError(error) === "blocked" ? "blocked" : "unavailable", error instanceof Error ? error.message : String(error));
    return memoryRepositories();
  }
}

let repositories: Promise<Repositories> | undefined;

/** The app's repositories, opened once on first use. */
export function getRepositories(): Promise<Repositories> {
  repositories ??= openRepositories();
  return repositories;
}

/** For tests: forget the opened repositories so the next call opens again. */
export function resetRepositoriesForTests(next?: Promise<Repositories>): void {
  repositories = next;
  useStorageStatus.setState({ mode: "opening", problem: undefined, persisted: undefined });
  persistenceRequested = false;
}

let persistenceRequested = false;

/**
 * Asks the browser not to evict our data (decision D7), once, after the first successful write.
 * The answer is recorded; a refusal is not an error (browsers decide by their own heuristics).
 */
export async function requestPersistenceOnce(): Promise<void> {
  if (persistenceRequested || useStorageStatus.getState().mode !== "indexeddb") return;
  persistenceRequested = true;
  const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage?.persist) {
    useStorageStatus.setState({ persisted: "unsupported" });
    return;
  }
  try {
    const already = (await storage.persisted?.()) ?? false;
    useStorageStatus.setState({ persisted: already || (await storage.persist()) });
  } catch {
    useStorageStatus.setState({ persisted: false });
  }
}
