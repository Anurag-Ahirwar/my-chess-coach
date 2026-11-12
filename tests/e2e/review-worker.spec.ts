import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { fixtureText, pastePgn } from "./helpers";

/**
 * Phase 3 Stage 2, Milestone 2: the review Worker in a real browser. A saved Standard analysis of
 * the longest regression game (207 plies, recorded with the real engine) is put into IndexedDB, so
 * the review is derived without running the engine. Checks: derived once in the Worker, then served
 * from the cache; no main-thread task over 50 ms while it happens (Chromium: Long Tasks API).
 * Timings are attached to the test result (report only).
 */

const RAW = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "review", "raw", "14-blitz.standard.json"), "utf8")) as { id: string };

const panel = (page: Page) => page.getByRole("region", { name: "Analysis", exact: true });
const reviewStatus = (page: Page) => page.getByTestId("review-status");

async function saveAnalysis(page: Page, raw: unknown) {
  await page.evaluate(async (record) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("chess-coach");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(String(request.error)));
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("rawAnalyses", "readwrite");
      tx.objectStore("rawAnalyses").put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(String(tx.error)));
    });
    db.close();
  }, raw);
}

async function timings(page: Page) {
  const status = reviewStatus(page);
  return {
    source: await status.getAttribute("data-source"),
    totalMs: Number(await status.getAttribute("data-total-ms")),
    deriveMs: Number((await status.getAttribute("data-derive-ms")) || Number.NaN),
    indexMs: Number((await status.getAttribute("data-index-ms")) || Number.NaN),
    roundTripMs: Number((await status.getAttribute("data-round-trip-ms")) || Number.NaN),
  };
}

test.beforeEach(async ({ page }) => {
  // review-status is in the debug view.
  await page.addInitScript(() => localStorage.setItem("chess-coach.debug", "1"));
});

test("a saved analysis is reviewed in the Worker, then from the cache, without main-thread long tasks", { tag: "@perf" }, async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[]; __recording: boolean };
    w.__longTasks = [];
    w.__recording = false;
    try {
      new PerformanceObserver((list) => {
        if (!w.__recording) return;
        for (const entry of list.getEntries()) w.__longTasks.push(Math.round(entry.duration));
      }).observe({ type: "longtask", buffered: false });
    } catch {
      // Firefox: no Long Tasks API.
    }
  });
  await pastePgn(page, fixtureText("pgn", "chesscom", "14-blitz.pgn"));
  await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();
  await panel(page).getByLabel("Preset").selectOption({ label: "Quick" });
  await expect(reviewStatus(page)).toHaveAttribute("data-status", "idle");
  await saveAnalysis(page, RAW);

  const record = (on: boolean) => page.evaluate((value) => ((window as unknown as { __recording: boolean }).__recording = value), on);

  // 1. First view of the saved Standard analysis: derived in the Worker (cold: Worker start, index load).
  await record(true);
  await panel(page).getByLabel("Preset").selectOption({ label: "Standard" });
  await expect(reviewStatus(page)).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
  await expect(reviewStatus(page)).toHaveAttribute("data-source", "derived");
  await expect(reviewStatus(page)).toHaveAttribute("data-complete", "true");
  await expect(reviewStatus(page)).toContainText("207 of 207 moves labelled");
  const cold = await timings(page);

  // 2. Same analysis again: served from the IndexedDB cache, no derivation.
  await panel(page).getByLabel("Preset").selectOption({ label: "Quick" });
  await expect(reviewStatus(page)).toHaveAttribute("data-status", "idle");
  await panel(page).getByLabel("Preset").selectOption({ label: "Standard" });
  await expect(reviewStatus(page)).toHaveAttribute("data-source", "cache");
  await expect(reviewStatus(page)).toHaveAttribute("data-status", "ready");
  const cached = await timings(page);

  // 3. Navigating the 207 plies quickly while the review is shown.
  await page.getByRole("heading", { level: 1 }).click();
  for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowRight");
  // 4. 40 clicks across the evaluation graph (the full review UI re-renders each time).
  const graph = page.getByTestId("eval-graph");
  const box = (await graph.boundingBox())!;
  for (let i = 0; i < 40; i++) await graph.click({ position: { x: ((i * 37) % 40) * (box.width / 40) + 2, y: box.height / 2 } });
  await expect(graph).toHaveAttribute("aria-valuenow", /\d+/);
  await record(false);

  test.info().annotations.push({ type: "timing", description: JSON.stringify({ browserName, cold, cached }) });
  console.log(`[review-worker] ${browserName} cold ${JSON.stringify(cold)} cached ${JSON.stringify(cached)}`);

  if (browserName === "chromium") {
    const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
    expect(longTasks, `long tasks (ms): ${longTasks.join(", ")}`).toEqual([]);
    // Positive control: a deliberate 120 ms task is seen.
    await record(true);
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
    await expect.poll(() => page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks.length)).toBeGreaterThan(0);
  }
});

test("the review survives a reload and is read from the cache", async ({ page }) => {
  test.setTimeout(120_000);
  await pastePgn(page, fixtureText("pgn", "chesscom", "14-blitz.pgn"));
  await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();
  await saveAnalysis(page, RAW);
  await page.reload();
  await expect(reviewStatus(page)).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
  await expect(reviewStatus(page)).toHaveAttribute("data-source", "derived");
  await page.reload();
  await expect(reviewStatus(page)).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
  await expect(reviewStatus(page)).toHaveAttribute("data-source", "cache");
  const reloaded = await timings(page);
  test.info().annotations.push({ type: "timing", description: JSON.stringify({ reloadFromCache: reloaded }) });
  console.log(`[review-worker] reload from cache ${JSON.stringify(reloaded)}`);
});
