import { expect, test, type Page } from "@playwright/test";
import { fixtureText, pastePgn } from "./helpers";

/**
 * Imports with slow, stalled or failing browser storage (found by Firefox/Windows in CI, run
 * 45457517299: an import waited over 5 s for its save with no message). The wait is capped at 3 s;
 * the review then opens and says the game is still being saved.
 */
const PGN = fixtureText("pgn", "chesscom", "23-daily.pgn");
const notice = (page: Page) => page.getByTestId("saving-notice");
const moves = (page: Page) => page.getByRole("navigation", { name: "Moves" });

/** Delays every answer to indexedDB.open (the first argument, ms), or never answers when null. */
function delayStorage(delay: number | null) {
  const real = Object.getOwnPropertyDescriptor(IDBFactory.prototype, "open")!.value as IDBFactory["open"];
  IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory["open"]>) {
    const request = real.apply(this, args);
    let handler: ((event: Event) => void) | null = null;
    Object.defineProperty(request, "onsuccess", {
      get: () => handler,
      set(next: (event: Event) => void) {
        handler = next;
        if (delay !== null) request.addEventListener("success", (event) => setTimeout(() => next.call(request, event), delay));
      },
    });
    return request;
  };
}

test("slow storage: the review opens after the cap, says it is saving, and the game ends up saved", async ({ page }) => {
  await page.addInitScript(delayStorage, 9000);
  await pastePgn(page, PGN);
  await expect(moves(page)).toBeVisible({ timeout: 8000 });
  await expect(notice(page)).toContainText("Still saving this game");
  await page.getByRole("link", { name: "Chess Coach" }).click();
  await expect(page.getByText("Still saving…")).toBeVisible();
  await expect(page.getByText("Saved in this browser.")).toHaveCount(0);
  await expect(page.getByText("Saved in this browser.")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("list", { name: "Your games" }).getByRole("link").click();
  await expect(notice(page)).toHaveCount(0);
  await page.reload(); // the saved copy is really there (storage is slow again, so allow time)
  await expect(moves(page)).toBeVisible({ timeout: 20_000 });
});

test("storage that never answers doesn't block the import, and the page never claims the game is saved", async ({ page }) => {
  await page.addInitScript(delayStorage, null);
  await pastePgn(page, PGN);
  await expect(moves(page)).toBeVisible({ timeout: 8000 });
  await expect(notice(page)).toContainText("Still saving this game");
  await page.getByRole("button", { name: "Next move" }).click();
  await page.getByRole("link", { name: "Chess Coach" }).click();
  await expect(page.getByText("Still saving…")).toBeVisible();
  await expect(page.getByText("Saved in this browser.")).toHaveCount(0);
});

test("a save that fails is reported, and the page never claims the game is saved", async ({ page }) => {
  await page.addInitScript(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  await pastePgn(page, PGN);
  await expect(moves(page)).toBeVisible();
  await expect(notice(page)).toContainText("couldn't be saved");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("link", { name: "Chess Coach" }).click();
  await expect(page.getByText("couldn't be saved and may be gone")).toBeVisible();
  await expect(page.getByText("Saved in this browser.")).toHaveCount(0);
});

test("a normal import shows no saving notice, and a reload the moment the review opens can't lose the game", async ({ page }) => {
  await pastePgn(page, PGN);
  await page.waitForURL(/\/review\//);
  await page.reload();
  await expect(moves(page)).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByRole("list", { name: "Your games" }).getByRole("link")).toHaveCount(1);
  await expect(page.getByText("Saved in this browser.")).toBeVisible();
});
