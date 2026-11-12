import { useEffect, useId } from "react";
import { useAnalysis, type AnalysisViewStatus } from "@/app/analysis/analysisStore";
import { resolvePoolSize } from "@/app/analysis/engine";
import { usePreferences, type WorkerCountPreference } from "@/app/prefs";
import { startReviewSync, useReview } from "@/app/review/reviewStore";
import { replayUciLine } from "@/core/chess/position";
import type { PositionResult } from "@/core/engine/analysis";
import type { PresetName } from "@/core/engine/types";
import type { GameRecord } from "@/core/game/types";
import { formatScore } from "@/ui/format";
import { Button, Card } from "../primitives";

/**
 * TEMPORARY Phase 2 debug view (docs/DEVELOPMENT_ROADMAP.md Phase 2): raw engine output per
 * position. The eval bar, graph, labels and accuracy replace it in Phase 3.
 */

const PRESET_LABELS: Record<PresetName, string> = { quick: "Quick", standard: "Standard", deep: "Deep" };
const STATUS_LABELS: Record<AnalysisViewStatus, string> = {
  none: "Not analysed",
  saved: "Saved",
  pending: "Starting…",
  running: "Running",
  completed: "Completed",
  incomplete: "Finished with failed positions",
  cancelled: "Stopped",
  failed: "Failed",
};

export interface AnalysisDebugPanelProps {
  game: GameRecord;
  /** Current position index (0 = start). */
  ply: number;
  onSelect: (ply: number) => void;
}

export function AnalysisDebugPanel({ game, ply, onSelect }: AnalysisDebugPanelProps) {
  const presetId = useId();
  const enginesId = useId();
  const preset = usePreferences((state) => state.analysisPreset);
  const workerCount = usePreferences((state) => state.workerCount);
  const updatePrefs = usePreferences((state) => state.update);
  const view = useAnalysis((state) => state.view);
  const show = useAnalysis((state) => state.show);
  const start = useAnalysis((state) => state.start);
  const stop = useAnalysis((state) => state.stop);

  const current = view && view.gameId === game.id && view.preset === preset ? view : undefined;
  const running = current?.status === "running" || current?.status === "pending";
  const analysis = current?.analysis;
  const total = analysis?.totalCount ?? game.plies.length + 1;
  const done = analysis?.completedCount ?? 0;
  const failedCount = analysis?.positions.filter((p) => p?.status === "failed").length ?? 0;

  useEffect(() => {
    void show(game, preset);
  }, [game, preset, show]);

  const startLabel = analysis && done > 0 && done < total ? "Resume analysis" : "Analyse game";

  return (
    <Card title="Engine analysis (debug view)">
      <p className="mb-3 text-xs text-muted">
        Temporary view of raw engine output (White&apos;s perspective). Move labels and accuracy arrive in Phase 3.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={presetId} className="flex flex-col gap-1 text-sm text-muted">
          Preset
          <select
            id={presetId}
            value={preset}
            disabled={running}
            onChange={(event) => updatePrefs({ analysisPreset: event.target.value as PresetName })}
            className="rounded-md border border-border bg-surface px-2 py-1 text-text"
          >
            {(Object.keys(PRESET_LABELS) as PresetName[]).map((name) => (
              <option key={name} value={name}>
                {PRESET_LABELS[name]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={enginesId} className="flex flex-col gap-1 text-sm text-muted">
          Engines
          <select
            id={enginesId}
            value={String(workerCount)}
            disabled={running}
            onChange={(event) => {
              const value = event.target.value;
              updatePrefs({ workerCount: value === "auto" ? "auto" : (Number(value) as WorkerCountPreference) });
            }}
            className="rounded-md border border-border bg-surface px-2 py-1 text-text"
          >
            <option value="auto">Auto ({resolvePoolSize("auto")})</option>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {running ? (
          <Button onClick={() => void stop()}>Stop</Button>
        ) : (
          <Button variant="primary" onClick={() => void start(game, preset)}>
            {startLabel}
          </Button>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-1 text-sm" aria-live="polite">
        <p>
          <span className="font-medium" data-testid="analysis-status">
            {STATUS_LABELS[current?.status ?? "none"]}
          </span>
          <span className="text-muted" data-testid="analysis-progress">
            {" "}
            · {done} / {total} positions
          </span>
          {failedCount > 0 && <span className="text-danger"> · {failedCount} failed</span>}
        </p>
        <progress className="h-2 w-full" max={total} value={done} aria-label="Analysis progress" />
        {current?.reused && <p className="text-muted">Showing the saved analysis — no engine work was needed.</p>}
        {current?.status === "saved" && done < total && <p className="text-muted">A partial analysis is saved; resuming analyses only the missing positions.</p>}
        {current?.error && (
          <p className="text-danger" role="alert">
            {current.error}
          </p>
        )}
      </div>

      <ReviewStatus />
      <CurrentPosition game={game} ply={ply} result={analysis?.positions[ply] ?? null} />
      <EvalList game={game} ply={ply} positions={analysis?.positions ?? []} onSelect={onSelect} />
    </Card>
  );
}

/**
 * TEMPORARY (Phase 3 Stage 2, Milestone 2): the review derived in the Worker, as data only, so it
 * can be checked before the review UI exists (Milestone 3).
 */
function ReviewStatus() {
  const { status, review, source, timings, error } = useReview();
  useEffect(() => startReviewSync(), []);
  const graded = review?.moves.filter((m) => m.graded).length ?? 0;
  return (
    <p
      className="mt-2 text-sm text-muted"
      data-testid="review-status"
      data-status={status}
      data-source={source ?? ""}
      data-complete={review ? String(review.coverage.complete) : ""}
      data-total-ms={timings ? timings.totalMs.toFixed(1) : ""}
      data-derive-ms={timings?.deriveMs !== undefined ? timings.deriveMs.toFixed(1) : ""}
      data-index-ms={timings?.indexMs !== undefined ? timings.indexMs.toFixed(1) : ""}
      data-round-trip-ms={timings?.roundTripMs !== undefined ? timings.roundTripMs.toFixed(1) : ""}
    >
      Review: {status}
      {review && ` · ${graded} of ${review.moves.length} moves labelled · ${review.coverage.complete ? "complete" : "partial"} · ${source === "cache" ? "from the cache" : "derived"}`}
      {error && ` · ${error}`}
    </p>
  );
}

function CurrentPosition({ game, ply, result }: { game: GameRecord; ply: number; result: PositionResult | null }) {
  const fen = ply === 0 ? game.startFen : game.plies[ply - 1]!.fenAfter;
  return (
    <section className="mt-4 border-t border-border pt-3 text-sm" aria-label="Engine output for this position" data-testid="current-eval">
      {result === null && <p className="text-muted">This position hasn&apos;t been analysed yet.</p>}
      {result?.status === "failed" && <p className="text-danger">Analysis failed: {result.error}</p>}
      {result?.status === "terminal" && (
        <p>
          Game over by the rules: <span className="font-mono">{formatScore(result.terminal)}</span> (not sent to the engine)
        </p>
      )}
      {result?.status === "done" && (
        <div className="flex flex-col gap-2">
          <p>
            Best move <span className="font-mono">{sanLine(fen, [result.bestMove])[0] ?? result.bestMove}</span> · {result.timeMs} ms
          </p>
          {result.lines.map((line) => (
            <div key={line.rank} className="rounded-md bg-surface-2 px-2 py-1">
              <p>
                <span className="font-mono font-semibold" data-testid={`line-${line.rank}-score`}>
                  {formatScore(line.score)}
                </span>
                <span className="text-muted">
                  {" "}
                  · line {line.rank} · depth {line.depth} · {line.nodes.toLocaleString()} nodes
                  {line.wdl && ` · WDL ${line.wdl.join("/")}`}
                </span>
              </p>
              <p className="break-words font-mono text-xs">{sanLine(fen, line.pv).join(" ")}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function sanLine(fen: string, pv: readonly string[]): string[] {
  return replayUciLine(fen, pv.slice(0, 12)).moves.map((move) => move.san);
}

function EvalList({ game, ply, positions, onSelect }: { game: GameRecord; ply: number; positions: (PositionResult | null)[]; onSelect: (ply: number) => void }) {
  const rows = Array.from({ length: game.plies.length + 1 }, (_, index) => index);
  return (
    <details className="mt-4 border-t border-border pt-3 text-sm" open>
      <summary className="cursor-pointer text-muted">Raw evaluation per position</summary>
      <ol className="mt-2 max-h-64 overflow-y-auto" aria-label="Raw evaluation per position">
        {rows.map((index) => {
          const result = positions[index] ?? null;
          const move = index === 0 ? "Start" : `${moveNumber(game, index)} ${game.plies[index - 1]!.san}`;
          const value =
            result === null ? "—" : result.status === "done" ? formatScore(result.lines[0]!.score) : result.status === "terminal" ? formatScore(result.terminal) : "failed";
          return (
            <li key={index}>
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-current={index === ply ? "true" : undefined}
                className={`flex w-full justify-between rounded px-2 py-0.5 text-left font-mono text-xs ${index === ply ? "bg-accent text-accent-contrast" : "hover:bg-surface-2"}`}
              >
                <span>{move}</span>
                <span data-testid={`eval-${index}`}>{value}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function moveNumber(game: GameRecord, positionIndex: number): string {
  const ply = game.plies[positionIndex - 1]!;
  const fullmove = Number(game.plies[positionIndex - 1]!.fenAfter.split(" ")[5]);
  // fenAfter's full-move number has already advanced after a Black move.
  return ply.color === "w" ? `${fullmove}.` : `${fullmove - 1}...`;
}
