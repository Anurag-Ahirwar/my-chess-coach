import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fixtureJson, fixtureText, pastePgn, seedAnalysis } from "./helpers";

/**
 * Review-page screenshots for checkpoint reports (not a test of behaviour). Skipped unless
 * SCREENSHOT_DIR is set: SCREENSHOT_DIR=<folder> npx playwright test screenshots --project=chromium
 */
const DIR = process.env["SCREENSHOT_DIR"];
test.skip(!DIR, "Set SCREENSHOT_DIR to take screenshots.");

async function open(page: Page) {
  await pastePgn(page, fixtureText("pgn", "chesscom", "07-bullet.pgn"));
  await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();
  await seedAnalysis(page, fixtureJson("review", "raw", "07-bullet.standard.json"));
  await page.reload();
  await expect(page.getByTestId("game-summary")).toHaveAttribute("data-final", "true", { timeout: 30_000 });
}

test("desktop, light and dark, a Blunder selected", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);
  await page.getByRole("button", { name: "White: Nh4", exact: true }).click();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: join(DIR!, `review-desktop-${scheme}.png`), fullPage: true });
  }
});

test("desktop, experimental labels on, a Great move selected", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);
  await page.getByLabel("Show experimental labels (Great, Brilliant)").check();
  await page.getByRole("button", { name: "Black: Ng3", exact: true }).click();
  await page.screenshot({ path: join(DIR!, "review-desktop-experimental.png"), fullPage: true });
});

test("phone, 375 px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page);
  await page.getByRole("button", { name: "White: Nh4", exact: true }).click();
  await page.screenshot({ path: join(DIR!, "review-375.png"), fullPage: true });
});

test("About / Licences", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/about");
  await page.screenshot({ path: join(DIR!, "about.png"), fullPage: true });
});
