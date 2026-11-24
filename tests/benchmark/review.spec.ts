// Phase 3 review benchmark in the browser (docs/BENCHMARKS.md §6). Report only, never a gate.
//   npm run bench -- review        → writes docs/benchmarks/<date>-review-browser.json
// Recorded Standard analyses are put into IndexedDB, so no engine runs. A fresh context per run.
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import { seedAnalysis } from "../e2e/helpers";

const ROOT = join(import.meta.dirname, "..", "fixtures");
const GAMES = [
  { name: "23-daily", plies: 20 },
  { name: "02-blitz", plies: 76 },
  { name: "14-blitz", plies: 207 },
];
const RUNS = 10;

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! * 10) / 10;
  return { median: at(0.5), p95: at(0.95), max: at(1), n: sorted.length };
};

async function run(browser: Browser, name: string, throttle: number) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("chess-coach.debug", "1");
    const w = window as unknown as { __shown?: number; __events: number[]; __long: number[] };
    w.__events = [];
    w.__long = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === "keydown") w.__events.push(e.duration);
    }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__long.push(Math.round(e.duration));
    }).observe({ type: "longtask" });
    new MutationObserver(() => {
      if (w.__shown === undefined && document.querySelector('[data-testid="game-summary"][data-final="true"]')) {
        requestAnimationFrame(() => (w.__shown ??= performance.now()));
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto("/");
  await page.getByLabel("PGN text (one or more games)").fill(readFileSync(join(ROOT, "pgn", "chesscom", `${name}.pgn`), "utf8"));
  await page.getByRole("button", { name: "Load PGN" }).click();
  await expect(page.getByRole("navigation", { name: "Moves" })).toBeVisible();
  await seedAnalysis(page, JSON.parse(readFileSync(join(ROOT, "review", "raw", `${name}.standard.json`), "utf8")));
  if (throttle > 1) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: throttle });

  const load = async (source: "derived" | "cache") => {
    await page.reload();
    const status = page.getByTestId("review-status");
    await expect(status).toHaveAttribute("data-source", source, { timeout: 60_000 });
    await page.waitForFunction(() => (window as unknown as { __shown?: number }).__shown !== undefined);
    const ms = async (key: string) => Number((await status.getAttribute(`data-${key}-ms`)) || Number.NaN);
    const shown = await page.evaluate(() => (window as unknown as { __shown: number }).__shown);
    return { total: await ms("total"), derive: await ms("derive"), index: await ms("index"), roundTrip: await ms("round-trip"), shown };
  };
  const cold = await load("derived");
  const warm = await load("cache");
  await page.getByRole("heading", { level: 1 }).click();
  await page.evaluate(() => {
    (window as unknown as { __long: number[] }).__long = [];
  });
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(800);
  const { events, long } = await page.evaluate(() => {
    const w = window as unknown as { __events: number[]; __long: number[] };
    return { events: w.__events, long: w.__long };
  });
  await context.close();
  return { cold, warm, events, long };
}

test("review loading and derivation", async ({ browser }) => {
  test.setTimeout(1_800_000);
  const rows = [];
  for (const game of GAMES) {
    for (const throttle of [1, 4]) {
      const runs: Awaited<ReturnType<typeof run>>[] = [];
      for (let i = 0; i < RUNS; i++) runs.push(await run(browser, game.name, throttle));
      const pick = (f: (r: (typeof runs)[number]) => number) => stats(runs.map(f));
      const events = runs.flatMap((r) => r.events);
      const row = {
        ...game,
        cpuThrottle: throttle,
        derived: {
          totalMs: pick((r) => r.cold.total),
          deriveMs: pick((r) => r.cold.derive),
          indexMs: pick((r) => r.cold.index),
          otherRoundTripMs: pick((r) => r.cold.roundTrip - r.cold.derive - r.cold.index),
          reloadToShownMs: pick((r) => r.cold.shown),
        },
        cached: { totalMs: pick((r) => r.warm.total), reloadToShownMs: pick((r) => r.warm.shown) },
        keydownMs: events.length > 0 ? stats(events) : "no event reached the 16 ms threshold",
        longTasksPerRun: runs.map((r) => r.long.length),
        longestTaskMs: Math.max(0, ...runs.flatMap((r) => r.long)),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  const date = new Date().toLocaleDateString("sv-SE"); // local YYYY-MM-DD
  const out = join(import.meta.dirname, "..", "..", "docs", "benchmarks", `${date}-review-browser.json`);
  const machine = { browser: browser.version(), cpu: os.cpus()[0]?.model, cores: os.cpus().length };
  writeFileSync(out, `${JSON.stringify({ ...machine, runs: RUNS, unit: "ms", rows }, null, 1)}\n`);
});
