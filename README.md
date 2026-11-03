# Chess Coach

A local-first web app for reviewing your chess games. Import games from Chess.com or paste a PGN, step through them move by move, and (in later phases) get Stockfish analysis, move labels, accuracy and AI coaching.

**Current status: Phase 1, conditionally accepted.** Import and move-by-move review work. Two follow-ups are open: Firefox E2E (blocked on this machine; to be run elsewhere) and validation with the owner's own Chess.com account. See [docs/DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md).

## Requirements

- Node.js 24 LTS (enforced; see `.nvmrc`)
- npm 11 (bundled with Node 24)

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Start the dev server at http://localhost:5173 |
| `npm run build` | Typecheck and build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run check` | Typecheck, lint, licence check, unit + integration tests with coverage thresholds |
| `npm run test:e2e` | End-to-end tests against the production build (`npx playwright install chromium firefox` first) |
| `LIVE_CHESSCOM_USER=<name> npm run test:live` | Import your 10 most recent Chess.com games through the real API and verify every move |

In PowerShell, set the variable first: `$env:LIVE_CHESSCOM_USER="name"; npm run test:live`.

## Layout

```
src/core/    pure chess logic (rules via chess.js, PGN parsing/export, game records) — no React, no I/O
src/infra/   adapters: Chess.com API client
src/app/     state stores and import services
src/ui/      React components and pages
tests/       unit, integration (MSW), e2e (Playwright), live; fixtures in tests/fixtures
docs/        specification
```

## Licensing

Personal project, not yet licensed for distribution. The Stockfish engine added in Phase 2 is GPL-3.0; see [docs/PRODUCT_REQUIREMENTS.md §10](docs/PRODUCT_REQUIREMENTS.md#10-licensing-and-legal).
