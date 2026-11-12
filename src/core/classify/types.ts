import type { Color, Fen, Uci } from "../chess/types";
import type { EngineLine, Score } from "../engine/types";

/** docs/DATA_MODELS.md §6. */
export type Label =
  | "book"
  | "forced"
  | "best"
  | "excellent"
  | "good"
  | "inaccuracy"
  | "mistake"
  | "blunder"
  | "miss"
  | "great"
  | "brilliant";

export type Severity = "best" | "excellent" | "good" | "inaccuracy" | "mistake" | "blunder";

export const SEVERITY_ORDER: readonly Severity[] = ["best", "excellent", "good", "inaccuracy", "mistake", "blunder"];

export const LABELS: readonly Label[] = [
  "brilliant",
  "great",
  "best",
  "excellent",
  "good",
  "book",
  "forced",
  "inaccuracy",
  "mistake",
  "miss",
  "blunder",
];

/** The engine's view of one position, as stored (White POV). */
export interface PositionEval {
  /** `lines[0].score`, or the rules-based terminal score. */
  score: Score;
  /** Engine lines (empty for a terminal position). */
  lines: readonly EngineLine[];
  /** The engine's reported bestmove (D16); undefined for a terminal position. */
  bestMove?: Uci;
}

/** Everything the label rules need about one move (methodology §5.1). */
export interface MoveInput {
  /** The mover. */
  color: Color;
  /** The move played, UCI. */
  uci: Uci;
  /** Position before the move (P). */
  fenBefore: Fen;
  /** Legal moves at P. */
  legalMoves: number;
  /** The position after this move and every earlier position are in the opening index (§5.8, M5). */
  bookChain: boolean;
  /** Engine evaluation of P; undefined when missing. */
  before: PositionEval | undefined;
  /** Engine evaluation (or terminal score) of P′; undefined when missing. */
  after: PositionEval | undefined;
  /** Severity of the opponent's previous move, if it has one (Miss condition 1, M8). */
  previousSeverity?: Severity | undefined;
  /** Win% for the mover at the position before the opponent's previous move (Wprev). */
  winPrev?: number | undefined;
  /** The opponent's previous move (Great's recapture rule). */
  previousMove?: { uci: Uci; capture: boolean } | undefined;
  /** MultiPV of the analysis and whether its preset allows Great/Brilliant (not Quick). */
  analysis: { multiPv: number; allowsSpecialLabels: boolean };
}

export interface MoveVerdict {
  label?: Label;
  severity?: Severity;
  /** Machine-readable reasons (rule ids), always present, also for ungraded moves. */
  reasons: string[];
  /** Mover's Win% before and after, and the loss (when both evaluations exist). */
  winBefore?: number;
  winAfter?: number;
  winLoss?: number;
}
