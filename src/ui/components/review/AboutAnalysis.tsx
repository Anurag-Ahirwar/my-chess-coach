import { Link } from "react-router";
import type { RawAnalysis } from "@/core/engine/analysis";
import type { GameReview } from "@/core/review";
import { formatDateTime } from "@/ui/format";

/**
 * About this analysis (F8.3): what produced the numbers, and what they can and cannot be compared
 * with (methodology §0).
 */
export function AboutAnalysis({ raw, review }: { raw: RawAnalysis; review: GameReview }) {
  const { engine, settings } = raw;
  const date = raw.completedAt ?? raw.startedAt;
  return (
    <details className="text-sm" data-testid="about-analysis">
      <summary className="cursor-pointer font-medium">About this analysis</summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted">Engine</dt>
        <dd>
          Stockfish {engine.version} ({engine.flavour === "lite-single" ? "lite, single-threaded" : engine.flavour}
          {engine.nnue ? `, network ${engine.nnue}` : ""})
        </dd>
        <dt className="text-muted">Preset</dt>
        <dd>
          {settings.preset[0]!.toUpperCase() + settings.preset.slice(1)}: {settings.nodes.toLocaleString()} nodes per position, depth up to{" "}
          {settings.maxDepth}, {settings.multiPv} line{settings.multiPv === 1 ? "" : "s"}
        </dd>
        <dt className="text-muted">Analysed</dt>
        <dd>{date ? formatDateTime(date) : "Unknown"}</dd>
        <dt className="text-muted">Methodology</dt>
        <dd>Version {review.methodologyVersion}</dd>
      </dl>
      <div className="mt-3 flex flex-col gap-2 text-muted">
        <p>
          <strong className="text-text">Labels</strong> come from how much a move lowers the mover&apos;s winning chances (Win%), plus rules for
          forced mates, missed chances (Miss), book moves and forced moves. The thresholds are our own.
        </p>
        <p>
          <strong className="text-text">Accuracy</strong> uses Lichess&apos;s published formula and aggregation, which our tests reproduce from
          Lichess&apos;s own evaluations; the only difference is that forced moves are left out. Because the engine and its settings differ, the
          numbers will not match the Lichess website for the same game.
        </p>
        <p>
          <strong className="text-text">Not Chess.com.</strong> Chess.com&apos;s accuracy and labels are proprietary. Ours are neither a copy nor an
          approximation of them, and the two should not be compared.
        </p>
        <p>
          <strong className="text-text">Great and Brilliant</strong> are experimental and hidden unless you turn them on.
        </p>
        <p>
          <Link to="/about" className="text-accent underline">
            About / Licences
          </Link>
        </p>
      </div>
    </details>
  );
}
