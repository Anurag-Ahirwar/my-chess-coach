# Data Models

| | |
|---|---|
| Status | Draft v0.2 — Phase 0, revised after owner review |
| Date | 2026-11-03 |
| Storage | IndexedDB through Dexie (schema v1) and localStorage for preferences |

---

## 1. Design principles

1. **Store raw, derive the rest.** Engine output is expensive to produce, so it is stored. Labels, accuracy, phases and motifs are cheap to derive, so they are recomputed with the current `methodologyVersion`, and cached only with that version tag.
2. **Every analysis is tagged with what produced it**: engine build, network, preset. Results from different builds are never mixed.
3. **White-perspective scores everywhere** in storage (see methodology §2).
4. **Moves are stored in UCI** (unambiguous), with SAN cached for display.
5. **Plies are indexed from 0.** Position *k* is the position after *k* half-moves. Move *k* (1-based) leads from position *k−1* to position *k*.
6. Every stored record carries `schemaVersion`. Dexie migrations upgrade old records.

## 2. Entity relationships

```mermaid
erDiagram
    GAME ||--o{ RAW_ANALYSIS : "analysed with"
    RAW_ANALYSIS ||--|{ POSITION_RESULT : contains
    GAME ||--o{ DERIVED_REVIEW : "cached derivation"
    GAME ||--o{ EXPLANATION : "AI/template text"
    GAME ||--o{ MISTAKE : "produces"
    MISTAKE ||--o{ DRILL_ATTEMPT : "retried in"
    CHESSCOM_CACHE }o--|| GAME : "imports"
    PLAYER_PROFILE ||--o{ GAME : "owns (by username)"
```

## 3. Core chess types (`core/`)

```ts
export type Color = "w" | "b";
export type Uci = string;     // "e2e4", "e7e8q", "e1g1"
export type San = string;     // "e4", "exd8=Q+", "O-O"
export type Fen = string;
export type Epd = string;     // first four FEN fields

export type Score =
  | { kind: "cp"; value: number }                       // White POV
  | { kind: "mate"; moves: number }                     // ≠ 0, White POV sign
  | { kind: "terminal"; result: "1-0" | "0-1" | "1/2-1/2" };

export interface Ply {
  index: number;              // 1..n (move index); position index = this
  uci: Uci;
  san: San;
  color: Color;               // mover
  fenAfter: Fen;
  clockSeconds?: number;      // from [%clk], if present
}
```

## 4. Games

Reconciled with the Phase 1 code in Phase 2 (decision D2). Code: `src/core/game/types.ts`.

```ts
export type GameSource =
  | { kind: "chesscom"; url: string; uuid?: string; timeClass?: string; rules: string;
      endTime?: number; reportedAccuracy?: { white: number; black: number } }
  | { kind: "pgn"; fileName?: string };

export type TimeControl =
  | { kind: "live"; initialSeconds: number; incrementSeconds: number }
  | { kind: "daily"; secondsPerMove: number }
  | { kind: "unknown"; raw: string };

export interface GameRecord {
  id: string;                 // chesscom: "cc:" + uuid (or url hash); pgn: "pgn:" + sha256(start FEN + UCI moves)
  source: GameSource;
  pgn: string;                // original text for Chess.com games; a normalised export for file imports
  headers: Record<string, string>;
  startFen: Fen;              // standard start or [FEN] header
  plies: Ply[];
  white: { name: string; rating?: number };
  black: { name: string; rating?: number };
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
  termination?: string;
  playedAt?: number;          // epoch ms, from UTCDate/UTCTime (or Date)
  timeControl?: TimeControl;
  terminal: TerminalState | null; // rules-based state of the final position
  warnings: string[];         // PGN parser warnings (duplicate tags, result mismatch)
}

/** What is stored in IndexedDB `games`. */
export interface StoredGame extends GameRecord {
  schemaVersion: 1;
  createdAt: number;          // first import; kept on re-import
  updatedAt: number;          // latest import
}
```

`id` makes imports idempotent: importing the same game twice updates the existing record instead of duplicating it. Its analyses stay linked through `gameId`.

**Removed from the Phase 0 draft (D2):**
- `userColor`: derived from the username preference at render time, because a stored copy would go stale when the preference changes.
- `opening`: derived in Phase 3 from the opening dataset.
- `tags`: added when a phase needs it.
- `GameSource.pgn.importedAt`: covered by `createdAt`.

## 5. Engine analysis (raw, expensive)

Implemented in Phase 2 (`src/core/engine/types.ts`, `src/core/engine/analysis.ts`), with decisions D3, D4 and D16 applied.

```ts
export interface EngineIdentity {
  name: "stockfish";
  version: string;            // "19.0.1" — the pinned npm package
  flavour: "lite-single" | "full-single";
  nnue?: string;              // the engine's EvalFile default, e.g. "nn-61e7af4bb97d.nnue"
}

export interface AnalysisSettings {
  preset: "quick" | "standard" | "deep" | "custom";
  nodes: number;
  maxDepth: number;
  multiPv: 1 | 2 | 3;
  hashMb: number;
  freshHashPerPosition: true; // always: ucinewgame before every position (spec D9)
}

export interface EngineLine {
  rank: number;               // multipv index, 1-based
  score: Score;               // White POV; mate is never stored as centipawns
  wdl?: [number, number, number]; // per-mille, White POV (converted from side to move), if reported
  depth: number;              // depth of the iteration this line comes from; lines may differ
  selDepth?: number;
  nodes: number;
  pv: Uci[];                  // capped at 24 plies (D4)
}

export type PositionResult =
  | { positionIndex: number; status: "done"; lines: EngineLine[]; bestMove: Uci; timeMs: number }
  | { positionIndex: number; status: "terminal"; terminal: Score & { kind: "terminal" }; lines: [] }
  | { positionIndex: number; status: "failed"; error: string; lines: [] };

export interface RawAnalysis {
  id: string;                 // `${gameId}|${engineKey}|${settingsHash}`
  schemaVersion: 1;
  gameId: string;
  engine: EngineIdentity;
  settings: AnalysisSettings;
  settingsHash: string;       // SHA-256 (first 16 hex) of the canonical settings JSON — settings only
  positions: (PositionResult | null)[]; // length totalCount; null = not analysed yet
  completedCount: number;     // positions that are done or terminal
  totalCount: number;         // n + 1
  startedAt: number;
  completedAt?: number;       // set when completedCount === totalCount
}
```

- **Key (D3).** `engineKey` = `${name}-${version}-${flavour}`, e.g. `stockfish-19.0.1-lite-single`. The network is implied by version and flavour. The settings hash covers the settings only, so the engine no longer appears in the key twice. Different engines or settings for the same game get different ids and never overwrite each other.
- **Positions (D3).** A dense array, with `null` for positions not analysed yet, never a sparse array with holes.
- **Failed positions.** `failed` positions don't count as complete, so an analysis with a failure is never `completedAt`. The next run retries those positions.
- **Stopped searches.** A search stopped before its budget is never stored: that position stays `null` and is resumed later. So no `cancelled` status is needed.
- **`bestMove` (D16).** The engine's reported `bestmove`. It may differ from `lines[0].pv[0]` when a node-limited search is cut short (architecture §6.1 notes).
- **Validation.** A position is `done` only if the best move and every PV replay legally from the analysed position, and the engine reported no anomaly (e.g. `mate 0`). Otherwise it is `failed`, with the reason in `error`.
- **Terminal positions (D6).** Only the game's final position can be `terminal` (methodology §3).

Size estimate: 81 positions × 2 lines × a PV of about 20 moves ≈ 40–80 KB per game in JSON. 1,000 games ≈ 40–80 MB, which is well within IndexedDB limits. PV length is capped at 24 plies.

## 6. Derived review (cheap, versioned)

```ts
export type Label =
  | "book" | "forced" | "best" | "excellent" | "good"
  | "inaccuracy" | "mistake" | "blunder" | "miss"
  | "great" | "brilliant";

export type Severity = "best" | "excellent" | "good" | "inaccuracy" | "mistake" | "blunder";

export interface MoveAnalysis {
  plyIndex: number;
  color: Color;
  san: San; uci: Uci;
  scoreBefore?: Score;         // White POV; undefined if that position's analysis failed
  scoreAfter?: Score;          // White POV; undefined if that position's analysis failed
  winBefore?: number;          // mover POV, 0..100
  winAfter?: number;           // mover POV
  winLoss?: number;            // ≥ 0
  cpLoss?: number;             // mover POV, ceiled (methodology §6.6)
  bestMove?: { uci: Uci; san: San; winAfter: number };
  secondBest?: { uci: Uci; san: San; winAfter: number };
  bestLineSan: San[];          // PV from the position before
  refutationSan: San[];        // PV from the position after (opponent to move)
  severity?: Severity;         // undefined if ungraded
  label?: Label;               // undefined if ungraded
  labelReasons: string[];      // machine-readable rule ids, e.g. ["band:blunder","mate:allowed"]
  accuracy?: number;           // move accuracy 0..100; undefined if scoreBefore/After missing
  volatilityWeight?: number;   // undefined if any position in its window is missing (methodology §6.2)
  countsTowardAccuracy: boolean; // accuracy && weight defined && !(forced && mode === "default")
  phase: "opening" | "middlegame" | "endgame";
  motifs: MotifTag[];
  clockSeconds?: number;
  graded: boolean;             // has a label (false when either eval is missing)
}

export interface PlayerSummary {
  accuracy?: number;           // game accuracy, full precision; undefined if no counted moves
  accuracyMode: "default" | "lichessCompat";
  accuracyByPhase: Partial<Record<"opening" | "middlegame" | "endgame", number>>;
  acpl?: number;
  labelCounts: Record<Label, number>;
  gradedMoves: number;
  ungradedMoves: number;       // missing evals
  countedMoves: number;        // contributed to game accuracy
  excludedForced: number;      // default mode only
  excludedMissingWeight: number; // shown as "N moves not included in accuracy"
}

export interface GameReview {
  gameId: string;
  rawAnalysisId: string;
  methodologyVersion: string;
  moves: MoveAnalysis[];
  white: PlayerSummary;
  black: PlayerSummary;
  winSeries: (number | null)[]; // White-POV Win% per position, null where analysis failed (graph shows a gap)
  phaseBoundaries: { middlegameStartPly?: number; endgameStartPly?: number };
  keyMoments: number[];        // ply indices
  derivedAt: number;
}

export interface MotifTag {
  id: MotifId;                 // "hanging_piece" | "fork" | "missed_fork" | ...
  side: Color;                 // who benefits / who is affected (documented per motif)
  confidence: "high" | "medium";
  evidence: { squares?: string[]; moveSan?: San; pvPly?: number; note?: string };
}
```

`GameReview` is cached in the `reviews` table keyed by `[rawAnalysisId, methodologyVersion]`. On load: if the methodology version matches, the cached review is used. Otherwise it is re-derived from `RawAnalysis` in a few milliseconds.

## 7. Coach outputs

```ts
export type CoachLevel = "beginner" | "intermediate" | "advanced";

export interface ExplanationRecord {
  id: string;                  // hash(promptVersion, provider, model, level, task, factsHash)
  gameId: string;
  plyIndex?: number;           // undefined for game summary
  task: "explain_move" | "summarize_game" | "describe_patterns" | "training_plan";
  level: CoachLevel;
  source: "llm" | "template";
  provider?: "gemini" | "claude" | "openai";
  model?: string;
  promptVersion: string;
  methodologyVersion: string;
  content: unknown;            // validated MoveExplanation | GameSummary | ...
  usage?: { inputTokens: number; outputTokens: number };
  createdAt: number;
}

export interface UsageLedgerEntry {
  id?: number;
  at: number;
  provider: string; model: string; task: string;
  inputTokens: number; outputTokens: number;
  ok: boolean; errorCode?: string;
}
```

## 8. Learning features

```ts
export interface MistakeRecord {
  id: string;                  // `${gameId}:${plyIndex}`
  gameId: string;
  plyIndex: number;
  color: Color;
  fenBefore: Fen;
  playedUci: Uci;
  bestUci: Uci;
  acceptableUci: Uci[];        // moves within 'good' band of best (from MultiPV), for retry checking
  label: Label;
  winLoss: number;
  motifs: MotifId[];
  phase: "opening" | "middlegame" | "endgame";
  playedAt?: number;
  // spaced repetition
  srs: { dueAt: number; intervalDays: number; streak: number; lapses: number };
  archived: boolean;
}

export interface DrillAttempt {
  id?: number;
  mistakeId: string;
  at: number;
  answerUci: Uci;
  correct: boolean;            // answer ∈ acceptableUci, or engine confirms it within the 'good' band
  verifiedByEngine: boolean;
}

export interface PlayerProfile {
  id: string;                  // `${platform}:${lowercased username}`, e.g. "chesscom:exampleuser"
  username: string;
  platform: "chesscom";
  ratings?: Record<string, number>;
  lastSyncedArchive?: string;  // "2026/11"
}

export interface PatternClaim {
  motif: MotifId;
  level: "emerging" | "established";
  occurrences: number;
  games: number;
  totalGamesConsidered: number;
  ratePerGame: number;
  wilsonLower90: number;
  evidence: { gameId: string; plyIndex: number }[];
  byPhase: Partial<Record<"opening" | "middlegame" | "endgame", number>>;
}

export interface PatternReport {
  generatedAt: number;
  gamesAnalysed: number;
  methodologyVersion: string;
  claims: PatternClaim[];
  insufficient: { motif: MotifId; occurrences: number; gamesNeeded: number }[];
}

export interface TrainingPlan {
  items: { drillId: string; title: string; why: string; frequency: string }[];
  basedOnReportAt: number;
}
```

## 9. Chess.com cache

Changed in Phase 2 (decision D5): only past months are stored, because they never change. The archive list and the current month are always rechecked through the browser's HTTP cache. Scripts can't read `ETag` or send `If-None-Match` under Chess.com's CORS policy (architecture §7), so those fields are gone.

```ts
export interface HttpCacheEntry {
  url: string;                 // primary key: the month's API URL
  fetchedAt: number;
  body: unknown;               // the raw response; validated by the Chess.com client on every read
}
```

## 10. Settings

```ts
// localStorage key "prefs.v1": small and non-sensitive
export interface Preferences {
  theme: "system" | "light" | "dark";
  boardOrientation: "auto" | "white" | "black";
  chesscomUsername?: string;
  analysisPreset: "quick" | "standard" | "deep";
  engineFlavour: "lite-single" | "full-single";
  workerCount?: number;
  coachLevel: CoachLevel | "auto";
  aiProvider?: "gemini" | "claude" | "openai"; // type is provider-independent; only "gemini" is selectable until Phase 4b
  aiModel?: string;
  sendPlayerNames: boolean;    // default false
  showChesscomAccuracy: boolean;
}

// IndexedDB table "secrets": ONLY when the user opts in to "remember key"
export interface StoredSecret {
  id: "gemini" | "claude" | "openai";
  apiKey: string;              // never logged, never exported
  savedAt: number;
}
```

## 11. Dexie schema

**Version 1 (Phase 2)** declares only the tables in use (decision D1). Code: `src/infra/storage/db.ts`, database name `chess-coach`.

```ts
db.version(1).stores({
  games:       "id, playedAt, createdAt",
  rawAnalyses: "id, gameId, completedAt",
  httpCache:   "url, fetchedAt",
});
```

**Planned later versions.** Each phase adds its tables with a version bump. Adding a table needs no data migration, and the index design is settled by the phase that uses it.

| Version | Phase | Adds (draft) |
|---|---|---|
| 2 | 3 | `reviews: "[rawAnalysisId+methodologyVersion], gameId"` |
| 3 | 4 | `explanations: "id, gameId, [gameId+plyIndex], task"`, `usage: "++id, at, provider"`, `secrets: "id"` |
| 4 | 5 | `mistakes: "id, gameId, srs.dueAt, label, *motifs, archived"`, `drillAttempts: "++id, mistakeId, at"` |
| later | 6 | `profiles: "id"` |

**Reading and writing (Phase 2):**
- Every record is validated with Zod when read (`src/infra/storage/schemas.ts`). A record that fails is reported in the storage banner, skipped, and **never deleted or overwritten**. A write to its id is refused.
- Analysis writes run read-modify-write inside one Dexie transaction and merge with the stored copy (`mergeAnalyses`): a `done` or `terminal` result is never replaced by `failed` or empty. This makes concurrent writers, such as two tabs, safe.
- If IndexedDB can't be opened, in-memory repositories with the same behaviour are used, and the banner says so. If a write fails (e.g. quota), the data stays in memory for the tab.

Migration rules:
- Never drop user data in a migration. A schema version bump has an `upgrade()` that converts records.
- Backup export (`.json`) includes every table **except** `secrets`. Import validates with Zod and merges by primary key.

## 12. Notation conversions (boundaries)

| From → To | Where | Tool |
|---|---|---|
| PGN SAN → `Ply` (UCI + SAN + FEN) | Import | chess.js |
| UCI PV → SAN PV | Derivation (for display and the AI) | chess.js replay from the position's FEN |
| `Score` (White POV) → display string | UI only | `formatScore`: `+1.24`, `−0.30`, `M3`, `−M2`, `1-0` |
| `Score` → Win% | core/eval | methodology §4 |
