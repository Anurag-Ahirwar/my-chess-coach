# Dependencies

| | |
|---|---|
| Status | Phase 1 |
| Date | 2026-11-03 |
| Check | `npm run licenses` fails if a runtime dependency's licence is not on the allow-list (MIT, ISC, 0BSD, BSD-2/3-Clause, Apache-2.0, CC0-1.0, GPL-3.0). It runs as part of `npm run check`. |

All versions are exact (`save-exact=true` in `.npmrc`) and locked in `package-lock.json`. Upgrades are deliberate, one dependency at a time, with the full test suite run after each.

## Runtime

| Package | Version | Licence | Purpose |
|---|---|---|---|
| react, react-dom | 19.3.1 | MIT | UI |
| react-router | 8.5.1 | MIT | Routes (`/`, `/review/:gameId`) |
| react-chessboard | 5.12.1 | MIT | Board rendering. Brings in `@dnd-kit/*` (MIT). |
| chess.js | 1.4.0 | BSD-2-Clause | All chess rules: legality, SAN/UCI, FEN, terminal states |
| zod | 4.6.7 | MIT | Validating Chess.com API responses |
| zustand | 5.0.16 | MIT | App state (games in this session, preferences) |

Transitive runtime packages (`scheduler`, `csstype`, `tslib`, `cookie-es`, `@remix-run/route-pattern`, `@types/react*`) are all MIT or 0BSD. Run `npm run licenses` for the current list.

The Stockfish engine (`stockfish` 19.0.1, GPL-3.0) is added in Phase 2.

## Development

| Package | Version | Purpose |
|---|---|---|
| typescript | **6.0.3 (pinned)** | Type checking. See below. |
| vite, @vitejs/plugin-react | 8.3.5, 6.2.1 | Dev server and build |
| tailwindcss, @tailwindcss/vite | 4.3.4 | Styling |
| vitest, @vitest/coverage-v8 | 5.1.0 | Unit and integration tests, coverage |
| jsdom, @testing-library/* | 30.1.3, … | DOM test environment (component tests) |
| msw | 3.0.3 | Mocking the Chess.com API in integration tests |
| @playwright/test, @axe-core/playwright | 1.64.1, 4.14.0 | End-to-end and accessibility tests |
| eslint, @eslint/js, typescript-eslint, eslint-plugin-react-hooks, globals | 10.14.0, 10.0.1, 8.72.1, 7.1.1, 17.14.0 | Linting, including the layer-boundary rules |
| @types/node | 24.19.2 | Node 24 types, for tests and scripts only |

## Pins and known issues

- **TypeScript is pinned to 6.0.x.** npm's `latest` is 7.0 (the native compiler), but typescript-eslint 8.72 supports only `typescript >=4.8.4 <6.1.0`. Vite and Vitest strip types without `tsc`, so they're unaffected. Move to TS 7 once typescript-eslint supports it.
- **Node.js 24 LTS** is enforced through `engines` plus `engine-strict=true`. See architecture D0.
- **`npm audit`: 11 moderate findings, all dev-only.** They all come from one advisory in `minimatch` (a denial-of-service via glob patterns), pulled in through ESLint and typescript-eslint. `npm audit --omit=dev` reports **0**. The fix npm suggests would downgrade ESLint to version 4, so it isn't applied. ESLint only runs on our own source files, so there's no untrusted glob input. Re-check on each tooling upgrade.
- **msw 3** renamed `onUnhandledRequest` to `onUnhandledFrame`. Its Node interceptor also drops a request's `cache` mode, so the test that checks `cache: "no-cache"` injects a `fetch` spy instead.
