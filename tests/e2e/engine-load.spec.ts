import { expect, test } from "@playwright/test";

/**
 * The engine files are served by the app and run as a Worker under the page's policy:
 * the production CSP by default, or the dev server with E2E_TARGET=dev.
 * (The app's EngineWorker/EnginePool are exercised against the real engine in @engine tests;
 * the debug view in Stage 4 drives them in the browser.)
 */
test("serves the engine files with the right types and licence", async ({ request }) => {
  const wasm = await request.get("/engine/stockfish-19-lite-single.wasm");
  expect(wasm.status()).toBe(200);
  expect(wasm.headers()["content-type"]).toBe("application/wasm");
  expect((await wasm.body()).byteLength).toBe(1_845_971);

  const js = await request.get("/engine/stockfish-19-lite-single.js");
  expect(js.status()).toBe(200);
  expect(js.headers()["content-type"]).toMatch(/^text\/javascript/);

  const licence = await request.get("/engine/Copying.txt");
  expect(licence.status()).toBe(200);
  expect(await licence.text()).toContain("GNU GENERAL PUBLIC LICENSE");
});

test("loads Stockfish in a Worker, searches to a node budget and stops on request", async ({ page }) => {
  const policyViolations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) policyViolations.push(message.text());
  });
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const worker = new Worker("/engine/stockfish-19-lite-single.js");
    const lines: string[] = [];
    const waiters: { pattern: RegExp; resolve: (line: string) => void }[] = [];
    let workerError: string | null = null;
    worker.onerror = (event) => {
      workerError = event.message || "worker error";
    };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      lines.push(event.data);
      const index = waiters.findIndex((w) => w.pattern.test(event.data as string));
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(event.data);
    };
    const until = (pattern: RegExp, ms = 15_000) =>
      Promise.race([
        new Promise<string>((resolve) => waiters.push({ pattern, resolve })),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`timeout waiting for ${pattern}`)), ms)),
      ]);
    const send = (command: string) => worker.postMessage(command);

    send("uci");
    await until(/^uciok$/);
    send("setoption name UCI_ShowWDL value true");
    send("isready");
    await until(/^readyok$/);

    send("ucinewgame");
    send("isready");
    await until(/^readyok$/);
    send("position startpos moves e2e4 e7e5");
    send("go nodes 150000 depth 18");
    const bestmove = await until(/^bestmove /);
    const lastInfo = lines.filter((l) => l.startsWith("info depth") && !/bound/.test(l)).at(-1) ?? "";

    send("ucinewgame");
    send("isready");
    await until(/^readyok$/);
    send("position startpos");
    send("go infinite");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stopSent = performance.now();
    send("stop");
    await until(/^bestmove /, 3000);
    const stopLatencyMs = performance.now() - stopSent;
    worker.terminate();
    return { idName: lines.find((l) => l.startsWith("id name")), bestmove, lastInfo, stopLatencyMs, workerError };
  });

  expect(result.workerError).toBeNull();
  expect(result.idName).toBe("id name Stockfish 19 Lite WASM");
  expect(result.bestmove).toMatch(/^bestmove [a-h][1-8][a-h][1-8]/);
  const nodes = Number(/ nodes (\d+)/.exec(result.lastInfo)?.[1]);
  expect(nodes).toBeLessThanOrEqual(150_000 + 2048);
  expect(result.stopLatencyMs).toBeLessThan(2000);
  expect(policyViolations).toEqual([]);
});
