import { z } from "zod";

/**
 * Read-side validation of stored records (docs/TECHNICAL_ARCHITECTURE.md D14). A record that
 * fails is reported and left in place, never deleted or overwritten.
 */

const color = z.enum(["w", "b"]);
const result = z.enum(["1-0", "0-1", "1/2-1/2", "*"]);

const PlySchema = z.object({
  index: z.number().int().positive(),
  uci: z.string(),
  san: z.string(),
  color,
  fenAfter: z.string(),
  clockSeconds: z.number().optional(),
});

const TerminalStateSchema = z.union([
  z.object({ kind: z.literal("checkmate"), winner: color }),
  z.object({ kind: z.enum(["stalemate", "insufficient_material", "threefold_repetition", "fifty_move_rule"]) }),
]);

const GameSourceSchema = z.union([
  z.looseObject({ kind: z.literal("chesscom"), url: z.string(), rules: z.string() }),
  z.looseObject({ kind: z.literal("pgn") }),
]);

const PlayerSchema = z.object({ name: z.string(), rating: z.number().optional() });

export const StoredGameSchema = z.looseObject({
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  source: GameSourceSchema,
  pgn: z.string(),
  headers: z.record(z.string(), z.string()),
  startFen: z.string(),
  plies: z.array(PlySchema),
  white: PlayerSchema,
  black: PlayerSchema,
  result,
  terminal: TerminalStateSchema.nullable(),
  warnings: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const ScoreSchema = z.union([
  z.object({ kind: z.literal("cp"), value: z.number().int() }),
  z.object({ kind: z.literal("mate"), moves: z.number().int().refine((n) => n !== 0, "mate 0 is never stored") }),
  z.object({ kind: z.literal("terminal"), result: z.enum(["1-0", "0-1", "1/2-1/2"]) }),
]);

const EngineLineSchema = z.object({
  rank: z.number().int().positive(),
  score: ScoreSchema,
  wdl: z.tuple([z.number(), z.number(), z.number()]).optional(),
  depth: z.number().int().nonnegative(),
  selDepth: z.number().int().nonnegative().optional(),
  nodes: z.number().int().nonnegative(),
  pv: z.array(z.string()).max(24),
});

const PositionResultSchema = z.discriminatedUnion("status", [
  z.object({
    positionIndex: z.number().int().nonnegative(),
    status: z.literal("done"),
    lines: z.array(EngineLineSchema).min(1),
    bestMove: z.string(),
    timeMs: z.number(),
  }),
  z.object({
    positionIndex: z.number().int().nonnegative(),
    status: z.literal("terminal"),
    terminal: z.object({ kind: z.literal("terminal"), result: z.enum(["1-0", "0-1", "1/2-1/2"]) }),
    lines: z.tuple([]),
  }),
  z.object({
    positionIndex: z.number().int().nonnegative(),
    status: z.literal("failed"),
    error: z.string(),
    lines: z.tuple([]),
  }),
]);

export const RawAnalysisSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.literal(1),
    gameId: z.string().min(1),
    engine: z.object({
      name: z.literal("stockfish"),
      version: z.string(),
      flavour: z.enum(["lite-single", "full-single"]),
      nnue: z.string().optional(),
    }),
    settings: z.object({
      preset: z.enum(["quick", "standard", "deep", "custom"]),
      nodes: z.number().int().positive(),
      maxDepth: z.number().int().positive(),
      multiPv: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      hashMb: z.number().int().positive(),
      freshHashPerPosition: z.literal(true),
    }),
    settingsHash: z.string().regex(/^[0-9a-f]{16}$/),
    positions: z.array(PositionResultSchema.nullable()),
    completedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().positive(),
    startedAt: z.number(),
    completedAt: z.number().optional(),
  })
  .refine((a) => a.positions.length === a.totalCount, "positions.length must equal totalCount")
  .refine((a) => a.positions.every((p, i) => p === null || p.positionIndex === i), "positionIndex must match its slot");

// ---------------------------------------------------------------- Reviews (Phase 3, derived data)

const label = z.enum(["book", "forced", "best", "excellent", "good", "inaccuracy", "mistake", "blunder", "miss", "great", "brilliant"]);
const severity = z.enum(["best", "excellent", "good", "inaccuracy", "mistake", "blunder"]);
const phase = z.enum(["opening", "middlegame", "endgame"]);
const percent = z.number().min(0).max(100);
const accuracyMode = z.enum(["default", "lichessCompat"]);
const suggestion = z.object({ uci: z.string(), san: z.string(), winAfter: percent });

const MoveAnalysisSchema = z.object({
  plyIndex: z.number().int().positive(),
  color,
  san: z.string(),
  uci: z.string(),
  scoreBefore: ScoreSchema.optional(),
  scoreAfter: ScoreSchema.optional(),
  winBefore: percent.optional(),
  winAfter: percent.optional(),
  winLoss: z.number().min(0).max(100).optional(),
  cpLoss: z.number().min(0).optional(),
  bestMove: suggestion.optional(),
  secondBest: suggestion.optional(),
  bestLineSan: z.array(z.string()),
  refutationSan: z.array(z.string()),
  severity: severity.optional(),
  label: label.optional(),
  labelReasons: z.array(z.string()),
  accuracy: percent.optional(),
  volatilityWeight: z.number().optional(),
  countsTowardAccuracy: z.boolean(),
  phase,
  motifs: z.array(z.never()),
  clockSeconds: z.number().optional(),
  graded: z.boolean(),
});

const PlayerSummarySchema = z.object({
  accuracy: percent.optional(),
  accuracyMode,
  accuracyByPhase: z.object({ opening: percent.optional(), middlegame: percent.optional(), endgame: percent.optional() }),
  acpl: z.number().int().min(0).optional(),
  labelCounts: z.record(label, z.number().int().min(0)),
  gradedMoves: z.number().int().min(0),
  ungradedMoves: z.number().int().min(0),
  countedMoves: z.number().int().min(0),
  excludedForced: z.number().int().min(0),
  excludedMissingWeight: z.number().int().min(0),
});

export const GameReviewSchema = z.object({
  gameId: z.string().min(1),
  rawAnalysisId: z.string().min(1),
  methodologyVersion: z.string().min(1),
  configHash: z.string().regex(/^[0-9a-f]{16}$/),
  accuracyMode,
  moves: z.array(MoveAnalysisSchema),
  white: PlayerSummarySchema,
  black: PlayerSummarySchema,
  winSeries: z.array(percent.nullable()),
  phaseBoundaries: z.object({ middlegameStartPly: z.number().int().optional(), endgameStartPly: z.number().int().optional() }),
  opening: z.object({ eco: z.string(), name: z.string(), ply: z.number().int().min(0) }).optional(),
  turningPoint: z.number().int().positive().optional(),
  coverage: z.object({
    total: z.number().int().positive(),
    analysed: z.number().int().min(0),
    failed: z.number().int().min(0),
    pending: z.number().int().min(0),
    complete: z.boolean(),
  }),
  keyMoments: z.array(z.number().int()),
});

export const ReviewRecordSchema = z
  .object({
    rawAnalysisId: z.string().min(1),
    methodologyVersion: z.string().min(1),
    gameId: z.string().min(1),
    configHash: z.string().regex(/^[0-9a-f]{16}$/),
    derivedAt: z.number(),
    schemaVersion: z.literal(1),
    review: GameReviewSchema,
  })
  .refine((r) => r.review.rawAnalysisId === r.rawAnalysisId && r.review.methodologyVersion === r.methodologyVersion, "record keys must match the review")
  .refine((r) => r.review.gameId === r.gameId && r.review.configHash === r.configHash, "record fields must match the review")
  .refine((r) => r.review.moves.length + 1 === r.review.winSeries.length, "one Win% per position");

export const HttpCacheEntrySchema = z.object({
  url: z.string().url(),
  fetchedAt: z.number(),
  body: z.unknown(),
});
