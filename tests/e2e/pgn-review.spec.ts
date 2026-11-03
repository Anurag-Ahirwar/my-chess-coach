import { expect, test } from "@playwright/test";
import { parsePgn } from "../../src/core/pgn";
import { expectPosition, fixtureText, pastePgn, renderedPlacement } from "./helpers";

const STANDARD_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

test.describe("PGN import and move navigation", () => {
  for (const file of ["01-blitz.pgn", "15-rapid.pgn", "20-daily.pgn"]) {
    test(`every ply of ${file} shows the correct position (keyboard)`, async ({ page }) => {
      const pgn = fixtureText("pgn", "chesscom", file);
      const game = parsePgn(pgn).games[0]!;
      await pastePgn(page, pgn);
      await expect(page).toHaveURL(/\/review\/pgn%3A/);
      await expectPosition(page, game.startFen);

      // Move focus to the page body so arrow keys reach the move handler.
      await page.getByRole("heading", { level: 1 }).click();
      for (const ply of game.plies) {
        await page.keyboard.press("ArrowRight");
        await expect(page.getByTestId("current-fen")).toHaveValue(ply.fenAfter);
      }
      await expectPosition(page, game.plies.at(-1)!.fenAfter);

      await page.keyboard.press("Home");
      await expectPosition(page, game.startFen);
      await page.keyboard.press("End");
      await expectPosition(page, game.plies.at(-1)!.fenAfter);
      await page.keyboard.press("ArrowLeft");
      await expectPosition(page, game.plies.at(-2)!.fenAfter);
    });
  }

  test("clicking moves and buttons shows the matching position", async ({ page }) => {
    const pgn = fixtureText("pgn", "chesscom", "06-blitz.pgn");
    const game = parsePgn(pgn).games[0]!;
    await pastePgn(page, pgn);

    const moves = page.getByRole("navigation", { name: "Moves" });
    for (const index of [1, 2, 7, game.plies.length]) {
      const ply = game.plies[index - 1]!;
      await moves.getByRole("button", { name: `${ply.color === "w" ? "White" : "Black"}: ${ply.san}`, exact: true }).nth(0).click();
      await expect(page.getByTestId("current-fen")).toHaveValue(game.plies[index - 1]!.fenAfter);
    }
    await expectPosition(page, game.plies.at(-1)!.fenAfter);

    await page.getByRole("button", { name: "First position" }).click();
    await expectPosition(page, game.startFen);
    await expect(page.getByRole("button", { name: "Previous move" })).toBeDisabled();
    await page.getByRole("button", { name: "Next move" }).click();
    await expectPosition(page, game.plies[0]!.fenAfter);
    await page.getByRole("button", { name: "Last position" }).click();
    await expect(page.getByRole("button", { name: "Next move" })).toBeDisabled();
    await moves.getByRole("button", { name: "Start position" }).click();
    await expectPosition(page, game.startFen);
  });

  test("arrow keys do nothing while typing in a form field", async ({ page }) => {
    await pastePgn(page, "1. e4 e5 2. Nf3 *");
    await page.getByTestId("current-fen").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("current-fen")).toHaveValue(STANDARD_START);
  });

  test("a custom start with Black to move numbers moves correctly", async ({ page }) => {
    await pastePgn(page, fixtureText("pgn", "rules", "black-to-move-start.pgn"));
    const moves = page.getByRole("navigation", { name: "Moves" });
    await expect(moves.getByRole("listitem").first()).toContainText("1.…e5");
    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Position after 1... e5")).toBeAttached();
  });

  test("flip board swaps orientation", async ({ page }) => {
    await pastePgn(page, "1. e4 *");
    const firstSquare = () => page.locator("[data-square]").first().getAttribute("data-square");
    expect(await firstSquare()).toBe("a8");
    await page.getByRole("button", { name: "Flip board" }).click();
    await expect.poll(firstSquare).toBe("h1");
    expect(await renderedPlacement(page)).toBe(STANDARD_START.split(" ")[0]);
  });

  test("a multi-game PGN lists the games and reports the broken one", async ({ page }) => {
    await pastePgn(page, fixtureText("pgn", "edge-cases", "multi-game-with-annotations.pgn"));
    await expect(page.getByRole("alert")).toContainText("1 game could not be read");
    await expect(page.getByRole("alert")).toContainText('Game 3 (E vs F), line 23, column');
    const list = page.getByRole("list", { name: "Games in this PGN" });
    await expect(list.getByRole("link")).toHaveCount(3);
    await list.getByRole("link", { name: /C vs D/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("C vs D");
  });

  test("uploading a .pgn file works", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("or upload a .pgn file").setInputFiles({
      name: "game.pgn",
      mimeType: "application/x-chess-pgn",
      buffer: Buffer.from(fixtureText("pgn", "rules", "checkmate-white-wins.pgn")),
    });
    await expect(page).toHaveURL(/\/review\//);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("1–0");
  });

  test("malformed PGN shows the location of the error and does not navigate", async ({ page }) => {
    await pastePgn(page, fixtureText("pgn", "malformed", "illegal-move.pgn"));
    await expect(page.getByRole("alert")).toContainText(
      'Game 1 (Alice vs Bob), line 7, column 4: Illegal or unreadable move "Ke3" at 3. (White to move)',
    );
    await expect(page).toHaveURL(/\/$/);
  });

  test("text with no games says so", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("PGN text (one or more games)").fill("   ");
    await expect(page.getByRole("button", { name: "Load PGN" })).toBeDisabled();
    await page.getByLabel("PGN text (one or more games)").fill("% only an escape line");
    await page.getByRole("button", { name: "Load PGN" }).click();
    await expect(page.getByRole("alert")).toContainText("No games were found");
  });

  test("an unknown game id explains that games are not saved yet", async ({ page }) => {
    await page.goto("/review/pgn%3Adoesnotexist");
    await expect(page.getByRole("heading", { name: "Game not loaded" })).toBeVisible();
  });

  test("the downloaded PGN parses back to the same moves", async ({ page }) => {
    const pgn = fixtureText("pgn", "chesscom", "12-blitz.pgn");
    await pastePgn(page, pgn);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PGN" }).click();
    const download = await downloadPromise;
    const path = await download.path();
    const { readFileSync } = await import("node:fs");
    const exported = parsePgn(readFileSync(path, "utf8")).games[0]!;
    expect(exported.plies).toEqual(parsePgn(pgn).games[0]!.plies);
  });
});
