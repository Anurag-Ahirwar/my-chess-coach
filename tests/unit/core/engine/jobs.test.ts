import { describe, expect, it } from "vitest";
import { GameReplay, STANDARD_START_FEN } from "@/core/chess/position";
import { positionJob, terminalScore } from "@/core/engine/jobs";
import { readFixture } from "../../../helpers/fixtures";
import { gameFromPgn, gameFromUci } from "../../../helpers/games";

describe("positionJob", () => {
  it("sends the full move history up to the position, with its side to move", async () => {
    const game = await gameFromUci(["e2e4", "e7e5", "g1f3"]);
    expect(positionJob(game, 0)).toEqual({ positionIndex: 0, startFen: STANDARD_START_FEN, moves: [], fen: STANDARD_START_FEN, sideToMove: "w" });
    expect(positionJob(game, 2)).toMatchObject({ moves: ["e2e4", "e7e5"], sideToMove: "w", fen: game.plies[1]!.fenAfter });
    expect(positionJob(game, 3)).toMatchObject({ moves: ["e2e4", "e7e5", "g1f3"], sideToMove: "b", fen: game.plies[2]!.fenAfter });
  });

  it("keeps a custom start FEN and Black-to-move starts", async () => {
    const startFen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1";
    const game = await gameFromUci(["e7e5"], startFen);
    expect(positionJob(game, 0)).toMatchObject({ startFen, moves: [], sideToMove: "b" });
    expect(positionJob(game, 1)).toMatchObject({ startFen, moves: ["e7e5"], sideToMove: "w" });
  });

  it("rejects positions outside the game", async () => {
    const game = await gameFromUci(["e2e4"]);
    expect(() => positionJob(game, 2)).toThrow(RangeError);
    expect(() => positionJob(game, -1)).toThrow(RangeError);
    expect(() => positionJob(game, 0.5)).toThrow(RangeError);
  });
});

describe("terminalScore (methodology §3, decision D6)", () => {
  it.each([
    ["checkmate-white-wins.pgn", "1-0"],
    ["checkmate-black-wins.pgn", "0-1"],
    ["stalemate.pgn", "1/2-1/2"],
    ["insufficient-material.pgn", "1/2-1/2"],
    ["threefold-repetition.pgn", "1/2-1/2"],
    ["fifty-move-rule.pgn", "1/2-1/2"],
  ])("%s: the final position is terminal %s", async (file, result) => {
    const game = await gameFromPgn(readFixture("pgn", "rules", file));
    expect(terminalScore(game, game.plies.length)).toEqual({ kind: "terminal", result });
    for (let i = 0; i < game.plies.length; i++) expect(terminalScore(game, i)).toBeNull();
  });

  it("a game that ended by resignation or is unfinished has no terminal position", async () => {
    const game = await gameFromUci(["e2e4", "e7e5"]);
    expect(terminalScore(game, 2)).toBeNull();
  });

  it("a threefold repetition the players continued past is not terminal", async () => {
    const shuffle = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"];
    const game = await gameFromUci([...shuffle, "e2e4"]);
    // chess.js does see a threefold repetition at position 8 ...
    const replay = new GameReplay();
    for (const move of shuffle) replay.playUci(move);
    expect(replay.terminalState()).toEqual({ kind: "threefold_repetition" });
    // ... but the game went on, so position 8 is analysed by the engine.
    expect(terminalScore(game, 8)).toBeNull();
    expect(terminalScore(game, 9)).toBeNull();
  });
});
