// Live check against the real Chess.com API (not part of `npm test`).
// PowerShell:  $env:LIVE_CHESSCOM_USER="yourname"; npm run test:live
// bash:        LIVE_CHESSCOM_USER=yourname npm run test:live
import { describe, expect, it } from "vitest";
import { importChessComGame, isAnalysable } from "@/app/importService";
import { GameReplay } from "@/core/chess/position";
import { ChessComClient, type ChessComGame } from "@/infra/chesscom";

const user = process.env["LIVE_CHESSCOM_USER"] ?? "";
const COUNT = 10;

// Node's fetch has no browser User-Agent; Chess.com asks API clients to identify themselves.
const client = new ChessComClient({
  fetch: (input, init) =>
    fetch(input, { ...init, headers: { ...init?.headers, "User-Agent": "chess-coach-live-test/0.1 (local)" } }),
});

describe.runIf(user)(`the ${COUNT} most recent Chess.com games of ${user}`, () => {
  it("import, replay move by move, and end in Chess.com's final position", { timeout: 60_000 }, async () => {
    const recent: ChessComGame[] = [];
    for (const month of await client.getArchives(user)) {
      const { games } = await client.getMonthGames(user, month.year, month.month);
      recent.push(...games.filter(isAnalysable));
      if (recent.length >= COUNT) break;
    }
    const games = recent.slice(0, COUNT);
    expect(games.length).toBeGreaterThan(0);

    for (const game of games) {
      const record = await importChessComGame(game);
      // Step through every move again, independently of the importer.
      const replay = new GameReplay(record.startFen);
      for (const ply of record.plies) expect(replay.playUci(ply.uci).fenAfter).toBe(ply.fenAfter);

      const current = record.headers["CurrentPosition"];
      if (current) {
        // Compare everything except the en-passant field (Chess.com always writes it; see the parse tests).
        const strip = (fen: string) => fen.split(" ").filter((_, i) => i !== 3).join(" ");
        expect(strip(replay.fen), game.url).toBe(strip(current));
      }
      console.log(`ok  ${game.url}  ${record.plies.length} plies  ${record.white.name} vs ${record.black.name}  ${record.result}`);
    }
  });
});
