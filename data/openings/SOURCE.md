# Opening names dataset

- **Source:** [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings), files `a.tsv` to `e.tsv` (columns `eco`, `name`, `pgn`).
- **Pinned commit:** `3ba6b20d31b2e6125cb0e6a2e792f400717d9d39` (2026-11-05), downloaded 2026-11-13. The files are unmodified; `scripts/build-openings.mjs` checks each file's SHA-256 against the pin before using it.
- **Licence:** CC0 1.0 Universal (public domain dedication); see `COPYING.txt`, copied from the same commit.
- **Contents:** 3,865 named lines; 7,982 distinct positions along them; 3,865 distinct named end positions.
- **Use:** the Book label and opening names (docs/CHESS_ANALYSIS_METHODOLOGY.md §5.8). The commit is part of the methodology config (`METHODOLOGY_V1.openings.commit`), so changing the dataset bumps the methodology version.
- **Generated index:** `node scripts/build-openings.mjs --out <file>` writes the EPD index (about 0.97 MB of JSON, 129 KB gzipped). It is generated at build and test time and is not committed.
