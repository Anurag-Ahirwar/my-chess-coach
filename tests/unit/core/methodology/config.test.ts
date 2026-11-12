import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LICHESS_ACCURACY_V1, METHODOLOGY_V1, configHash, withConfig } from "@/core/methodology/v1";

const doc = readFileSync(new URL("../../../../docs/CHESS_ANALYSIS_METHODOLOGY.md", import.meta.url), "utf8");

describe("methodology config (testing §6.4: the document matches the code)", () => {
  it("is version 1.0.0, frozen, and its version is in the changelog", () => {
    expect(METHODOLOGY_V1.version).toBe("1.0.0");
    expect(Object.isFrozen(METHODOLOGY_V1)).toBe(true);
    expect(Object.isFrozen(METHODOLOGY_V1.bands)).toBe(true);
    expect(Object.isFrozen(LICHESS_ACCURACY_V1)).toBe(true);
    expect(doc).toContain(`version: "${METHODOLOGY_V1.version}"`);
    expect(doc).toMatch(new RegExp(`## METHODOLOGY_CHANGELOG[\\s\\S]*- ${METHODOLOGY_V1.version.replace(/\./g, "\\.")} `));
  });

  it("quotes every constant exactly as the code has it (§5.10)", () => {
    const l = LICHESS_ACCURACY_V1;
    expect(doc).toContain(`winPercentK: ${l.winPercentK}, cpCeiling: ${l.cpCeiling},`);
    expect(doc).toContain(`accA: ${l.accA}, accK: ${l.accK}, accB: ${l.accB}, uncertaintyBonus: ${l.uncertaintyBonus},`);
    expect(doc).toContain(
      `windowDivisor: ${l.windowDivisor}, windowMin: ${l.windowMin}, windowMax: ${l.windowMax}, weightMin: ${l.weightMin}, weightMax: ${l.weightMax},`,
    );
    expect(doc).toContain(`harmonicFloor: ${l.harmonicFloor}, legacyInitialCp: ${l.legacyInitialCp},`);
    const m = METHODOLOGY_V1;
    const b = m.bands;
    expect(doc).toContain(`bands: { bestTolerance: ${b.bestTolerance}, excellent: ${b.excellent}, good: ${b.good}, inaccuracy: ${b.inaccuracy}, mistake: ${b.mistake} }`);
    expect(doc).toContain(`mate: { inaccuracyAtCp: ${m.mate.inaccuracyAtCp}, mistakeBeyondCp: ${m.mate.mistakeBeyondCp} }`);
    expect(doc).toContain(`miss: { opportunityGain: ${m.miss.opportunityGain}, minWinBefore: ${m.miss.minWinBefore}, minSeverity: "${m.miss.minSeverity}" }`);
    expect(doc).toContain(`great: { minGap: ${m.great.minGap}, minWb: ${m.great.minWb}, maxWb: ${m.great.maxWb}, enabled: ${m.great.enabled} }`);
    const br = m.brilliant;
    expect(doc).toContain(
      `brilliant: { minSacrifice: ${br.minSacrifice}, minPersistPlies: ${br.minPersistPlies}, minWa: ${br.minWa}, maxWb: ${br.maxWb}, bestWithin: ${br.bestWithin.toFixed(1)}, enabled: ${br.enabled} }`,
    );
    const mat = m.material;
    expect(doc).toContain(`material: { p: ${mat.p}, n: ${mat.n}, b: ${mat.b}, r: ${mat.r}, q: ${mat.q} }`);
    const p = m.phases;
    expect(doc).toContain(
      `phases: { minMovesForPhaseAccuracy: ${p.minMovesForPhaseAccuracy}, openingMaxPieces: ${p.openingMaxPieces}, backRankSparse: ${p.backRankSparse}, bookGuardMoves: ${p.bookGuardMoves}, endgameMaxPieces: ${p.endgameMaxPieces} }`,
    );
    expect(doc).toContain(`openings: { source: "${m.openings.source}", commit: "${m.openings.commit}" }`);
    expect(doc).toContain(m.openings.commit); // also quoted in §5.8
  });

  it("has a stable fingerprint that changes with any value, including the flags", () => {
    const hash = configHash(METHODOLOGY_V1);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(configHash(withConfig(METHODOLOGY_V1, {}))).toBe(hash);
    expect(configHash(withConfig(METHODOLOGY_V1, { brilliant: { enabled: false } }))).not.toBe(hash);
    expect(configHash(withConfig(METHODOLOGY_V1, { great: { enabled: false } }))).not.toBe(hash);
    expect(configHash(withConfig(METHODOLOGY_V1, { accuracyMode: "lichessCompat" }))).not.toBe(hash);
    expect(configHash(withConfig(METHODOLOGY_V1, { bands: { mistake: 15 } }))).not.toBe(hash);
  });

  it("withConfig returns a frozen copy and leaves the original alone", () => {
    const changed = withConfig(METHODOLOGY_V1, { bands: { mistake: 15 } });
    expect(changed.bands.mistake).toBe(15);
    expect(METHODOLOGY_V1.bands.mistake).toBe(20);
    expect(Object.isFrozen(changed.bands)).toBe(true);
  });
});
