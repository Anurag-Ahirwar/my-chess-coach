import { z } from "zod";
import { ChessComError } from "./errors";
import { ArchivesSchema, GameSchema, ProfileSchema, type ChessComGame, type ChessComProfile } from "./schemas";
import { normaliseUsername } from "./username";

export interface ArchiveMonth {
  year: number;
  month: number;
  url: string;
}

export interface MonthGames {
  games: ChessComGame[];
  /** Games in the response that failed validation and were left out. */
  skipped: number;
}

export interface ChessComClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  baseUrl?: string;
  /** Waits before retrying after HTTP 429. */
  backoffMs?: readonly number[];
  /** Where past months are kept (they never change). Defaults to memory; the app passes IndexedDB. */
  pastMonthCache?: PastMonthCache;
}

/** Storage for past months' raw response bodies, keyed by URL (decision D5). */
export interface PastMonthCache {
  get(url: string): Promise<unknown>;
  set(url: string, body: unknown): Promise<void>;
}

/** The default cache: in memory, for the lifetime of the client. */
export class MemoryPastMonthCache implements PastMonthCache {
  private readonly entries = new Map<string, unknown>();
  get(url: string): Promise<unknown> {
    return Promise.resolve(this.entries.get(url));
  }
  set(url: string, body: unknown): Promise<void> {
    this.entries.set(url, body);
    return Promise.resolve();
  }
}

const DEFAULT_BASE_URL = "https://api.chess.com/pub/player";
const DEFAULT_BACKOFF_MS = [2000, 4000, 8000] as const;
const ARCHIVE_URL_PATTERN = /\/games\/(\d{4})\/(\d{2})$/;

/**
 * Client for the Chess.com Published-Data API.
 *
 * - Requests are strictly serial; parallel requests may be answered with 429.
 * - Past months never change, so they are cached (in memory, or IndexedDB in the app).
 *   A cache failure never fails a request: the month is simply fetched.
 * - Everything else is fetched with `cache: "no-cache"`: the browser's HTTP
 *   cache revalidates with its stored ETag (a 304 is served from cache). The
 *   API's CORS policy neither exposes `ETag` to scripts nor accepts
 *   `If-None-Match` from them, so conditional requests are left to the browser.
 */
export class ChessComClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private readonly backoffMs: readonly number[];
  private readonly pastMonths: PastMonthCache;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ChessComClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.pastMonths = options.pastMonthCache ?? new MemoryPastMonthCache();
  }

  async getProfile(username: string): Promise<ChessComProfile> {
    const user = requireUsername(username);
    return parse(ProfileSchema, await this.getJson(`${this.baseUrl}/${user}`));
  }

  /** Monthly archives, newest first. */
  async getArchives(username: string): Promise<ArchiveMonth[]> {
    const user = requireUsername(username);
    const { archives } = parse(ArchivesSchema, await this.getJson(`${this.baseUrl}/${user}/games/archives`));
    return archives
      .flatMap((url) => {
        const match = ARCHIVE_URL_PATTERN.exec(url);
        return match ? [{ year: Number(match[1]), month: Number(match[2]), url }] : [];
      })
      .sort((a, b) => b.year - a.year || b.month - a.month);
  }

  /** Games of one month, newest first. Individually invalid games are skipped and counted. */
  async getMonthGames(username: string, year: number, month: number): Promise<MonthGames> {
    const user = requireUsername(username);
    const url = `${this.baseUrl}/${user}/games/${year}/${String(month).padStart(2, "0")}`;
    const body = await this.getJson(url, { immutable: this.isPastMonth(year, month) });
    const { games: rawGames } = parse(z.looseObject({ games: z.array(z.unknown()) }), body);
    const games: ChessComGame[] = [];
    let skipped = 0;
    for (const raw of rawGames) {
      const result = GameSchema.safeParse(raw);
      if (result.success) games.push(result.data);
      else skipped++;
    }
    games.sort((a, b) => (b.end_time ?? 0) - (a.end_time ?? 0));
    return { games, skipped };
  }

  private isPastMonth(year: number, month: number): boolean {
    const now = this.now();
    const current = now.getUTCFullYear() * 12 + now.getUTCMonth();
    return year * 12 + (month - 1) < current;
  }

  private async getJson(url: string, { immutable = false } = {}): Promise<unknown> {
    if (immutable) {
      const cached = await this.readCache(url);
      if (cached !== undefined) return cached;
    }
    const task = this.queue.then(async () => {
      if (immutable) {
        const cached = await this.readCache(url); // filled by an earlier request in the queue?
        if (cached !== undefined) return cached;
      }
      const body = await this.fetchWithBackoff(url);
      if (immutable) await this.pastMonths.set(url, body).catch(() => undefined);
      return body;
    });
    // Keep the queue alive after a failure; callers still see their own rejection.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private readCache(url: string): Promise<unknown> {
    return this.pastMonths.get(url).catch(() => undefined);
  }

  private async fetchWithBackoff(url: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { cache: "no-cache", headers: { Accept: "application/json" } });
      } catch (error) {
        throw new ChessComError("offline", undefined, error instanceof Error ? error.message : undefined);
      }
      if (response.status === 429) {
        const wait = this.backoffMs[attempt];
        if (wait === undefined) throw new ChessComError("rate_limited", 429);
        await this.sleep(wait);
        continue;
      }
      if (response.status === 404) throw new ChessComError("not_found", 404);
      if (response.status === 410) throw new ChessComError("gone", 410);
      if (!response.ok) throw new ChessComError("http", response.status, `HTTP ${response.status}`);
      try {
        return await response.json();
      } catch {
        throw new ChessComError("invalid_response", response.status, "body is not JSON");
      }
    }
  }
}

function requireUsername(input: string): string {
  const user = normaliseUsername(input);
  if (!user) throw new ChessComError("invalid_username");
  return encodeURIComponent(user);
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ChessComError("invalid_response", undefined, result.error.issues[0]?.message);
  return result.data;
}
