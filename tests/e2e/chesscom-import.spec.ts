import { expect, test, type Page } from "@playwright/test";
import { archiveUrl, fixtureJson, mockChessCom } from "./helpers";

type Game = { url: string; uuid?: string; rules: string; end_time?: number; white: { username: string }; black: { username: string } };
const monthGames = fixtureJson<{ games: Game[] }>("chesscom", "api", "month-hikaru.json").games;

// Two months for "hikaru": the newer one also contains a Chess960 game.
const variantGame: Game = { ...monthGames[1]!, url: "https://www.chess.com/game/live/960", uuid: "variant-960", rules: "chess960" };
const baseOptions = {
  archives: { hikaru: [archiveUrl("hikaru", 2026, 9), archiveUrl("hikaru", 2026, 10)] },
  months: { "hikaru/2026/09": monthGames.slice(2), "hikaru/2026/10": [...monthGames.slice(0, 2), variantGame] },
};

async function search(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("Chess.com username").fill(username);
  await page.getByRole("button", { name: "Find games" }).click();
}

test.describe("Chess.com import", () => {
  test("lists the newest month, opens a game, and orients the board for the user", async ({ page }) => {
    await mockChessCom(page, baseOptions);
    await search(page, "  Hikaru ");
    await expect(page.getByLabel("Month")).toHaveValue(archiveUrl("hikaru", 2026, 10));
    const list = page.getByRole("list", { name: "Chess.com games" });
    await expect(list.getByRole("listitem")).toHaveCount(3);
    await expect(list.getByText("Not supported (chess960)")).toBeVisible();

    // The list is newest first; the variant game has no Review button.
    const first = monthGames.slice(0, 2).sort((a, b) => (b.end_time ?? 0) - (a.end_time ?? 0))[0]!;
    const hikaruIsBlack = first.black.username.toLowerCase() === "hikaru";
    await list.getByRole("button", { name: /^Review / }).first().click();
    await expect(page).toHaveURL(new RegExp(`/review/cc%3A${first.uuid}`));
    await expect(page.getByRole("link", { name: "View on Chess.com" })).toHaveAttribute("href", first.url);
    // Orientation: the user's colour at the bottom, so the first rendered square is a8 (White) or h1 (Black).
    await expect(page.locator("[data-square]").first()).toHaveAttribute("data-square", hikaruIsBlack ? "h1" : "a8");
  });

  test("remembers the username and offers recent games", async ({ page }) => {
    await mockChessCom(page, baseOptions);
    await search(page, "hikaru");
    await expect(page.getByRole("list", { name: "Chess.com games" })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Show recent games for hikaru" }).click();
    await expect(page.getByRole("list", { name: "Chess.com games" }).getByRole("listitem")).toHaveCount(3);
  });

  test("falls back to the previous month when the newest is empty", async ({ page }) => {
    await mockChessCom(page, { ...baseOptions, months: { ...baseOptions.months, "hikaru/2026/10": [] } });
    await search(page, "hikaru");
    await expect(page.getByLabel("Month")).toHaveValue(archiveUrl("hikaru", 2026, 9));
  });

  test("a past month is fetched once and then served from the cache", async ({ page }) => {
    const requests = await mockChessCom(page, baseOptions);
    await search(page, "hikaru");
    await expect(page.getByRole("list", { name: "Chess.com games" })).toBeVisible();
    const month = page.getByLabel("Month");
    await month.selectOption(archiveUrl("hikaru", 2026, 9));
    await expect(page.getByRole("list", { name: "Chess.com games" }).getByRole("listitem")).toHaveCount(monthGames.length - 2);
    await month.selectOption(archiveUrl("hikaru", 2026, 10));
    await expect(page.getByRole("list", { name: "Chess.com games" }).getByRole("listitem")).toHaveCount(3);
    await month.selectOption(archiveUrl("hikaru", 2026, 9));
    await expect(page.getByRole("list", { name: "Chess.com games" }).getByRole("listitem")).toHaveCount(monthGames.length - 2);
    expect(requests.filter((url) => url.endsWith("/2026/09"))).toHaveLength(1);
  });

  test("rejects an invalid username without calling the API", async ({ page }) => {
    const requests = await mockChessCom(page, baseOptions);
    await search(page, "no spaces allowed");
    await expect(page.getByRole("alert")).toContainText("doesn't look like a Chess.com username");
    expect(requests).toEqual([]);
  });

  test("unknown user (404)", async ({ page }) => {
    await mockChessCom(page, baseOptions);
    await search(page, "nobody_here");
    await expect(page.getByRole("alert")).toContainText("No Chess.com player or archive was found");
  });

  test("archive gone (410)", async ({ page }) => {
    await mockChessCom(page, { ...baseOptions, status: { "hikaru/games/2026/10": 410 } });
    await search(page, "hikaru");
    await expect(page.getByRole("alert")).toContainText("permanently unavailable");
  });

  test("offline", async ({ page }) => {
    await mockChessCom(page, { ...baseOptions, abort: ["hikaru/games/archives"] });
    await search(page, "hikaru");
    await expect(page.getByRole("alert")).toContainText("Couldn't reach Chess.com");
  });

  test("rate limited (429) after backing off 2 + 4 + 8 seconds", async ({ page }) => {
    test.setTimeout(60_000);
    const requests = await mockChessCom(page, { ...baseOptions, status: { "hikaru/games/archives": 429 } });
    await search(page, "hikaru");
    await expect(page.getByRole("alert")).toContainText("limiting requests", { timeout: 25_000 });
    expect(requests).toHaveLength(4);
  });

  test("requests never overlap", async ({ page }) => {
    let inFlight = 0;
    let maxInFlight = 0;
    await page.route("https://api.chess.com/pub/player/**", async (route) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight--;
      const url = route.request().url();
      if (url.endsWith("/archives")) await route.fulfill({ json: { archives: baseOptions.archives.hikaru } });
      else await route.fulfill({ json: { games: [] } });
    });
    await search(page, "hikaru");
    await expect(page.getByText("No games in this month.")).toBeVisible();
    expect(maxInFlight).toBe(1);
  });
});
