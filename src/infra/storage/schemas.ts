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

export const HttpCacheEntrySchema = z.object({
  url: z.string().url(),
  fetchedAt: z.number(),
  body: z.unknown(),
});
