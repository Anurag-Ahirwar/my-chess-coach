import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Content-Security-Policy for production builds (docs/TECHNICAL_ARCHITECTURE.md §10).
 * Not applied to the dev server, whose hot-reload preamble is an inline script.
 * 'unsafe-inline' styles are needed for the board's inline style attributes.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "connect-src 'self' https://api.chess.com",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY }, injectTo: "head-prepend" },
    ],
  };
}

/**
 * Copies the Stockfish lite single-threaded engine and its licence from the pinned npm
 * package into public/engine/ (docs/TECHNICAL_ARCHITECTURE.md D6, decision A12).
 * The copies are generated and git-ignored; the loader finds its .wasm next to the .js.
 */
const ENGINE_FILES = ["bin/stockfish-19-lite-single.js", "bin/stockfish-19-lite-single.wasm", "Copying.txt"];

function engineFiles(): Plugin {
  return {
    name: "engine-files",
    buildStart() {
      const source = fileURLToPath(new URL("./node_modules/stockfish/", import.meta.url));
      const target = fileURLToPath(new URL("./public/engine/", import.meta.url));
      mkdirSync(target, { recursive: true });
      for (const file of ENGINE_FILES) {
        const from = join(source, file);
        const to = join(target, file.split("/").pop()!);
        if (!existsSync(from)) this.error(`Missing ${from}: run npm install (stockfish 19.0.1 is required).`);
        if (!existsSync(to) || statSync(to).size !== statSync(from).size) copyFileSync(from, to);
      }
    },
  };
}

export default defineConfig({
  plugins: [engineFiles(), react(), tailwindcss(), contentSecurityPolicy()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    target: "es2023",
    sourcemap: true,
  },
  test: {
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "tests/unit/**/*.test.{ts,tsx}",
            "tests/integration/**/*.test.{ts,tsx}",
            // Live tests call the real Chess.com API, so they only run when a username is given.
            ...(process.env["LIVE_CHESSCOM_USER"] ? ["tests/live/**/*.test.ts"] : []),
          ],
        },
      },
      {
        // @engine: the real Stockfish WASM build, run as a Node child process (slower; `npm run test:engine`).
        extends: true,
        test: {
          name: "engine",
          include: ["tests/engine/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/core/**/*.ts", "src/infra/engine/**/*.ts"],
      reporter: ["text-summary", "text", "html"],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
  },
});
