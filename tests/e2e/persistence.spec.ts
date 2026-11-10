import { expect, test } from "@playwright/test";
import { archiveUrl, fixtureJson, fixtureText, mockChessCom, pastePgn } from "./helpers";

test.describe("persistence (IndexedDB)", () => {
  test("an imported game survives a reload of the review page and of the home page", async ({ page }) => {
    await pastePgn(page, fixtureText("pgn", "chesscom", "06-blitz.pgn"));
    await expect(page).toHaveURL(/\/review\/pgn%3A/);
    const heading = await page.getByRole("heading", { level: 1 }).textContent();

    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading!);
    await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();

    await page.goto("/");
    const list = page.getByRole("list", { name: "Your games" });
    await expect(list.getByRole("link")).toHaveCount(1);
    await expect(page.getByText("Saved in this browser.")).toBeVisible();
  });

  test("importing the same game again does not create a duplicate", async ({ page }) => {
    const pgn = fixtureText("pgn", "rules", "castling-both-sides.pgn");
    await pastePgn(page, pgn);
    await expect(page).toHaveURL(/\/review\//);
    await pastePgn(page, pgn);
    await expect(page).toHaveURL(/\/review\//);
    await page.goto("/");
    await page.reload();
    await expect(page.getByRole("list", { name: "Your games" }).getByRole("link")).toHaveCount(1);
  });

  test("a past Chess.com month is not fetched again after a reload", async ({ page }) => {
    const games = fixtureJson<{ games: unknown[] }>("chesscom", "api", "month-hikaru.json").games;
    const requests = await mockChessCom(page, {
      archives: { hikaru: [archiveUrl("hikaru", 2026, 9)] },
      months: { "hikaru/2026/09": games },
    });
    const search = async () => {
      await page.getByLabel("Chess.com username").fill("hikaru");
      await page.getByRole("button", { name: "Find games" }).click();
      await expect(page.getByRole("list", { name: "Chess.com games" }).getByRole("listitem")).toHaveCount(games.length);
    };
    await page.goto("/");
    await search();
    await page.reload();
    await search();
    expect(requests.filter((url) => url.endsWith("/2026/09"))).toHaveLength(1);
    expect(requests.filter((url) => url.endsWith("/archives"))).toHaveLength(2); // the archive list is rechecked
  });

  test("when IndexedDB is unavailable, a banner explains it and import and review still work", async ({ page }) => {
    await page.addInitScript(() => {
      // Simulate a browser that blocks IndexedDB (e.g. some private modes).
      Object.defineProperty(window, "indexedDB", { get: () => undefined, configurable: true });
    });
    await pastePgn(page, fixtureText("pgn", "rules", "checkmate-white-wins.pgn"));
    await expect(page).toHaveURL(/\/review\//);
    await expect(page.getByRole("alert").filter({ hasText: "isn't letting the app save data" })).toBeVisible();
    await page.getByRole("button", { name: "Next move" }).click();
    await expect(page.getByTestId("current-fen")).not.toHaveValue(/^rnbqkbnr\/pppppppp\/8\/8\/8\/8\//);

    await page.getByRole("link", { name: "Chess Coach" }).click();
    await expect(page.getByRole("list", { name: "Your games" }).getByRole("link")).toHaveCount(1);
    await expect(page.getByText("kept until you close the tab")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss storage message" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "isn't letting the app save data" })).toHaveCount(0);
  });
});
