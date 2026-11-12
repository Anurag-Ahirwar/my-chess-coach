import { useEffect, useId } from "react";
import { useAnalysis, type AnalysisViewStatus } from "@/app/analysis/analysisStore";
import { resolvePoolSize } from "@/app/analysis/engine";
import { usePreferences, type WorkerCountPreference } from "@/app/prefs";
import type { PresetName } from "@/core/engine/types";
import type { GameRecord } from "@/core/game/types";
import { Button, Card } from "../primitives";

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

/**
 * Analysis controls (Phase 3 decision Q4): analysis starts with a button; the preset is remembered
 * (default Standard). A saved analysis is shown without engine work, and a partial one resumes
 * only the missing positions (Phase 2 analysis store).
 */
export function AnalysisControls({ game }: { game: GameRecord }) {
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
    <Card title="Analysis">
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
        {failedCount > 0 && !running && (
          <p className="text-muted">Analysing again retries only the positions that failed.</p>
        )}
        {current?.error && (
          <p className="text-danger" role="alert">
            {current.error}
          </p>
        )}
      </div>
    </Card>
  );
}
