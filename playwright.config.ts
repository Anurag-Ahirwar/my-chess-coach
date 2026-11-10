import { defineConfig, devices } from "@playwright/test";

// E2E normally runs against the production build, with its Content-Security-Policy.
// E2E_TARGET=dev runs the same tests against the Vite dev server (used to check the engine loads in dev).
const DEV = process.env["E2E_TARGET"] === "dev";
const PORT = DEV ? 5174 : 4173;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    command: DEV
      ? `npx vite --port ${PORT} --strictPort`
      : `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 180_000,
  },
});
