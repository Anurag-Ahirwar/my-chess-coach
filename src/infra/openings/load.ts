import { z } from "zod";
import { openingIndexFromJson, type OpeningIndex } from "@/core/openings";

/**
 * Loads the generated opening index (public/openings/index.json, built by the opening-index Vite
 * plugin from the pinned dataset). It is validated, and refused if it was built from a different
 * dataset commit than the methodology config names: Book labels must never come from an index the
 * methodology version doesn't describe.
 */

const IndexSchema = z.object({
  source: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  licence: z.string(),
  lines: z.number().int().positive(),
  positions: z.number().int().positive(),
  named: z.number().int().positive(),
  book: z.array(z.string()),
  names: z.record(z.string(), z.tuple([z.string(), z.string()])),
});

export class OpeningIndexError extends Error {
  override name = "OpeningIndexError";
}

export function parseOpeningIndex(json: unknown, expectedCommit: string): OpeningIndex {
  const parsed = IndexSchema.safeParse(json);
  if (!parsed.success) throw new OpeningIndexError(`The opening index is invalid: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  if (parsed.data.commit !== expectedCommit) {
    throw new OpeningIndexError(`The opening index was built from dataset commit ${parsed.data.commit}, not ${expectedCommit}.`);
  }
  return openingIndexFromJson(parsed.data);
}

export async function loadOpeningIndex(url: string, expectedCommit: string, fetchImpl: typeof fetch = fetch): Promise<OpeningIndex> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new OpeningIndexError(`The opening index could not be loaded (HTTP ${response.status}).`);
  return parseOpeningIndex(await response.json(), expectedCommit);
}
