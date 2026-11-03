import { usePreferences, type ThemePreference } from "@/app/prefs";

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeSelect() {
  const theme = usePreferences((state) => state.theme);
  const update = usePreferences((state) => state.update);
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      Theme
      <select
        value={theme}
        onChange={(event) => update({ theme: event.target.value as ThemePreference })}
        className="rounded-md border border-border bg-surface px-2 py-1 text-text"
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
