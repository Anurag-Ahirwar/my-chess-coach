import { METHODOLOGY_V1 } from "@/core/methodology/v1";
import type { OpeningIndex } from "@/core/openings";
import { deriveReview } from "@/core/review";
import { loadOpeningIndex } from "../openings/load";
import type { DeriveRequest, DeriveResponse } from "./protocol";

/**
 * The review Worker (Phase 3 decision Q8): runs the pure core/review derivation off the main
 * thread. No chess logic lives here; it only loads the opening index once and calls
 * deriveReview with the app's methodology config. The client sends one request at a time.
 */

interface WorkerScope {
  onmessage: ((event: MessageEvent<DeriveRequest>) => void) | null;
  postMessage(message: DeriveResponse): void;
}
const scope = self as unknown as WorkerScope;

let index: Promise<OpeningIndex> | undefined;
const INDEX_URL = `${import.meta.env.BASE_URL}openings/index.json`;

async function handle(request: DeriveRequest): Promise<DeriveResponse> {
  const indexStart = performance.now();
  let openings: OpeningIndex;
  try {
    index ??= loadOpeningIndex(INDEX_URL, METHODOLOGY_V1.openings.commit);
    openings = await index;
  } catch (error) {
    index = undefined; // try again on the next request
    return { type: "error", id: request.id, kind: "index", message: error instanceof Error ? error.message : String(error) };
  }
  const indexMs = performance.now() - indexStart;
  try {
    const start = performance.now();
    const review = deriveReview({ game: request.game, raw: request.raw, index: openings, config: METHODOLOGY_V1 });
    return { type: "result", id: request.id, review, deriveMs: performance.now() - start, indexMs };
  } catch (error) {
    return { type: "error", id: request.id, kind: "derive", message: error instanceof Error ? error.message : String(error) };
  }
}

scope.onmessage = (event) => {
  void handle(event.data).then((response) => scope.postMessage(response));
};
