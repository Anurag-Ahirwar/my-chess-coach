import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** Reads a fixture file as text, exactly as stored (no line-ending conversion). */
export function readFixture(...path: string[]): string {
  return readFileSync(join(FIXTURES, ...path), "utf8");
}

export function listFixtures(...dir: string[]): string[] {
  return readdirSync(join(FIXTURES, ...dir)).sort();
}

export function readJsonFixture<T = unknown>(...path: string[]): T {
  return JSON.parse(readFixture(...path)) as T;
}
