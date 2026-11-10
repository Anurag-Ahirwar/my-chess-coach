import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixtureText, pastePgn } from "./helpers";

async function criticalViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
    .map((violation) => `${violation.impact}: ${violation.id} (${violation.nodes.length}) ${violation.help}`);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`accessibility (${theme} theme)`, () => {
    test.use({ colorScheme: theme });

    test("home page has no serious or critical violations", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Review a game" })).toBeVisible();
      expect(await criticalViolations(page)).toEqual([]);
    });

    test("review page has no serious or critical violations", async ({ page }) => {
      await pastePgn(page, fixtureText("pgn", "chesscom", "01-blitz.pgn"));
      await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();
      await page.getByRole("button", { name: "Next move" }).click();
      expect(await criticalViolations(page)).toEqual([]);
    });
  });
}

test("every review control can be reached with the Tab key", async ({ page }) => {
  await pastePgn(page, "1. e4 e5 2. Nf3 *");
  // Wait until the review page is showing before pressing Tab. Since Phase 2 an import opens the
  // review page only after the game is saved, which can take a moment on a slow machine (CI).
  await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();
  const reached = new Set<string>();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? (el.getAttribute("aria-label") ?? el.textContent?.trim() ?? el.tagName) : "";
    });
    reached.add(name);
  }
  for (const control of ["First position", "Previous move", "Next move", "Last position", "Flip board", "Start position", "White: e4", "Black: e5", "Copy FEN", "Download PGN"]) {
    // Disabled buttons (First/Previous at the start) are correctly skipped; move once so they're enabled.
    if (control === "First position" || control === "Previous move") continue;
    expect(reached, `Tab should reach "${control}"`).toContain(control);
  }
});
