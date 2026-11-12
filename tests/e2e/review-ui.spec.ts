import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixtureJson, fixtureText, pastePgn, seedAnalysis, storeContents } from "./helpers";

/**
 * Phase 3 Stage 2, Milestone 3: the review UI, on recorded Standard analyses put into IndexedDB
 * (no engine time). Game 07 has 38 plies, 3 Great moves (Black) and one Blunder (19.Nh4).
 */

interface Raw {
  id: string;
  positions: (Record<string, unknown> | null)[];
  completedCount: number;
  completedAt?: number;
}
const raw07 = () => fixtureJson<Raw>("review", "raw", "07-bullet.standard.json");

async function openReviewed(page: Page, raw: Raw = raw07()) {
  await pastePgn(page, fixtureText("pgn", "chesscom", "07-bullet.pgn"));
  await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();
  await seedAnalysis(page, raw);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();
}

const summary = (page: Page) => page.getByTestId("game-summary");
const countRow = async (page: Page, label: string) => (await page.getByTestId(`count-${label}`).innerText()).replace(/\s+/g, " ").trim();
const experimental = (page: Page) => page.getByLabel("Show experimental labels (Great, Brilliant)");
const greatsInList = (page: Page) => page.getByRole("navigation", { name: "Moves" }).locator('[data-label="great"]');

test.describe("review UI", () => {
  test("experimental labels: hidden by default, shown on request; accuracy and the cached review never change", async ({ page }) => {
    await openReviewed(page);
    await expect(summary(page)).toHaveAttribute("data-final", "true", { timeout: 30_000 });
    const accuracy = [await page.getByTestId("accuracy-white").innerText(), await page.getByTestId("accuracy-black").innerText()];
    expect(accuracy).toEqual(["70.7", "94.1"]);

    // Off (default): Great is shown as Best and counted as Best.
    await expect(experimental(page)).not.toBeChecked();
    await expect(greatsInList(page)).toHaveCount(0);
    await expect(page.getByTestId("count-great")).toHaveCount(0);
    expect(await countRow(page, "best")).toBe("★ Best 9 12");
    const cachedBefore = await storeContents(page, "reviews");
    const rawBefore = await storeContents(page, "rawAnalyses");
    expect(JSON.parse(cachedBefore)).toHaveLength(1);

    // On: Great shown, marked experimental, counted separately; totals and accuracy unchanged.
    await experimental(page).check();
    await expect(greatsInList(page)).toHaveCount(3);
    await expect(greatsInList(page).first()).toContainText("(experimental)");
    expect(await countRow(page, "great")).toBe("! Great (experimental) 0 3");
    expect(await countRow(page, "best")).toBe("★ Best 9 9");
    expect([await page.getByTestId("accuracy-white").innerText(), await page.getByTestId("accuracy-black").innerText()]).toEqual(accuracy);
    expect(await storeContents(page, "reviews")).toBe(cachedBefore);
    expect(await storeContents(page, "rawAnalyses")).toBe(rawBefore);

    // The preference survives a reload.
    await page.reload();
    await expect(summary(page)).toHaveAttribute("data-final", "true", { timeout: 30_000 });
    await expect(experimental(page)).toBeChecked();
    await expect(greatsInList(page)).toHaveCount(3);
    await experimental(page).uncheck();
    await expect(greatsInList(page)).toHaveCount(0);
    expect(await countRow(page, "best")).toBe("★ Best 9 12");
    expect(await storeContents(page, "reviews")).toBe(cachedBefore);
  });

  test("the bar, graph, badge, arrows and move panel follow navigation by graph click and keyboard", async ({ page }) => {
    await openReviewed(page);
    const graph = page.getByTestId("eval-graph");
    await expect(graph).toBeVisible({ timeout: 30_000 });
    const bar = page.getByTestId("eval-bar");

    // A position good for White (after 5.e5: +1.11): the bar is mostly White.
    await page.getByRole("button", { name: "White: e5", exact: true }).click();
    await expect(bar).toHaveAttribute("data-score", "+1.06");
    expect(Number(await bar.getAttribute("data-white-percent"))).toBeGreaterThan(50);
    await expect(graph).toHaveAttribute("aria-valuenow", "9");
    await expect(page.getByTestId("board-badge")).toHaveAttribute("data-square", "e5");

    // A position good for Black (after 19.Nh4, a Blunder): the bar is mostly Black.
    await page.getByRole("button", { name: "White: Nh4", exact: true }).click();
    await expect(bar).toHaveAttribute("data-score", "−5.64");
    expect(Number(await bar.getAttribute("data-white-percent"))).toBeLessThan(50);
    await expect(page.getByTestId("board-badge")).toHaveAttribute("data-label", "blunder");
    await expect(page.getByTestId("board-arrows")).toHaveText("played f3-h4, best c3-e2");
    await expect(page.getByTestId("move-panel")).toContainText("Blunder");
    await expect(page.getByTestId("move-panel")).toContainText("Best moveNe2");
    await expect(page.getByTestId("best-line")).toContainText("19. Ne2");
    await expect(page.getByTestId("refutation-line")).toContainText("19... Qxh4+");
    await expect(page.getByTestId("graph-marker-37")).toBeVisible();

    // Clicking the graph jumps there; the keyboard moves through it.
    const box = (await graph.boundingBox())!;
    await graph.click({ position: { x: 2, y: box.height / 2 } });
    await expect(graph).toHaveAttribute("aria-valuenow", "0");
    await expect(page.getByRole("button", { name: "Start position" })).toHaveAttribute("aria-current", "true");
    await graph.focus();
    await page.keyboard.press("ArrowRight");
    await expect(graph).toHaveAttribute("aria-valuenow", "1");
    await page.keyboard.press("PageDown");
    await expect(graph).toHaveAttribute("aria-valuenow", "11");
    await page.keyboard.press("End");
    await expect(graph).toHaveAttribute("aria-valuenow", "38");
    await expect(page.getByRole("button", { name: "Black: Qxh4+", exact: true })).toHaveAttribute("aria-current", "true");
  });

  test("a partial analysis shows what is known and no final numbers, and is not cached", async ({ page }) => {
    const raw = raw07();
    raw.positions = raw.positions.map((p, k) => (k >= 20 ? null : p));
    raw.completedCount = 20;
    delete raw.completedAt;
    await openReviewed(page, raw);
    await expect(summary(page)).toHaveAttribute("data-final", "false", { timeout: 30_000 });
    await expect(summary(page)).toContainText("Analysis in progress: 20 of 39 positions");
    await expect(page.getByTestId("accuracy-white")).toHaveCount(0);
    await page.getByRole("button", { name: "White: Nh4", exact: true }).click();
    await expect(page.getByTestId("move-panel")).toContainText("Not graded");
    await expect(page.getByTestId("move-panel")).toContainText("Waiting for the engine");
    await page.getByRole("button", { name: "White: e5", exact: true }).click();
    await expect(page.getByTestId("move-panel")).toContainText("Best");
    expect(JSON.parse(await storeContents(page, "reviews"))).toHaveLength(0);
  });

  test("a failed position leaves its moves ungraded and says how many moves are not included", async ({ page }) => {
    const raw = raw07();
    raw.positions[10] = { positionIndex: 10, status: "failed", error: "test failure", lines: [] };
    raw.completedCount = 38;
    delete raw.completedAt;
    await openReviewed(page, raw);
    await expect(summary(page)).toHaveAttribute("data-final", "true", { timeout: 30_000 });
    await expect(page.getByTestId("not-included")).toContainText("not included in accuracy (analysis unavailable)");
    await page.getByRole("button", { name: "Black: f6", exact: true }).click();
    await expect(page.getByTestId("move-panel")).toContainText("the analysis failed there");
  });

  test("the review page with a review has no serious accessibility violations (light and dark) and fits 375 px", async ({ page }) => {
    await openReviewed(page);
    await expect(summary(page)).toHaveAttribute("data-final", "true", { timeout: 30_000 });
    await page.getByRole("button", { name: "White: Nh4", exact: true }).click();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => `${v.id}: ${v.help}`);
      expect(serious, scheme).toEqual([]);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
    await expect(page.getByTestId("eval-graph")).toBeVisible();
    await expect(page.getByTestId("eval-bar")).toBeVisible();
  });

  test("About / Licences lists every library and links the engine licence", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "About" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("About / Licences");
    await expect(page.getByRole("table", { name: "Software libraries and their licences" }).getByRole("row")).toHaveCount(21);
    await expect(page.getByRole("cell", { name: "stockfish", exact: true })).toBeVisible();
    const href = await page.getByRole("link", { name: "The GPL-3.0 licence text shipped with the engine" }).getAttribute("href");
    const response = await page.request.get(href!);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain("GNU GENERAL PUBLIC LICENSE");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)).toEqual([]);
  });
});
