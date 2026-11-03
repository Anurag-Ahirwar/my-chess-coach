import { z } from "zod";

// Only the fields the app uses are validated. Unknown fields are kept (looseObject),
// and optional fields may be missing in older games or other game types.

export const ProfileSchema = z.looseObject({
  username: z.string(),
  url: z.string().optional(),
  name: z.string().optional(),
  avatar: z.string().optional(),
});
export type ChessComProfile = z.infer<typeof ProfileSchema>;

export const ArchivesSchema = z.looseObject({
  archives: z.array(z.string()),
});

const PlayerSchema = z.looseObject({
  username: z.string(),
  rating: z.number().optional(),
  result: z.string(),
  uuid: z.string().optional(),
});

export const GameSchema = z.looseObject({
  url: z.string(),
  pgn: z.string().optional(),
  time_control: z.string(),
  end_time: z.number().optional(),
  rated: z.boolean().optional(),
  uuid: z.string().optional(),
  time_class: z.string(),
  rules: z.string(),
  eco: z.string().optional(),
  white: PlayerSchema,
  black: PlayerSchema,
  accuracies: z.looseObject({ white: z.number(), black: z.number() }).optional(),
});
export type ChessComGame = z.infer<typeof GameSchema>;

export const MonthSchema = z.looseObject({
  games: z.array(GameSchema),
});
