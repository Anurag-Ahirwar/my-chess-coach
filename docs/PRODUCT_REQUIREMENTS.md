# Product Requirements

| | |
|---|---|
| Status | Draft v0.2 — Phase 0 (specification), revised after owner review |
| Date | 2026-11-03 |
| Owner | Anurag |
| Related | [TECHNICAL_ARCHITECTURE](TECHNICAL_ARCHITECTURE.md) · [CHESS_ANALYSIS_METHODOLOGY](CHESS_ANALYSIS_METHODOLOGY.md) · [AI_COACH_DESIGN](AI_COACH_DESIGN.md) · [DATA_MODELS](DATA_MODELS.md) · [TESTING_STRATEGY](TESTING_STRATEGY.md) · [DEVELOPMENT_ROADMAP](DEVELOPMENT_ROADMAP.md) |

---

## 1. Summary

A local-first web application that imports a player's Chess.com games (or any PGN), analyses every move with Stockfish running in the browser, classifies moves and computes accuracy with a documented methodology, and adds an optional AI coach that explains the verified engine findings in plain language. Over many games it builds a personal profile of recurring weaknesses and turns them into training drawn from the player's own mistakes.

**Core philosophy:** *Stockfish determines what happened. Our code calculates the results. AI explains what they mean.*

## 2. Problem

- Chess.com's free tier allows a limited number of full Game Reviews per day.
- Free engine analysis exists (e.g. Lichess), but it tells you *what* was wrong, not *why*, and it does not connect mistakes across games into a learning plan.
- Asking a general-purpose LLM to review a game directly produces confident but frequently wrong analysis (hallucinated tactics, illegal moves, wrong evaluations).

## 3. Users

| User | Description | Priority |
|---|---|---|
| Primary | The owner: an active Chess.com player who wants unlimited, understandable reviews and a path to improvement. | Design target |
| Secondary | Other club-level players (roughly 600–2000 rated) running the app locally. | Considered, not optimised for |
| Out of scope | Titled players needing opening prep tools; coaches managing many students; hosted multi-tenant users. | — |

Design implication: explanations default to the **Intermediate** level, and the UI favours clarity over the density of tools like ChessBase.

## 4. Product principles

1. **Deterministic core, interpretive AI.** Every number and label shown is computed by code from engine output. The LLM never produces an evaluation, a best move, or a label.
2. **AI is optional.** With no API key, the app is a complete game-review tool.
3. **Honest uncertainty.** If a label (e.g. Brilliant) cannot be established by objective rules, it is not shown. Statistical claims need minimum sample sizes.
4. **Transparent methodology.** Accuracy and classification rules are documented, versioned, and reproducible. We do not claim equivalence with Chess.com's proprietary numbers.
5. **Local-first and private.** Games, analyses and keys stay on the user's machine. The only network calls go to Chess.com's public API and, if enabled, to the chosen LLM provider.
6. **Learning over grading.** Every feature should answer "what do I do differently next time?"

## 5. Goals and non-goals

### Goals (v1)
- G1. Unlimited full game reviews with move labels, accuracy, eval bar and eval graph.
- G2. One-click import of the user's recent Chess.com games.
- G3. AI explanations of key moments, grounded in engine data, at three skill levels.
- G4. Persistent history so analyses are not recomputed.
- G5. A mistake library with "retry this position".

### Goals (v2)
- G6. Recurring-weakness detection across games with honest sample-size gating.
- G7. Personalised training plan built from the user's own positions.
- G8. Statistics dashboard (accuracy trends, openings, phases, blunder rate, time trouble).

### Non-goals
- Hosted multi-user service, accounts, payments.
- Playing games / bots.
- Chess variants (Chess960, Bughouse, etc.) in v1. Chess.com games with `rules != "chess"` are listed but not analysable.
- Reproducing Chess.com's accuracy, "game rating", or exact Brilliant/Great decisions.
- Mobile-native apps (the web UI must still be usable on a phone).

## 6. Assumptions challenged

These are places where the original brief is changed or tightened. Rationale is expanded in the linked documents.

| # | Original assumption | Concern | Recommendation |
|---|---|---|---|
| 1 | Chess.com integration is Phase 5. | It is two simple, CORS-enabled GET endpoints and is the main way the user gets games. Real games are also needed to test the engine pipeline. | Move Chess.com import into **Phase 1**. |
| 2 | "Analysis levels = depth." | Fixed depth has very uneven cost (endgames finish in milliseconds, sharp middlegames take much longer). | Budget by **node count** with a depth cap; benchmark before publishing times. |
| 3 | One Stockfish worker or many? | Multi-threaded Stockfish needs `SharedArrayBuffer`, so the page has to be cross-origin isolated (COOP/COEP), which breaks loading third-party images such as Chess.com avatars. | A **pool of single-threaded workers** that analyse different positions in parallel. Same total throughput for whole-game review, no special headers. |
| 4 | The label set is fixed at 10 labels. | A move that was the only legal move should not be graded. Brilliant and Great cannot always be decided. | Add **Forced**. Brilliant and Great are **experimental**, are only assigned at Standard or Deep analysis, and are dropped if their conditions cannot be checked. |
| 5 | `ChessCoach` methods return `string`. | Free text cannot be validated (invented moves, numbers). | Coach methods return **typed, schema-validated objects**. The UI renders all numbers itself, from engine data. |
| 6 | The AI identifies patterns. | An LLM counting patterns across games is not reliable or reproducible. | **Code** detects and counts motifs (hanging pieces, forks, missed mates…). The LLM only narrates statistics that already passed sample-size checks. |
| 7 | Explain every move. | It costs tokens for little value. Most moves are fine. | Explain **key moments** (≈4–8 per game) automatically. Any other move is explained only when the user clicks it, and the result is cached. |
| 8 | API keys handled "securely" in a browser app. | No browser storage is truly secure against code running on the same origin. | By default the key lives **in memory only**. "Remember key" is opt-in, with a clear warning. A strict CSP and no third-party scripts. An optional local proxy later. |
| 9 | Store the computed analysis. | Changing the methodology would force re-running the engine on every stored game. | Store **raw engine output** (versioned by engine and settings). Labels and accuracy are cheap and are recomputed with the current methodology version. |
| 10 | Opening/middlegame/endgame performance is a simple split. | Phase boundaries are heuristic, and wrong boundaries mislead users. | Use a documented, Lichess-inspired material and development heuristic. Show phase accuracy only when a phase has at least 6 moves by that player. |

## 7. Functional requirements

Priority: **P0** = MVP (required for first usable release), **P1** = v1, **P2** = v2.

### F1 Game import
| ID | Requirement | Priority |
|---|---|---|
| F1.1 | Paste PGN text, or upload a `.pgn` file containing one or more games. A multi-game file shows a game picker. | P0 |
| F1.2 | Validate PGN and report the exact move or line that failed, without crashing. | P0 |
| F1.3 | Support games starting from a custom position (`[SetUp "1"]` + `[FEN]`). | P1 |
| F1.4 | Enter a Chess.com username → list monthly archives → list games (opponent, result, time class, date, opening) → import. | P0 |
| F1.5 | "Recent games" shortcut: latest archive month for the remembered username. | P0 |
| F1.6 | Never refetch a past month (they never change). Recheck the archive list and current month through the browser's HTTP cache (`cache: "no-cache"`). The API's CORS policy doesn't let scripts send `If-None-Match` themselves (architecture §7). Never fire parallel bursts of requests. | P0 |
| F1.7 | Show clear errors for an unknown user (404), an archive that is gone (410), rate limiting (429), and being offline. | P0 |
| F1.8 | Export a game as PGN, optionally with our evaluations and labels as comments (`[%eval]`, NAGs). | P1 |

### F2 Board and navigation
| ID | Requirement | Priority |
|---|---|---|
| F2.1 | Board with the user's colour at the bottom (auto-detected from username, manual flip). | P0 |
| F2.2 | Move navigation: first/prev/next/last buttons, arrow keys, and clicking moves in the list or points on the graph. | P0 |
| F2.3 | Arrows: the played move and the engine's best move, in distinct colours. | P0 |
| F2.4 | Label badge on the destination square of the current move. | P1 |
| F2.5 | Explore a variation from any position (moves are legality-checked) with live engine evaluation. | P1 |

### F3 Engine analysis
| ID | Requirement | Priority |
|---|---|---|
| F3.1 | Analyse every position of the game in background workers. The UI stays responsive and shows progress. | P0 |
| F3.2 | Quick / Standard / Deep presets (node budgets, see methodology). Advanced users can change the budgets. | P0 |
| F3.3 | Cancel analysis. A partial analysis can be resumed without recomputing positions already done. | P1 |
| F3.4 | The engine's identity (version, network, build) is recorded with every analysis. | P0 |
| F3.5 | Analyse a batch of games in the background (queue) for statistics. | P2 |

### F4 Review metrics
| ID | Requirement | Priority |
|---|---|---|
| F4.1 | Per-move label: Book, Forced, Best, Excellent, Good, Inaccuracy, Mistake, Blunder, Miss; Great and Brilliant (experimental). | P0 (P1 for Great/Brilliant) |
| F4.2 | Per-player accuracy, using our documented methodology: the Lichess-compatible formula and aggregation, with Forced moves excluded. Plus per-phase accuracy when there are enough moves. It is never presented as comparable to Chess.com's accuracy. | P0 |
| F4.3 | Count of each label per player. | P0 |
| F4.4 | Eval bar (white's perspective, mate shown as `M3`, etc.) and eval graph over the whole game. | P0 |
| F4.5 | Best line (PV) for the current position, and the refutation line for the played move. | P0 |
| F4.6 | Opening name from the bundled ECO dataset. | P1 |
| F4.7 | If the Chess.com game includes `accuracies`, optionally show them as "Chess.com reported" beside ours, clearly labelled. | P1 |

### F5 AI coach (optional)
| ID | Requirement | Priority |
|---|---|---|
| F5.1 | Enter a Gemini API key and choose a Gemini model. The architecture is provider-independent. Claude and OpenAI are **deferred** (roadmap Phase 4b) until the Gemini coach is stable. | P1 (Gemini); P2 (Claude, OpenAI) |
| F5.2 | Game summary: overview, strongest moments, biggest mistakes, turning points, phase performance, and three improvement points. | P1 |
| F5.3 | Explain a move at Beginner, Intermediate or Advanced level. | P1 |
| F5.4 | Explanations reference moves only through ids from an engine-derived move catalogue, and contain no evaluation numbers. Output that fails validation is retried once and then replaced by a template explanation. Validation is syntactic: it does **not** guarantee that every chess claim in the prose is true (AI_COACH_DESIGN §7.3). | P1 |
| F5.5 | Cache explanations. Show tokens used per call and the running total. | P1 |
| F5.6 | Fail gracefully: the review works fully when the AI is unavailable. | P1 |

### F6 History and mistake library
| ID | Requirement | Priority |
|---|---|---|
| F6.1 | Store imported games and analyses in IndexedDB. Reopen without re-analysing. | P1 |
| F6.2 | Automatically add Mistake, Blunder and Miss positions to a mistake library. | P1 |
| F6.3 | "Retry this mistake": set up the position, let the user move, and check against the engine. | P1 |
| F6.4 | Export/import the whole database as JSON (backup). | P1 |

### F7 Patterns, statistics, training
| ID | Requirement | Priority |
|---|---|---|
| F7.1 | Deterministic motif tags per mistake (hanging piece, missed fork, missed mate, back-rank, etc.). | P2 |
| F7.2 | Recurring weakness report, with minimum sample sizes and the evidence (games and moves) for each claim. | P2 |
| F7.3 | Training plan: drills from the user's own mistake positions, plus external themed puzzle links. | P2 |
| F7.4 | Dashboard: accuracy over time, by time class, by opening, by phase; blunder rate; time-trouble errors (if `%clk` data is present). | P2 |

### F8 Settings
| ID | Requirement | Priority |
|---|---|---|
| F8.1 | Analysis preset, coaching level, board orientation, theme (light/dark). | P0 |
| F8.2 | API key management: in memory by default, opt-in persistence, clear button. | P1 |
| F8.3 | Methodology version and engine info shown on an "About this analysis" panel. | P1 |

## 8. Non-functional requirements

| Area | Requirement |
|---|---|
| Correctness | Chess rules come only from chess.js. Evaluations only from Stockfish. Perspective-normalisation is covered by tests (see [TESTING_STRATEGY](TESTING_STRATEGY.md)). |
| Performance | The UI thread never runs engine work. Targets for full-game analysis time are set **after** the Phase 2 benchmark, not before. |
| Offline | After the first load, PGN review works fully offline. Only Chess.com import and the AI need a network. |
| Privacy | No analytics or telemetry, and no third-party scripts at runtime. Keys never logged. |
| Browser support | Current Chrome, Edge and Firefox on desktop. Safari is best-effort. Must work on a phone-width screen. |
| Accessibility | Keyboard navigation of moves. Colour is never the only carrier of meaning (labels have icons and text). WCAG AA contrast. |
| Maintainability | Strict TypeScript. Chess and maths logic in pure modules with no React dependency. |
| Reproducibility | Same game + same engine build + same preset ⇒ same labels and accuracy (single-threaded, node-budgeted, fresh hash). |

## 9. Success criteria

- A full review of a typical 40-move game completes with the Standard preset on the owner's machine, in a time we have measured.
- On a test set of games already analysed by Lichess, our accuracy computed **from Lichess's own evals** (in `lichessCompat` mode), rounded to an integer, is within ±1 of Lichess's reported accuracy. This validates that the formula is implemented correctly. It says nothing about matching Chess.com, which is not a goal.
- No AI move reference outside the engine-derived catalogue ever reaches the UI.
- The incorrect-claim rate of AI explanations is measured by hand and tracked over time.
- The owner uses it instead of Chess.com Game Review for a month.

## 10. Licensing and legal

- **Stockfish is GPL-3.0.** Shipping the engine with the app means that anyone we distribute the app to must also be able to get the complete corresponding source. The simplest compliant route is to license this project as **GPL-3.0** too. For personal use only, there is no obligation. This must be decided before any public distribution.
- chess.js (BSD-2), react-chessboard (MIT), React (MIT), Vite (MIT), Tailwind (MIT), Dexie (Apache-2.0), Zod (MIT) are all GPL-compatible.
- The Lichess opening names dataset is **CC0**.
- Lichess's source code (lila) is AGPL-3.0. We **re-implement the formulas** in our own code, as documented on lichess.org and as readable in their source. We do not copy their code. The test vectors are re-expressed as our own table tests.
- Do not use Chess.com's name, logo, or label icons/artwork. Use our own visual language. "Chess.com" appears only to describe the import source.
- Follow the Chess.com Published-Data API usage guidance: serial requests, caching, identify the client where possible.
