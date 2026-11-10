import { defineConfig, devices } from "@playwright/test";

/**
 * Benchmarks (docs/BENCHMARKS.md, decision D9): the production build in Chromium, one test at a
 * time so measurements don't compete for the CPU. Run with `npm run bench`.
 */
const PORT = 4175;

export default defineConfig({
  testDir: "tests/benchmark",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60 * 60 * 1000,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, ...devices["Desktop Chrome"] },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
