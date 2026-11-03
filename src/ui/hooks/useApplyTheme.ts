import { useEffect } from "react";
import { usePreferences } from "@/app/prefs";

/** Sets <html data-theme> to "light" or "dark", following the system setting when the preference is "system". */
export function useApplyTheme(): void {
  const theme = usePreferences((state) => state.theme);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.dataset["theme"] = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}
