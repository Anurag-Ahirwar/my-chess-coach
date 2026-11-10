# Chess Coach

A local-first web app for reviewing your chess games. Import games from Chess.com or paste a PGN, step through them move by move, and analyse them with Stockfish running in your browser. Move labels, accuracy and AI coaching come in later phases.

**Current status:**
- **Phase 1 is conditionally accepted.** Import and move-by-move review.
- **Phase 2 is implemented on branch `phase-2` and awaiting acceptance.** It adds Stockfish 19 (lite) in browser Workers, games and analyses saved in IndexedDB with resume after reload, and a temporary debug view of the raw engine output.

See [docs/DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md) and [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Requirements

- Node.js 24 LTS (enforced; see `.nvmrc`)
- npm 11 (bundled with Node 24)

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies (the `stockfish` package unpacks to about 205 MB; only 1.9 MB is served) |
| `npm run dev` | Start the dev server at http://localhost:5173 |
| `npm run build` | Typecheck and build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run check` | Typecheck, lint, licence check, unit + integration tests with coverage thresholds |
| `npm run test:engine` | Tests against the real Stockfish WASM engine, run in Node |
| `npm run test:e2e` | End-to-end tests against the production build (`npx playwright install chromium firefox` first) |
| `npm run record:engine` | Re-record the golden engine transcripts (`-- --verify` checks they reproduce exactly) |
| `npm run bench` / `npm run bench:builds` | Benchmarks (browser; lite vs full engine build) → `docs/benchmarks/` |
| `LIVE_CHESSCOM_USER=<name> npm run test:live` | Import your 10 most recent Chess.com games through the real API and verify every move |

In PowerShell, set the variable first: `$env:LIVE_CHESSCOM_USER="name"; npm run test:live`.

## Layout

```
src/core/    pure logic: chess rules (chess.js), PGN, game records, engine data model and validation — no React, no I/O
src/infra/   adapters: Chess.com API client, Stockfish workers (UCI parser, worker state machine, pool), IndexedDB (Dexie)
src/app/     state stores, import services, game analysis service and controller, storage service
src/ui/      React components and pages
tests/       unit, integration (MSW), engine (real WASM), e2e (Playwright), benchmark, live; fixtures in tests/fixtures
docs/        specification and benchmark results
```

## Licensing

Personal project, not yet licensed for distribution. The Stockfish engine is GPL-3.0 (its licence is served at `/engine/Copying.txt`); see [docs/PRODUCT_REQUIREMENTS.md §10](docs/PRODUCT_REQUIREMENTS.md#10-licensing-and-legal).
