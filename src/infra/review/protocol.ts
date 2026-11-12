import type { RawAnalysis } from "@/core/engine/analysis";
import type { GameRecord } from "@/core/game/types";
import type { GameReview } from "@/core/review";

/** Messages between the review client (main thread) and the review Worker. */
export interface DeriveRequest {
  type: "derive";
  id: number;
  game: GameRecord;
  raw: RawAnalysis;
}

export type DeriveResponse =
  | { type: "result"; id: number; review: GameReview; deriveMs: number; indexMs: number }
  | { type: "error"; id: number; kind: "index" | "derive"; message: string };
