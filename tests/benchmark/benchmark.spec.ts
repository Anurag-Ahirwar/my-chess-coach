// Phase 2 benchmark (docs/BENCHMARKS.md). Writes raw results to docs/benchmarks/<date>-browser.json.
// Every run uses a fresh browser context, so no stored analysis is reused between runs.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "pgn", "chesscom");
const pgn = (file: string) => readFileSync(join(FIXTURES, file), "utf8");

interface RunResult {
  label: string;
  game: string;
  preset: string;
  engines: number;
  cpuThrottle: number;
  positions: number;
  analysedByEngine: number;
  wallMs: number;
  perPositionMs: number[];
  nodes: number[];
  depths: number[];
  longTasksMs: number[];
  memory?: { baselineMB: number; peakMB: number; perEngineMB: number; method: string };
}

const results: { machine: Record<string, unknown>; engineLoad?: unknown; runs: RunResult[]; indexedDb?: unknown } = {
  machine: {},
  runs: [],
};

/** Total private memory of Chromium renderer processes (dedicated workers run inside the renderer). */
async function rendererMemoryMB(browser: Browser): Promise<number | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as { processInfo: { type: string; id: number }[] };
    await cdp.detach();
    const ids = processInfo.filter((p) => p.type === "renderer").map((p) => p.id);
    if (ids.length === 0) return undefined;
    const out = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${ids.join(",")} | Measure-Object PrivateMemorySize64 -Sum).Sum`], {
      encoding: "utf8",
    });
    return Number(out.trim()) / 2 ** 20;
  } catch {
    return undefined;
  }
}

async function openGame(context: BrowserContext, file: string, pgnText: string): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: number[]; __recording: boolean };
    w.__longTasks = [];
    w.__recording = false;
    new PerformanceObserver((list) => {
      if (w.__recording) for (const entry of list.getEntries()) w.__longTasks.push(Math.round(entry.duration));
    }).observe({ type: "longtask" });
  });
  await page.goto("/");
  await page.getByLabel("PGN text (one or more games)").fill(pgnText);
  await page.getByRole("button", { name: "Load PGN" }).click();
  await page.waitForURL(/\/review\//);
  void file;
  return page;
}

async function analyse(
  browser: Browser,
  opts: { label: string; file: string; pgnText?: string; preset: "Quick" | "Standard" | "Deep"; engines: number; cpuThrottle?: number; sampleMemory?: boolean },
): Promise<RunResult> {
  const context = await browser.newContext();
  const page = await openGame(context, opts.file, opts.pgnText ?? pgn(opts.file));
  const panel = page.getByRole("region", { name: "Engine analysis (debug view)" });
  await panel.getByLabel("Preset").selectOption({ label: opts.preset });
  await panel.getByLabel("Engines").selectOption(String(opts.engines));
  if (opts.cpuThrottle && opts.cpuThrottle > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: opts.cpuThrottle });
  }
  const baseline = opts.sampleMemory ? await rendererMemoryMB(browser) : undefined;
  await page.evaluate(() => {
    (window as unknown as { __recording: boolean }).__recording = true;
  });
  const started = Date.now();
  await panel.getByRole("button", { name: "Analyse game" }).click();

  let peak = baseline ?? 0;
  const status = page.getByTestId("analysis-status");
  for (;;) {
    const text = await status.textContent();
    if (text === "Completed" || text === "Failed" || text === "Finished with failed positions") break;
    if (opts.sampleMemory) peak = Math.max(peak, (await rendererMemoryMB(browser)) ?? 0);
    await page.waitForTimeout(500);
  }
  const wallMs = Date.now() - started;
  const longTasksMs = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);

  // Read the stored raw analysis straight from IndexedDB.
  const stored = await page.evaluate(
    () =>
      new Promise<{ positions: ({ status: string; timeMs?: number; lines: { nodes: number; depth: number }[] } | null)[] }[]>((resolve, reject) => {
        const open = indexedDB.open("chess-coach");
        open.onerror = () => reject(new Error("open failed"));
        open.onsuccess = () => {
          const request = open.result.transaction("rawAnalyses").objectStore("rawAnalyses").getAll();
          request.onsuccess = () => resolve(request.result as never);
          request.onerror = () => reject(new Error("read failed"));
        };
      }),
  );
  const positions = stored[0]!.positions;
  const done = positions.filter((p) => p?.status === "done");
  const result: RunResult = {
    label: opts.label,
    game: opts.file,
    preset: opts.preset,
    engines: opts.engines,
    cpuThrottle: opts.cpuThrottle ?? 1,
    positions: positions.length,
    analysedByEngine: done.length,
    wallMs,
    perPositionMs: done.map((p) => p!.timeMs!),
    nodes: done.map((p) => p!.lines[0]!.nodes),
    depths: done.map((p) => p!.lines[0]!.depth),
    longTasksMs,
    ...(opts.sampleMemory && baseline !== undefined
      ? {
          memory: {
            baselineMB: round(baseline),
            peakMB: round(peak),
            perEngineMB: round((peak - baseline) / opts.engines),
            method: "Sum of Chromium renderer processes' private bytes (CDP SystemInfo.getProcessInfo + Get-Process), peak during the run minus before Start, divided by engine count. Approximate: includes the app's own allocations during the run.",
          },
        }
      : {}),
  };
  if (opts.label === "standard-1-engine") results.indexedDb = await indexedDbTimings(page);
  await context.close();
  results.runs.push(result);
  console.log(`${opts.label}: ${result.analysedByEngine} positions in ${(wallMs / 1000).toFixed(1)} s, long tasks: [${longTasksMs.join(", ")}]`);
  return result;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Times reading and writing the stored analysis record with the raw IndexedDB API. */
async function indexedDbTimings(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("chess-coach");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error("open"));
    });
    const store = (mode: IDBTransactionMode) => db.transaction("rawAnalyses", mode).objectStore("rawAnalyses");
    const promisify = <T,>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error("request"));
      });
    const [record] = (await promisify(store("readonly").getAll())) as { id: string }[];
    const sizeBytes = JSON.stringify(record).length;
    const reads: number[] = [];
    const writes: number[] = [];
    for (let i = 0; i < 20; i++) {
      let t = performance.now();
      await promisify(store("readonly").get(record!.id));
      reads.push(performance.now() - t);
      t = performance.now();
      await promisify(store("readwrite").put({ ...record, id: `${record!.id}|bench` }));
      writes.push(performance.now() - t);
    }
    await promisify(store("readwrite").delete(`${record!.id}|bench`));
    db.close();
    return { sizeBytes, readsMs: reads, writesMs: writes };
  });
}

test("Phase 2 benchmark", async ({ browser }) => {
  results.machine = {
    cpu: os.cpus()[0]?.model,
    logicalCores: os.cpus().length,
    ramGB: round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()}`,
    browser: `Chromium ${browser.version()} (Playwright headless)`,
    node: process.version,
    date: new Date().toISOString(),
  };

  // 1. Engine load: new Worker → uciok → readyok, cold (fresh context) then warm.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/");
    const loads: { uciokMs: number; readyokMs: number }[] = [];
    for (let i = 0; i < 6; i++) {
      loads.push(
        await page.evaluate(
          () =>
            new Promise<{ uciokMs: number; readyokMs: number }>((resolve) => {
              const t0 = performance.now();
              let uciok = 0;
              const worker = new Worker("/engine/stockfish-19-lite-single.js");
              worker.onmessage = (event: MessageEvent<unknown>) => {
                if (event.data === "uciok") {
                  uciok = performance.now() - t0;
                  worker.postMessage("isready");
                } else if (event.data === "readyok") {
                  worker.terminate();
                  resolve({ uciokMs: Math.round(uciok), readyokMs: Math.round(performance.now() - t0) });
                }
              };
              worker.postMessage("uci");
            }),
        ),
      );
    }
    results.engineLoad = { cold: loads[0], warm: loads.slice(1) };
    await context.close();
  }

  // 2. Per-position cost with one engine (no contention), by preset.
  await analyse(browser, { label: "quick-1-engine", file: "02-blitz.pgn", preset: "Quick", engines: 1, sampleMemory: true });
  await analyse(browser, { label: "quick-1-engine-amateur", file: "21-daily.pgn", preset: "Quick", engines: 1 });
  await analyse(browser, { label: "standard-1-engine", file: "02-blitz.pgn", preset: "Standard", engines: 1 });
  await analyse(browser, { label: "deep-1-engine", file: "23-daily.pgn", preset: "Deep", engines: 1 });

  // 3. Whole-game wall time by pool size (same game, Quick), plus Standard with the default pool.
  for (const engines of [2, 3, 4]) {
    await analyse(browser, { label: `quick-${engines}-engines`, file: "02-blitz.pgn", preset: "Quick", engines, sampleMemory: engines === 4 });
  }
  await analyse(browser, { label: "standard-4-engines", file: "02-blitz.pgn", preset: "Standard", engines: 4 });

  // 4. Simulated weaker hardware: 4x CPU throttling of the page (CDP).
  await analyse(browser, { label: "quick-1-engine-cpu4x", file: "07-bullet.pgn", preset: "Quick", engines: 1, cpuThrottle: 4 });
  await analyse(browser, { label: "quick-1-engine-cpu1x", file: "07-bullet.pgn", preset: "Quick", engines: 1 });

  const dir = join(import.meta.dirname, "..", "..", "docs", "benchmarks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}-browser.json`), `${JSON.stringify(results, null, 2)}\n`);
});
