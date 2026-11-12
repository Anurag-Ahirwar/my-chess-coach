import { memo } from "react";
import type { Phase } from "@/core/accuracy";
import type { GameRecord } from "@/core/game/types";
import type { GameReview, PlayerSummary } from "@/core/review";
import { displayCounts, formatWin, numberedLine } from "@/ui/review/presentation";
import { LabelChip } from "./LabelChip";

const PHASE_NAMES: Record<Phase, string> = { opening: "Opening", middlegame: "Middlegame", endgame: "Endgame" };

/**
 * Game summary (F4.2, F4.3, F4.6, F4.7). Final numbers only for a review whose analysis has no
 * position left to analyse (core/review leaves them out otherwise); counts follow the experimental
 * label display preference, accuracy never does.
 */
export const GameSummary = memo(function GameSummary({
  game,
  review,
  showExperimental,
  showChesscom,
  onSelect,
}: {
  game: GameRecord;
  review: GameReview;
  showExperimental: boolean;
  showChesscom: boolean;
  onSelect: (ply: number) => void;
}) {
  const { coverage } = review;
  const players: [string, PlayerSummary][] = [
    ["White", review.white],
    ["Black", review.black],
  ];
  const opening = review.opening;
  const reported = game.source.kind === "chesscom" ? game.source.reportedAccuracy : undefined;

  if (coverage.pending > 0) {
    return (
      <div className="flex flex-col gap-2 text-sm" data-testid="game-summary" data-final="false">
        <p>
          Analysis in progress: {coverage.analysed} of {coverage.total} positions.
        </p>
        <p className="text-muted">Accuracy, ACPL and the label counts appear when every position has been analysed. Moves already analysed are labelled.</p>
      </div>
    );
  }

  const tp = review.turningPoint;
  const tpBefore = tp !== undefined ? review.winSeries[tp - 1] : undefined;
  const tpAfter = tp !== undefined ? review.winSeries[tp] : undefined;
  const fenAt = (k: number) => (k === 0 ? game.startFen : game.plies[k - 1]!.fenAfter);

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="game-summary" data-final="true">
      <div>
        <table className="w-full border-collapse" aria-label="Accuracy">
          <thead>
            <tr className="text-left text-muted">
              <th scope="col" className="py-1 font-medium">
                Player
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Accuracy
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                ACPL
              </th>
            </tr>
          </thead>
          <tbody>
            {players.map(([name, p]) => (
              <tr key={name} className="border-t border-border">
                <th scope="row" className="py-1 text-left font-medium">
                  {name}
                </th>
                <td className="py-1 text-right font-mono text-base font-semibold" data-testid={`accuracy-${name.toLowerCase()}`}>
                  {p.accuracy !== undefined ? p.accuracy.toFixed(1) : "—"}
                </td>
                <td className="py-1 text-right font-mono" data-testid={`acpl-${name.toLowerCase()}`}>
                  {p.acpl ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-xs text-muted">
          Our accuracy: the Lichess-compatible formula, with Forced moves left out
          {review.accuracyMode === "default" ? "" : " (Lichess-compatible mode)"}. It is not Chess.com&apos;s accuracy.
        </p>
        {players.some(([, p]) => p.excludedMissingWeight > 0) && (
          <p className="mt-1 text-xs" data-testid="not-included">
            {players
              .filter(([, p]) => p.excludedMissingWeight > 0)
              .map(([name, p]) => `${name}: ${p.excludedMissingWeight} move${p.excludedMissingWeight === 1 ? "" : "s"}`)
              .join(", ")}{" "}
            not included in accuracy (analysis unavailable).
          </p>
        )}
        {showChesscom && reported && (
          <p className="mt-1 text-xs" data-testid="chesscom-accuracy">
            Reported by Chess.com (a different, proprietary method; not comparable with ours): White {reported.white.toFixed(1)} · Black{" "}
            {reported.black.toFixed(1)}
          </p>
        )}
      </div>

      {players.some(([, p]) => Object.keys(p.accuracyByPhase).length > 0) && (
        <table className="w-full border-collapse" aria-label="Accuracy by phase">
          <thead>
            <tr className="text-left text-muted">
              <th scope="col" className="py-1 font-medium">
                Phase
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                White
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Black
              </th>
            </tr>
          </thead>
          <tbody>
            {(["opening", "middlegame", "endgame"] as const).map((phase) => {
              const w = review.white.accuracyByPhase[phase];
              const b = review.black.accuracyByPhase[phase];
              if (w === undefined && b === undefined) return null;
              return (
                <tr key={phase} className="border-t border-border">
                  <th scope="row" className="py-1 text-left font-medium">
                    {PHASE_NAMES[phase]}
                  </th>
                  <td className="py-1 text-right font-mono">{w?.toFixed(1) ?? "—"}</td>
                  <td className="py-1 text-right font-mono">{b?.toFixed(1) ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <table className="w-full border-collapse" aria-label="Move labels" data-testid="label-counts">
        <thead>
          <tr className="text-left text-muted">
            <th scope="col" className="py-1 font-medium">
              Label
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              White
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Black
            </th>
          </tr>
        </thead>
        <tbody>
          {(() => {
            const w = displayCounts(review.white.labelCounts, showExperimental);
            const b = displayCounts(review.black.labelCounts, showExperimental);
            return w.map(({ label, count }, i) => (
              <tr key={label} className="border-t border-border" data-testid={`count-${label}`}>
                <th scope="row" className="py-1 text-left font-normal">
                  <LabelChip label={label} />
                </th>
                <td className="py-1 text-right font-mono">{count}</td>
                <td className="py-1 text-right font-mono">{b[i]!.count}</td>
              </tr>
            ));
          })()}
        </tbody>
      </table>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted">Opening</dt>
        <dd data-testid="opening">{opening ? `${opening.eco} ${opening.name}` : "Not in the opening book"}</dd>
        {tp !== undefined && tpBefore !== undefined && tpBefore !== null && tpAfter !== undefined && tpAfter !== null && (
          <>
            <dt className="text-muted">Turning point</dt>
            <dd data-testid="turning-point">
              <button type="button" className="text-accent underline" onClick={() => onSelect(tp)}>
                {numberedLine(fenAt(tp - 1), [game.plies[tp - 1]!.san])}
              </button>{" "}
              — White&apos;s winning chances {formatWin(tpBefore)} → {formatWin(tpAfter)} (swing {Math.abs(tpAfter - tpBefore).toFixed(1)}%)
            </dd>
          </>
        )}
      </dl>
    </div>
  );
});
