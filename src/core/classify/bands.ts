import type { MethodologyConfig } from "../methodology/v1";
import { SEVERITY_ORDER, type Severity } from "./types";

/** methodology §5.3: the severity band from the mover's Win% loss. */
export function bandFor(loss: number, playedIsBest: boolean, bands: MethodologyConfig["bands"]): Severity {
  if (!(loss >= 0)) throw new RangeError(`Win% loss must be ≥ 0, got ${loss}`);
  if (playedIsBest || loss <= bands.bestTolerance) return "best";
  if (loss < bands.excellent) return "excellent";
  if (loss < bands.good) return "good";
  if (loss < bands.inaccuracy) return "inaccuracy";
  if (loss < bands.mistake) return "mistake";
  return "blunder";
}

/** The worse of two severities (methodology §5.4: mate rules set a minimum). */
export function worse(a: Severity, b: Severity | undefined): Severity {
  if (b === undefined) return a;
  return SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a;
}

export function atLeast(severity: Severity, minimum: Severity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(minimum);
}
