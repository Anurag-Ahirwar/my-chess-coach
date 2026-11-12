import { openingIndexFromJson, type OpeningIndex, type OpeningIndexJson } from "@/core/openings";
import { buildOpeningIndex, readDataset } from "../../scripts/build-openings.mjs";

let cached: { json: OpeningIndexJson; index: OpeningIndex } | undefined;

/** The real opening index, built once per test file from the pinned dataset (as the build does). */
export function realOpeningIndex(): { json: OpeningIndexJson; index: OpeningIndex } {
  if (!cached) {
    const json = buildOpeningIndex(readDataset());
    cached = { json, index: openingIndexFromJson(json) };
  }
  return cached;
}
