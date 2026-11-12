import type { GameRecord } from "@/core/game/types";
import type { GameReview } from "@/core/review";
import { formatScore } from "@/ui/format";
import { displayLabel, formatWin, numberedLine, reasonTexts } from "@/ui/review/presentation";
import { LabelChip } from "./LabelChip";

/**
 * Facts about the current move (F4.5, Phase 3 scope B11): no explanations, only what the engine
 * data and the methodology say. Every SAN shown comes from UCI replayed legally (core/review).
 */
export function MovePanel({ game, review, ply, showExperimental }: { game: GameRecord; review: GameReview; ply: number; showExperimental: boolean }) {
  const fenAt = (k: number) => (k === 0 ? game.startFen : game.plies[k - 1]!.fenAfter);

  if (ply === 0) {
    const first = review.moves[0];
    return (
      <section aria-label="Move details" className="flex flex-col gap-2 text-sm" data-testid="move-panel">
        <h3 className="font-semibold">Start position</h3>
        {first?.scoreBefore ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">Evaluation</dt>
            <dd className="font-mono">{formatScore(first.scoreBefore)}</dd>
            {first.bestMove && (
              <>
                <dt className="text-muted">Best move</dt>
                <dd className="font-mono">{first.bestMove.san}</dd>
              </>
            )}
            {first.bestLineSan.length > 0 && (
              <>
                <dt className="text-muted">Best line</dt>
                <dd className="font-mono break-words">{numberedLine(fenAt(0), first.bestLineSan)}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="text-muted">No engine evaluation for this position yet.</p>
        )}
      </section>
    );
  }

  const move = review.moves[ply - 1];
  if (!move) return null;
  const label = displayLabel(move.label, showExperimental);
  const ply0 = game.plies[ply - 1]!;
  const heading = numberedLine(fenAt(ply - 1), [ply0.san]);
  const reasons = reasonTexts(move, showExperimental);
  const playedWasBest = move.bestMove?.uci === move.uci;

  return (
    <section aria-label="Move details" className="flex flex-col gap-2 text-sm" data-testid="move-panel">
      <h3 className="flex flex-wrap items-center gap-2 font-semibold">
        <span className="font-mono">{heading}</span>
        {label ? <LabelChip label={label} /> : <span className="text-muted">Not graded</span>}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {move.scoreBefore && move.scoreAfter && (
          <>
            <dt className="text-muted">Evaluation</dt>
            <dd className="font-mono">
              {formatScore(move.scoreBefore)} → {formatScore(move.scoreAfter)}
            </dd>
          </>
        )}
        {move.winBefore !== undefined && move.winAfter !== undefined && (
          <>
            <dt className="text-muted">Winning chances</dt>
            <dd>
              {formatWin(move.winBefore)} → {formatWin(move.winAfter)} for {move.color === "w" ? "White" : "Black"}
              {move.winLoss !== undefined && move.winLoss > 0 && <span className="text-muted"> (−{move.winLoss.toFixed(1)}%)</span>}
            </dd>
          </>
        )}
        {move.accuracy !== undefined && (
          <>
            <dt className="text-muted">Move accuracy</dt>
            <dd>{move.accuracy.toFixed(1)}</dd>
          </>
        )}
        {move.bestMove && (
          <>
            <dt className="text-muted">Best move</dt>
            <dd className="font-mono">
              {move.bestMove.san}
              {playedWasBest && <span className="font-sans text-muted"> (played)</span>}
            </dd>
          </>
        )}
        {move.bestLineSan.length > 0 && (
          <>
            <dt className="text-muted">Best line</dt>
            <dd className="font-mono break-words" data-testid="best-line">
              {numberedLine(fenAt(ply - 1), move.bestLineSan)}
            </dd>
          </>
        )}
        {move.refutationSan.length > 0 && (
          <>
            <dt className="text-muted">Engine reply</dt>
            <dd className="font-mono break-words" data-testid="refutation-line">
              {numberedLine(fenAt(ply), move.refutationSan)}
            </dd>
          </>
        )}
      </dl>
      {reasons.length > 0 && (
        <ul className="list-disc pl-5 text-muted" aria-label="Why this label">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
