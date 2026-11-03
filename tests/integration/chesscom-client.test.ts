import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ChessComClient, ChessComError, normaliseUsername } from "@/infra/chesscom";
import { readJsonFixture } from "../helpers/fixtures";

const API = "https://api.chess.com/pub/player";
const profile = readJsonFixture<Record<string, unknown>>("chesscom", "api", "profile-hikaru.json");
const archives = readJsonFixture<{ archives: string[] }>("chesscom", "api", "archives-hikaru.json");
const month = readJsonFixture<{ games: Record<string, unknown>[] }>("chesscom", "api", "month-hikaru.json");

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** A client that never really sleeps, pinned to 2026-11-03. */
const makeClient = (sleep = vi.fn(async () => {})) =>
  new ChessComClient({ sleep, now: () => new Date(Date.UTC(2026, 10, 3)) });

const expectError = async (promise: Promise<unknown>, kind: string) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ChessComError);
  expect((error as ChessComError).kind).toBe(kind);
  return error as ChessComError;
};

describe("normaliseUsername", () => {
  it.each([
    ["Hikaru", "hikaru"],
    ["  @MagnusCarlsen ", "magnuscarlsen"],
    ["daniel_naroditsky", "daniel_naroditsky"],
    ["a-b-c", "a-b-c"],
  ])("%j -> %s", (input, expected) => {
    expect(normaliseUsername(input)).toBe(expected);
  });

  it.each(["", "ab", "a".repeat(26), "has space", "bad!char", "naïve", "../etc"])("rejects %j", (input) => {
    expect(normaliseUsername(input)).toBeUndefined();
  });
});

describe("ChessComClient", () => {
  it("fetches and validates a profile using the lowercase username", async () => {
    let requested = "";
    server.use(
      http.get(`${API}/:user`, ({ params }) => {
        requested = String(params["user"]);
        return HttpResponse.json(profile);
      }),
    );
    const result = await makeClient().getProfile("Hikaru");
    expect(requested).toBe("hikaru");
    expect(result.username.toLowerCase()).toBe("hikaru");
  });

  it("rejects an invalid username without any request", async () => {
    await expectError(makeClient().getArchives("not valid!"), "invalid_username");
  });

  it("lists archives newest first and ignores unexpected URLs", async () => {
    server.use(
      http.get(`${API}/hikaru/games/archives`, () =>
        HttpResponse.json({ archives: [...archives.archives, "https://api.chess.com/pub/weird"] }),
      ),
    );
    const list = await makeClient().getArchives("hikaru");
    expect(list).toHaveLength(archives.archives.length);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]!.year * 12 + list[i - 1]!.month).toBeGreaterThan(list[i]!.year * 12 + list[i]!.month);
    }
  });

  it("returns month games newest first and skips invalid entries", async () => {
    server.use(
      http.get(`${API}/hikaru/games/2026/09`, () => HttpResponse.json({ games: [...month.games, { broken: true }] })),
    );
    const { games, skipped } = await makeClient().getMonthGames("hikaru", 2026, 9);
    expect(games).toHaveLength(month.games.length);
    expect(skipped).toBe(1);
    for (let i = 1; i < games.length; i++) expect(games[i - 1]!.end_time!).toBeGreaterThanOrEqual(games[i]!.end_time!);
    expect(games[0]!.pgn).toContain("[Event");
  });

  it("caches past months and never refetches them", async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/hikaru/games/2026/09`, () => {
        calls++;
        return HttpResponse.json(month);
      }),
    );
    const client = makeClient();
    await client.getMonthGames("hikaru", 2026, 9);
    await client.getMonthGames("hikaru", 2026, 9);
    expect(calls).toBe(1);
  });

  it("refetches the current month with cache: no-cache so the browser revalidates", async () => {
    // MSW's Node interceptor rebuilds the Request and drops its cache mode, so inspect the fetch call itself.
    const fetchSpy = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(Response.json(month)));
    const client = new ChessComClient({ fetch: fetchSpy as typeof fetch, now: () => new Date(Date.UTC(2026, 10, 3)) });
    await client.getMonthGames("hikaru", 2026, 11);
    await client.getMonthGames("hikaru", 2026, 11);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.map(([, init]) => init?.cache)).toEqual(["no-cache", "no-cache"]);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${API}/hikaru/games/2026/11`);
  });

  it("never has two requests in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    server.use(
      http.get(`${API}/:user/games/:year/:month`, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight--;
        return HttpResponse.json({ games: [] });
      }),
    );
    const client = makeClient();
    await Promise.all([1, 2, 3, 4, 5].map((m) => client.getMonthGames("hikaru", 2026, m)));
    expect(maxInFlight).toBe(1);
  });

  it("keeps serving the queue after a failed request", async () => {
    server.use(
      http.get(`${API}/missing`, () => HttpResponse.json({ code: 0, message: "not found" }, { status: 404 })),
      http.get(`${API}/hikaru`, () => HttpResponse.json(profile)),
    );
    const client = makeClient();
    const [failed, ok] = await Promise.allSettled([client.getProfile("missing"), client.getProfile("hikaru")]);
    expect(failed.status).toBe("rejected");
    expect(ok.status).toBe("fulfilled");
  });

  it("maps 404 to not_found", async () => {
    server.use(http.get(`${API}/:user`, () => HttpResponse.json({ code: 0 }, { status: 404 })));
    const error = await expectError(makeClient().getProfile("nobody_here"), "not_found");
    expect(error.status).toBe(404);
    expect(error.userMessage).toContain("No Chess.com player");
  });

  it("maps 410 to gone", async () => {
    server.use(http.get(`${API}/hikaru/games/2020/01`, () => new HttpResponse(null, { status: 410 })));
    await expectError(makeClient().getMonthGames("hikaru", 2020, 1), "gone");
  });

  it("backs off on 429 (2 s, 4 s, 8 s) and then succeeds", async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/hikaru`, () => {
        calls++;
        return calls < 3 ? new HttpResponse(null, { status: 429 }) : HttpResponse.json(profile);
      }),
    );
    const sleep = vi.fn(async () => {});
    await makeClient(sleep).getProfile("hikaru");
    expect(sleep.mock.calls).toEqual([[2000], [4000]]);
  });

  it("gives up with rate_limited after three backoffs", async () => {
    server.use(http.get(`${API}/hikaru`, () => new HttpResponse(null, { status: 429 })));
    const sleep = vi.fn(async () => {});
    await expectError(makeClient(sleep).getProfile("hikaru"), "rate_limited");
    expect(sleep.mock.calls).toEqual([[2000], [4000], [8000]]);
  });

  it("maps network failure to offline", async () => {
    server.use(http.get(`${API}/hikaru`, () => HttpResponse.error()));
    await expectError(makeClient().getProfile("hikaru"), "offline");
  });

  it("maps other HTTP errors to http", async () => {
    server.use(http.get(`${API}/hikaru`, () => new HttpResponse(null, { status: 503 })));
    const error = await expectError(makeClient().getProfile("hikaru"), "http");
    expect(error.status).toBe(503);
  });

  it("rejects bodies that are not JSON or have the wrong shape", async () => {
    server.use(http.get(`${API}/hikaru`, () => new HttpResponse("<html>", { headers: { "Content-Type": "text/html" } })));
    await expectError(makeClient().getProfile("hikaru"), "invalid_response");
    server.use(http.get(`${API}/hikaru/games/archives`, () => HttpResponse.json({ archives: "nope" })));
    await expectError(makeClient().getArchives("hikaru"), "invalid_response");
  });
});
