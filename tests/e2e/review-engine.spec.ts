import { expect, test, type Page } from "@playwright/test";
import { fixtureJson, fixtureText, pastePgn, seedAnalysis, storeContents } from "./helpers";

/**
 * Phase 3 Stage 2, Milestone 4: the review with the real engine, end to end (Quick preset).
 * The debug view is on only to read where a review came from (`review-status`).
 */
const SCHOLARS_MATE = '[Event "Scholar"]\n[White "A"]\n[Black "B"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';

const card = (page: Page) => page.getByRole("region", { name: "Analysis", exact: true });
const status = (page: Page) => page.getByTestId("analysis-status");
const summary = (page: Page) => page.getByTestId("game-summary");
const source = (page: Page) => page.getByTestId("review-status");
const doneCount = async (page: Page) => Number(/(\d+) \//.exec((await page.getByTestId("analysis-progress").textContent()) ?? "")?.[1] ?? Number.NaN);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("chess-coach.debug", "1"));
});

async function start(page: Page, pgn: string, engines: "1" | "auto" = "auto") {
  await pastePgn(page, pgn);
  await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();
  await card(page).getByLabel("Preset").selectOption({ label: "Quick" });
  await card(page).getByLabel("Engines").selectOption(engines);
  await card(page).getByRole("button", { name: "Analyse game" }).click();
}

test("a game is analysed and reviewed end to end; a reload reuses the cached review with no engine work", async ({ page }) => {
  test.setTimeout(120_000);
  const engineRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/engine/")) engineRequests.push(r.url());
  });
  await start(page, SCHOLARS_MATE);
  await expect(status(page)).toHaveText("Completed", { timeout: 60_000 });
  await expect(summary(page)).toHaveAttribute("data-final", "true", { timeout: 30_000 });
  // Every move is labelled (nothing failed), and the graph covers positions 0..7.
  const chips = page.getByRole("navigation", { name: "Moves" }).locator("[data-label]");
  await expect(chips).toHaveCount(7);
  await expect(page.getByTestId("eval-graph")).toHaveAttribute("aria-valuemax", "7");
  // The final position is checkmate: the bar shows the result, White wins.
  await page.getByRole("button", { name: "White: Qxf7#", exact: true }).click();
  await expect(page.getByTestId("eval-bar")).toHaveAttribute("data-score", "1–0");
  const accuracy = await page.getByTestId("accuracy-white").innerText();
  const reviews = await storeContents(page, "reviews");
  const raws = await storeContents(page, "rawAnalyses");

  expect(engineRequests.length, "positive control: analysing does request the engine").toBeGreaterThan(0);
  engineRequests.length = 0;
  await page.reload();
  await expect(source(page)).toHaveAttribute("data-source", "cache", { timeout: 30_000 });
  await expect(summary(page)).toHaveAttribute("data-final", "true");
  expect(await page.getByTestId("accuracy-white").innerText()).toBe(accuracy);
  expect(engineRequests).toEqual([]);
  expect(await storeContents(page, "reviews")).toBe(reviews);
  expect(await storeContents(page, "rawAnalyses")).toBe(raws);
});

test("a stopped analysis gives a partial review that is not cached; resuming completes and caches it", async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, fixtureText("pgn", "chesscom", "20-daily.pgn"), "1");
  await expect.poll(() => doneCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  await card(page).getByRole("button", { name: "Stop" }).click();
  await expect(status(page)).toHaveText("Stopped");
  await expect(summary(page)).toHaveAttribute("data-final", "false", { timeout: 30_000 });
  await expect(summary(page)).toContainText("Analysis in progress");
  await expect(page.getByTestId("accuracy-white")).toHaveCount(0);
  await expect(page.getByTestId("label-counts")).toHaveCount(0);
  expect(JSON.parse(await storeContents(page, "reviews"))).toEqual([]);

  await card(page).getByLabel("Engines").selectOption("auto");
  await card(page).getByRole("button", { name: "Resume analysis" }).click();
  await expect(status(page)).toHaveText("Completed", { timeout: 120_000 });
  await expect(summary(page)).toHaveAttribute("data-final", "true", { timeout: 30_000 });
  await expect(page.getByTestId("accuracy-white")).toBeVisible();
  await expect.poll(async () => (JSON.parse(await storeContents(page, "reviews")) as unknown[]).length).toBe(1);
});

test("a reload during a running analysis keeps the finished positions and their partial review (F3)", async ({ page }) => {
  test.setTimeout(180_000);
  await start(page, fixtureText("pgn", "chesscom", "20-daily.pgn"), "1");
  await expect.poll(() => doneCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  await expect(status(page)).toHaveText("Running");
  await page.reload(); // not stopped first
  await expect(status(page)).toHaveText("Saved");
  const kept = await doneCount(page);
  expect(kept).toBeGreaterThan(0);
  await expect(summary(page)).toHaveAttribute("data-final", "false", { timeout: 30_000 });
  await expect(summary(page)).toContainText(`${kept} of `);
  expect(JSON.parse(await storeContents(page, "reviews"))).toEqual([]);
  await card(page).getByLabel("Engines").selectOption("auto");
  await card(page).getByRole("button", { name: "Resume analysis" }).click();
  await expect(status(page)).toHaveText("Completed", { timeout: 120_000 });
  await expect(summary(page)).toHaveAttribute("data-final", "true", { timeout: 30_000 });
});

test("every review control can be reached with the Tab key when a review is shown", async ({ page }) => {
  test.setTimeout(90_000);
  await pastePgn(page, fixtureText("pgn", "chesscom", "23-daily.pgn"));
  await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();
  await seedAnalysis(page, fixtureJson("review", "raw", "23-daily.standard.json"));
  await page.reload();
  await expect(summary(page)).toHaveAttribute("data-final", "true", { timeout: 30_000 });
  const reached = new Set<string>();
  for (let i = 0; i < 120; i++) {
    await page.keyboard.press("Tab");
    reached.add(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return "";
        const label = (el as HTMLInputElement).labels?.[0]?.textContent;
        return (el.getAttribute("aria-label") ?? label ?? el.textContent ?? "").trim();
      }),
    );
  }
  const all = [...reached].join("\n");
  for (const control of [
    "Next move",
    "Last position",
    "Flip board",
    "Evaluation graph",
    "Start position",
    "White: ",
    "Copy FEN",
    "Download PGN",
    "Preset",
    "Engines",
    "Analyse game",
    "About this analysis",
    "Show experimental labels",
    "Show Chess.com's reported accuracy",
  ]) {
    expect(all, `Tab should reach "${control}"`).toContain(control);
  }
  expect([...reached], "the About link in the header").toContain("About");
});
