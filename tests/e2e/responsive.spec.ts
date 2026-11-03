import { expect, test, type Page } from "@playwright/test";
import { fixtureText, pastePgn } from "./helpers";

test.use({ viewport: { width: 375, height: 812 } });

async function horizontalOverflow(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

test("home page has no horizontal scroll at 375 px", async ({ page }) => {
  await page.goto("/");
  const { scrollWidth, innerWidth } = await horizontalOverflow(page);
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
});

test("review page has no horizontal scroll and the board fits at 375 px", async ({ page }) => {
  await pastePgn(page, fixtureText("pgn", "chesscom", "20-daily.pgn"));
  await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();
  const { scrollWidth, innerWidth } = await horizontalOverflow(page);
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

  const board = await page.locator("#review-board-square-a8").evaluate((el) => {
    const boardEl = el.closest('[role="img"]')!.getBoundingClientRect();
    return { left: boardEl.left, right: boardEl.right, width: boardEl.width, height: boardEl.height };
  });
  expect(board.left).toBeGreaterThanOrEqual(0);
  expect(board.right).toBeLessThanOrEqual(375);
  expect(board.width).toBeGreaterThan(300);
  expect(Math.abs(board.width - board.height)).toBeLessThan(2);

  await page.getByRole("button", { name: "Next move" }).click();
  await expect(page.getByTestId("current-fen")).not.toHaveValue(/^rnbqkbnr\/pppppppp\/8\/8\/8\/8\//);
});
