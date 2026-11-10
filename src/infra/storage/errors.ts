export type StorageProblemKind =
  /** IndexedDB is missing, disabled (e.g. some private modes) or failed to open. */
  | "unavailable"
  /** The browser refused a write because storage is full. */
  | "quota"
  /** Another tab has the database open in an older version. */
  | "blocked"
  /** The database was closed (e.g. another tab upgraded it). */
  | "closed"
  /** A stored record failed validation; it is left untouched. */
  | "invalid_record"
  | "unknown";

export class StorageError extends Error {
  constructor(
    readonly kind: StorageProblemKind,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

const MESSAGES: Record<StorageProblemKind, string> = {
  unavailable: "This browser isn't letting the app save data (IndexedDB is unavailable). Games and analyses are kept only until you close this tab.",
  quota: "Browser storage is full, so the latest changes weren't saved. They are kept until you close this tab.",
  blocked: "The app is open in another tab with an older version. Close the other tab to keep saving.",
  closed: "The app was updated in another tab. Reload this page to keep saving.",
  invalid_record: "A saved record couldn't be read. It was left untouched and isn't shown.",
  unknown: "Saving failed for an unexpected reason. Changes are kept until you close this tab.",
};

export function storageMessage(kind: StorageProblemKind): string {
  return MESSAGES[kind];
}

/** Maps Dexie / DOMException errors (including wrapped inner errors) onto a problem kind. */
export function classifyStorageError(error: unknown): StorageProblemKind {
  if (error instanceof StorageError) return error.kind;
  const names = new Set<string>();
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 4; depth++) {
    const name = (current as { name?: unknown }).name;
    if (typeof name === "string") names.add(name);
    current = (current as { inner?: unknown }).inner;
  }
  if (names.has("QuotaExceededError")) return "quota";
  if (names.has("MissingAPIError") || names.has("OpenFailedError") || names.has("InvalidAccessError") || names.has("SecurityError")) {
    return "unavailable";
  }
  if (names.has("DatabaseClosedError")) return "closed";
  if (names.has("VersionError") || names.has("BlockedError")) return "blocked";
  return "unknown";
}
