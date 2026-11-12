import { expect, test, type Page } from "@playwright/test";
import { fixtureText, pastePgn } from "./helpers";

// Real Stockfish in browser Workers (production build). Kept short: Quick preset, small games.
const SCHOLARS_MATE = '[Event "Scholar"]\n[White "A"]\n[Black "B"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';

const status = (page: Page) => page.getByTestId("analysis-status");
const progress = (page: Page) => page.getByTestId("analysis-progress");
// Phase 3 (decision Q4): the analysis controls moved to the "Analysis" card, and the raw per-position
// data (eval-N, current-eval, line-N-score) is in the debug view, shown with the debug flag.
const panel = (page: Page) => page.getByRole("region", { name: "Analysis", exact: true });

async function choose(page: Page, preset: "Quick" | "Standard" | "Deep", engines: "1" | "2" | "3" | "4" | "auto" = "auto") {
  await panel(page).getByLabel("Preset").selectOption({ label: preset });
  await panel(page).getByLabel("Engines").selectOption(engines);
}

async function doneCount(page: Page): Promise<number> {
  const text = (await progress(page).textContent()) ?? "";
  return Number(/(\d+) \//.exec(text)?.[1] ?? NaN);
}

test.describe("engine analysis debug view", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("chess-coach.debug", "1"));
  });

  test("analyses a whole game and shows the raw evaluation per position", async ({ page }) => {
    await pastePgn(page, SCHOLARS_MATE);
    await choose(page, "Quick");
    await expect(status(page)).toHaveText("Not analysed");
    await panel(page).getByRole("button", { name: "Analyse game" }).click();
    await expect(status(page)).toHaveText("Completed", { timeout: 60_000 });
    await expect(progress(page)).toContainText("8 / 8 positions");

    // Position 6 (after 3...Nf6): White mates in one.
    await expect(page.getByTestId("eval-6")).toHaveText("M1");
    // The final position was resolved by the rules, not the engine.
    await expect(page.getByTestId("eval-7")).toHaveText("1–0");
    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("End");
    await expect(page.getByTestId("current-eval")).toContainText("Game over by the rules");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("line-1-score")).toHaveText("M1");
    await expect(page.getByTestId("current-eval")).toContainText("Best move Qxf7#");
    // Every other position has a numeric evaluation.
    for (const index of [0, 1, 2, 3, 4, 5]) await expect(page.getByTestId(`eval-${index}`)).toHaveText(/^[+−]?\d+\.\d\d$/);
  });

  test("the board and keyboard keep working while analysis runs", async ({ page }) => {
    await pastePgn(page, fixtureText("pgn", "chesscom", "01-blitz.pgn"));
    await choose(page, "Quick", "1");
    await panel(page).getByRole("button", { name: "Analyse game" }).click();
    await expect(status(page)).toHaveText("Running");
    const fen = page.getByTestId("current-fen");
    const before = await fen.inputValue();
    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(fen).not.toHaveValue(before);
    await expect(status(page)).toHaveText("Running");
    await panel(page).getByRole("button", { name: "Stop" }).click();
    await expect(status(page)).toHaveText("Stopped");
  });

  test("stopping keeps finished positions; after a reload the analysis resumes from there", async ({ page }) => {
    await pastePgn(page, fixtureText("pgn", "chesscom", "01-blitz.pgn"));
    await choose(page, "Quick", "1");
    await panel(page).getByRole("button", { name: "Analyse game" }).click();
    await expect.poll(() => doneCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    await panel(page).getByRole("button", { name: "Stop" }).click();
    await expect(status(page)).toHaveText("Stopped");
    const stoppedAt = await doneCount(page);
    const firstEval = await page.getByTestId("eval-0").textContent();

    await page.reload();
    await expect(status(page)).toHaveText("Saved");
    expect(await doneCount(page)).toBe(stoppedAt);
    await expect(panel(page)).toContainText("resuming analyses only the missing positions");
    await expect(page.getByTestId("eval-0")).toHaveText(firstEval!);

    await panel(page).getByRole("button", { name: "Resume analysis" }).click();
    await expect.poll(() => doneCount(page), { timeout: 30_000 }).toBeGreaterThan(stoppedAt + 1);
    await expect(page.getByTestId("eval-0")).toHaveText(firstEval!); // kept, not recomputed differently
    await panel(page).getByRole("button", { name: "Stop" }).click();
  });

  test("a complete saved analysis is reused without engine work", async ({ page }) => {
    await pastePgn(page, SCHOLARS_MATE);
    await choose(page, "Quick");
    await panel(page).getByRole("button", { name: "Analyse game" }).click();
    await expect(status(page)).toHaveText("Completed", { timeout: 60_000 });
    await page.reload();
    await expect(status(page)).toHaveText("Saved");
    await expect(progress(page)).toContainText("8 / 8");
    await panel(page).getByRole("button", { name: "Analyse game" }).click();
    await expect(status(page)).toHaveText("Completed");
    await expect(panel(page)).toContainText("no engine work was needed");
  });

  test("different presets of one game are kept apart", async ({ page }) => {
    await pastePgn(page, SCHOLARS_MATE);
    await choose(page, "Quick");
    await panel(page).getByRole("button", { name: "Analyse game" }).click();
    await expect(status(page)).toHaveText("Completed", { timeout: 60_000 });
    await choose(page, "Standard");
    await expect(status(page)).toHaveText("Not analysed");
    await choose(page, "Quick");
    await expect(status(page)).toHaveText("Saved");
  });

  test("analysis works in memory when IndexedDB is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", { get: () => undefined, configurable: true });
    });
    await pastePgn(page, SCHOLARS_MATE);
    await choose(page, "Quick");
    await panel(page).getByRole("button", { name: "Analyse game" }).click();
    await expect(status(page)).toHaveText("Completed", { timeout: 60_000 });
    await expect(page.getByRole("alert").filter({ hasText: "isn't letting the app save data" })).toBeVisible();
  });

  test("no main-thread task over 50 ms while a full game is analysed", { tag: "@perf" }, async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "The Long Tasks API is Chromium-only.");
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      const w = window as unknown as { __longTasks: number[]; __recording: boolean };
      w.__longTasks = [];
      w.__recording = false;
      new PerformanceObserver((list) => {
        if (!w.__recording) return;
        for (const entry of list.getEntries()) w.__longTasks.push(Math.round(entry.duration));
      }).observe({ type: "longtask", buffered: false });
    });
    await pastePgn(page, fixtureText("pgn", "chesscom", "06-blitz.pgn"));
    await choose(page, "Quick");
    await page.evaluate(() => {
      (window as unknown as { __recording: boolean }).__recording = true;
    });
    await panel(page).getByRole("button", { name: "Analyse game" }).click();
    await expect(status(page)).toHaveText("Completed", { timeout: 170_000 });
    const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
    expect(longTasks, `long tasks (ms): ${longTasks.join(", ")}`).toEqual([]);

    // Control: prove the observer works by blocking the main thread for 120 ms on purpose, in a
    // normal event-loop task (a busy loop run directly by page.evaluate is not reported as one).
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            const end = performance.now() + 120;
            while (performance.now() < end) {
              // busy wait
            }
            resolve();
          }, 0),
        ),
    );
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks.length))
      .toBeGreaterThan(0);
  });
});
