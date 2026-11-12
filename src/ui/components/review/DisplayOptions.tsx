import { usePreferences } from "@/app/prefs";

/** Display preferences for the review (saved with the other preferences). */
export function DisplayOptions() {
  const showExperimental = usePreferences((s) => s.showExperimentalLabels);
  const showChesscom = usePreferences((s) => s.showChesscomAccuracy);
  const update = usePreferences((s) => s.update);
  return (
    <fieldset className="flex flex-col gap-2 text-sm">
      <legend className="sr-only">Display options</legend>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={showExperimental}
          onChange={(e) => update({ showExperimentalLabels: e.target.checked })}
        />
        <span>
          Show experimental labels (Great, Brilliant)
          <span className="block text-xs text-muted">When off, these moves are shown as Best. Accuracy is the same either way.</span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={showChesscom} onChange={(e) => update({ showChesscomAccuracy: e.target.checked })} />
        <span>
          Show Chess.com&apos;s reported accuracy
          <span className="block text-xs text-muted">Only for games imported from Chess.com that have it; never mixed with ours.</span>
        </span>
      </label>
    </fieldset>
  );
}
