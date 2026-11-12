/**
 * The single source of every methodology constant (docs/CHESS_ANALYSIS_METHODOLOGY.md §5.10).
 * The code reads these objects; the document quotes them. Changing any value bumps
 * `METHODOLOGY_V1.version` (semver, methodology §9) and needs a changelog entry.
 */

/** Frozen: changing any value breaks the Lichess compatibility claim (methodology §0). */
export const LICHESS_ACCURACY_V1 = Object.freeze({
  winPercentK: 0.00368208,
  cpCeiling: 1000,
  accA: 103.1668100711649,
  accK: 0.04354415386753951,
  accB: -3.166924740191411,
  uncertaintyBonus: 1,
  windowDivisor: 10,
  windowMin: 2,
  windowMax: 8,
  weightMin: 0.5,
  weightMax: 12,
  harmonicFloor: 1,
  legacyInitialCp: 15,
} as const);

export type AccuracyMode = "default" | "lichessCompat";

export interface MethodologyConfig {
  readonly version: string;
  readonly accuracyMode: AccuracyMode;
  readonly bands: { readonly bestTolerance: number; readonly excellent: number; readonly good: number; readonly inaccuracy: number; readonly mistake: number };
  readonly mate: { readonly inaccuracyAtCp: number; readonly mistakeBeyondCp: number };
  readonly miss: { readonly opportunityGain: number; readonly minWinBefore: number; readonly minSeverity: "mistake" };
  readonly great: { readonly minGap: number; readonly minWb: number; readonly maxWb: number; readonly enabled: boolean };
  readonly brilliant: {
    readonly minSacrifice: number;
    readonly minPersistPlies: number;
    readonly minWa: number;
    readonly maxWb: number;
    readonly bestWithin: number;
    readonly enabled: boolean;
  };
  readonly material: { readonly p: number; readonly n: number; readonly b: number; readonly r: number; readonly q: number };
  readonly phases: {
    readonly minMovesForPhaseAccuracy: number;
    readonly openingMaxPieces: number;
    readonly backRankSparse: number;
    readonly bookGuardMoves: number;
    readonly endgameMaxPieces: number;
  };
  readonly openings: { readonly source: string; readonly commit: string };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const METHODOLOGY_V1: MethodologyConfig = deepFreeze({
  version: "1.0.0",
  accuracyMode: "default",
  bands: { bestTolerance: 0.5, excellent: 2, good: 5, inaccuracy: 10, mistake: 20 },
  mate: { inaccuracyAtCp: 1000, mistakeBeyondCp: 700 },
  miss: { opportunityGain: 10, minWinBefore: 60, minSeverity: "mistake" },
  great: { minGap: 10, minWb: 5, maxWb: 95, enabled: true },
  brilliant: { minSacrifice: 2, minPersistPlies: 4, minWa: 50, maxWb: 90, bestWithin: 1.0, enabled: true },
  material: { p: 1, n: 3, b: 3, r: 5, q: 9 },
  phases: { minMovesForPhaseAccuracy: 6, openingMaxPieces: 10, backRankSparse: 4, bookGuardMoves: 12, endgameMaxPieces: 6 },
  openings: { source: "lichess-org/chess-openings", commit: "3ba6b20d31b2e6125cb0e6a2e792f400717d9d39" },
});

/** A config with some values replaced (tests, lichessCompat mode). The result is frozen too. */
export function withConfig(base: MethodologyConfig, patch: {
  accuracyMode?: AccuracyMode;
  great?: Partial<MethodologyConfig["great"]>;
  brilliant?: Partial<MethodologyConfig["brilliant"]>;
  bands?: Partial<MethodologyConfig["bands"]>;
}): MethodologyConfig {
  return deepFreeze({
    ...base,
    accuracyMode: patch.accuracyMode ?? base.accuracyMode,
    bands: { ...base.bands, ...patch.bands },
    great: { ...base.great, ...patch.great },
    brilliant: { ...base.brilliant, ...patch.brilliant },
  });
}

/** JSON with object keys sorted, so equal configs always serialise identically. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** FNV-1a (32-bit) with a seed; two seeds give a 16-hex-digit fingerprint. Not cryptographic. */
function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Fingerprint of the whole methodology config, including the Lichess constants, the
 * experimental flags and the opening dataset commit. Stored with cached reviews: a mismatch
 * means the review is derived again (docs/DATA_MODELS.md §11).
 */
export function configHash(config: MethodologyConfig): string {
  const text = canonicalJson({ config, lichess: LICHESS_ACCURACY_V1 });
  return fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x01234567);
}
