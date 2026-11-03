import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type Route } from "@playwright/test";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

export function fixtureText(...path: string[]): string {
  return readFileSync(join(FIXTURES, ...path), "utf8");
}

export function fixtureJson<T>(...path: string[]): T {
  return JSON.parse(fixtureText(...path)) as T;
}

/**
 * Reads the pieces shown on the board and returns the FEN placement field,
 * so tests check what is actually rendered, not just the FEN text box.
 */
export async function renderedPlacement(page: Page): Promise<string> {
  return page.locator("#review-board-square-a8").evaluate(() => {
    const ranks: string[] = [];
    for (let rank = 8; rank >= 1; rank--) {
      let row = "";
      let empty = 0;
      for (const file of "abcdefgh") {
        const piece = document.querySelector(`[data-square="${file}${rank}"] [data-piece]`)?.getAttribute("data-piece");
        if (!piece) {
          empty++;
          continue;
        }
        if (empty) row += String(empty);
        empty = 0;
        const [color, type] = piece; // e.g. "wN"
        row += color === "w" ? type!.toUpperCase() : type!.toLowerCase();
      }
      ranks.push(empty ? row + String(empty) : row);
    }
    return ranks.join("/");
  });
}

/** Asserts that both the FEN box and the rendered pieces show the given position. */
export async function expectPosition(page: Page, fen: string): Promise<void> {
  await expect(page.getByTestId("current-fen")).toHaveValue(fen);
  await expect.poll(() => renderedPlacement(page), { timeout: 5000 }).toBe(fen.split(" ")[0]);
}

export async function pastePgn(page: Page, pgn: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("PGN text (one or more games)").fill(pgn);
  await page.getByRole("button", { name: "Load PGN" }).click();
}

export const API = "https://api.chess.com/pub/player";

export interface MockApiOptions {
  /** username → archive URLs (newest last, as Chess.com returns them). */
  archives?: Record<string, string[]>;
  /** "user/YYYY/MM" → games */
  months?: Record<string, unknown[]>;
  /** Overrides by URL suffix, e.g. { "nobody/games/archives": 404 } */
  status?: Record<string, number>;
  abort?: string[];
}

/** Serves a fake Chess.com API and records every request URL in order. */
export async function mockChessCom(page: Page, options: MockApiOptions): Promise<string[]> {
  const requests: string[] = [];
  await page.route(`${API}/**`, async (route: Route) => {
    const url = route.request().url();
    requests.push(url);
    const path = url.slice(API.length + 1);
    if (options.abort?.includes(path)) return route.abort("internetdisconnected");
    const status = options.status?.[path];
    if (status) return route.fulfill({ status, json: { code: 0, message: "mock" } });
    const archives = /^([^/]+)\/games\/archives$/.exec(path);
    if (archives) {
      const list = options.archives?.[archives[1]!];
      return list ? route.fulfill({ json: { archives: list } }) : route.fulfill({ status: 404, json: { code: 0 } });
    }
    const month = /^([^/]+)\/games\/(\d{4})\/(\d{2})$/.exec(path);
    if (month) {
      const games = options.months?.[`${month[1]}/${month[2]}/${month[3]}`];
      return games ? route.fulfill({ json: { games } }) : route.fulfill({ status: 404, json: { code: 0 } });
    }
    return route.fulfill({ status: 404, json: { code: 0 } });
  });
  return requests;
}

export const archiveUrl = (user: string, year: number, month: number) =>
  `${API}/${user}/games/${year}/${String(month).padStart(2, "0")}`;
