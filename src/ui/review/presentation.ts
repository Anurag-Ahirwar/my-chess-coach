import type { Label } from "@/core/classify";
import type { MoveAnalysis, PlayerSummary } from "@/core/review";

/**
 * How labels are SHOWN (presentation only, Phase 3 Stage 2 decision): nothing here changes a stored
 * review, a label, an accuracy or a count. Colour is never the only carrier of meaning: every label
 * has a symbol and a name (docs/PRODUCT_REQUIREMENTS.md §8). Our own visual language, not
 * Chess.com's icons (§10).
 */

export interface LabelInfo {
  name: string;
  /** A short symbol, shown with the name (or as the only visible text in compact places). */
  symbol: string;
  /** CSS class with the label's colour (styles.css). */
  className: string;
  experimental: boolean;
}

export const LABEL_INFO: Readonly<Record<Label, LabelInfo>> = {
  brilliant: { name: "Brilliant", symbol: "!!", className: "label-brilliant", experimental: true },
  great: { name: "Great", symbol: "!", className: "label-great", experimental: true },
  best: { name: "Best", symbol: "★", className: "label-best", experimental: false },
  excellent: { name: "Excellent", symbol: "✓", className: "label-excellent", experimental: false },
  good: { name: "Good", symbol: "○", className: "label-good", experimental: false },
  book: { name: "Book", symbol: "≡", className: "label-book", experimental: false },
  forced: { name: "Forced", symbol: "→", className: "label-forced", experimental: false },
  inaccuracy: { name: "Inaccuracy", symbol: "?!", className: "label-inaccuracy", experimental: false },
  mistake: { name: "Mistake", symbol: "?", className: "label-mistake", experimental: false },
  miss: { name: "Miss", symbol: "✗", className: "label-miss", experimental: false },
  blunder: { name: "Blunder", symbol: "??", className: "label-blunder", experimental: false },
};

/** The order labels are listed in the summary. */
export const DISPLAY_ORDER: readonly Label[] = ["brilliant", "great", "best", "excellent", "good", "book", "forced", "inaccuracy", "mistake", "miss", "blunder"];

/**
 * The label to show for a move. With experimental labels hidden, Great and Brilliant are shown as
 * Best (their severity is Best by definition, methodology §5.6–5.7).
 */
export function displayLabel(label: Label | undefined, showExperimental: boolean): Label | undefined {
  if (label === undefined) return undefined;
  if (!showExperimental && LABEL_INFO[label].experimental) return "best";
  return label;
}

/** Label counts as shown: with experimental labels hidden, Great and Brilliant are counted as Best. */
export function displayCounts(counts: Readonly<Record<Label, number>>, showExperimental: boolean): { label: Label; count: number }[] {
  const shown = { ...counts };
  if (!showExperimental) {
    shown.best += shown.great + shown.brilliant;
    shown.great = 0;
    shown.brilliant = 0;
  }
  return DISPLAY_ORDER.filter((label) => showExperimental || !LABEL_INFO[label].experimental).map((label) => ({ label, count: shown[label] }));
}

const SEVERITY_NAMES: Record<string, string> = {
  best: "Best",
  excellent: "Excellent",
  good: "Good",
  inaccuracy: "Inaccuracy",
  mistake: "Mistake",
  blunder: "Blunder",
};

/**
 * The machine-readable label reasons (core/classify) in plain wording, facts only (no coaching).
 * Reasons of hidden experimental labels are left out.
 */
export function reasonTexts(move: Pick<MoveAnalysis, "labelReasons" | "winLoss">, showExperimental: boolean): string[] {
  const texts: string[] = [];
  for (const reason of move.labelReasons) {
    const [kind = "", detail, extra] = reason.split(":");
    if (!showExperimental && (kind === "great" || kind === "brilliant")) continue;
    switch (kind) {
      case "missing":
        texts.push("No engine evaluation for this position or the next one (the analysis failed there), so the move is not graded.");
        break;
      case "pending":
        texts.push("Waiting for the engine to analyse this position.");
        break;
      case "forced":
        texts.push("The only legal move.");
        break;
      case "book":
        texts.push("A known opening position (Lichess opening names dataset).");
        break;
      case "band":
        texts.push(
          move.winLoss !== undefined
            ? `Winning chances lost: ${move.winLoss.toFixed(1)}% (${SEVERITY_NAMES[detail ?? ""] ?? detail} range).`
            : `${SEVERITY_NAMES[detail ?? ""] ?? detail} range.`,
        );
        break;
      case "engine":
        texts.push("The engine's top move.");
        break;
      case "mate":
        if (detail === "allowed") texts.push("Allowed a forced mate.");
        else if (detail === "lost") texts.push("A forced mate was available and is no longer.");
        else if (detail === "delayed") texts.push("Still mating, but more slowly.");
        else if (detail === "minimum") texts.push(`The mate rules make this at least ${SEVERITY_NAMES[extra ?? ""] ?? extra}.`);
        break;
      case "miss":
        texts.push("The opponent's previous move gave a clear chance, and it was not taken.");
        break;
      case "great":
        if (detail === undefined) texts.push("Great (experimental): the only move that keeps the evaluation.");
        else if (detail === "gap") texts.push(`The second-best move keeps ${extra}% less winning chance.`);
        break;
      case "brilliant":
        if (detail === undefined) texts.push("Brilliant (experimental): a sound sacrifice that is also the best move.");
        else if (detail === "sacrifice") texts.push(`Material offered on ${extra ?? "?"}, and the engine's line takes it.`);
        else if (detail === "mate-exception") texts.push("The engine's line leads to a forced mate.");
        break;
      default:
        texts.push(reason);
    }
  }
  return texts;
}

/** "62%" style Win% for display. */
export const formatWin = (win: number) => `${win.toFixed(0)}%`;

/** A player's summary is final only when no position is still waiting for the engine. */
export function hasFinalNumbers(summary: Pick<PlayerSummary, "accuracy">): boolean {
  return summary.accuracy !== undefined;
}

/** A SAN line with move numbers, starting from the position `fen`: "12... Nf6 13. e5 dxe5". */
export function numberedLine(fen: string, sans: readonly string[]): string {
  const fields = fen.trim().split(/\s+/);
  let color = fields[1] === "b" ? "b" : "w";
  let number = Number.parseInt(fields[5] ?? "1", 10) || 1;
  const parts: string[] = [];
  sans.forEach((san, i) => {
    if (color === "w") parts.push(`${number}. ${san}`);
    else parts.push(i === 0 ? `${number}... ${san}` : san);
    if (color === "b") number++;
    color = color === "w" ? "b" : "w";
  });
  return parts.join(" ");
}
