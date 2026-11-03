const CLK_PATTERN = /\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*\]/;

/** Seconds from a `[%clk h:mm:ss(.s)]` command inside a PGN comment, or undefined. */
export function parseClockComment(comment: string): number | undefined {
  const match = CLK_PATTERN.exec(comment);
  if (!match) return undefined;
  const [, h, m, s] = match;
  const minutes = Number(m);
  const seconds = Number(s);
  if (minutes >= 60 || seconds >= 60) return undefined;
  // Round away binary noise from the addition while keeping the written precision.
  return Math.round((Number(h) * 3600 + minutes * 60 + seconds) * 1000) / 1000;
}

/** Formats seconds as `h:mm:ss` with up to three decimals, dropping trailing zeros. */
export function formatClock(totalSeconds: number): string {
  const millis = Math.round(totalSeconds * 1000);
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const secondMillis = millis % 60_000;
  const whole = Math.floor(secondMillis / 1000);
  const fraction = secondMillis % 1000;
  let seconds = String(whole).padStart(2, "0");
  if (fraction > 0) seconds += `.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}
