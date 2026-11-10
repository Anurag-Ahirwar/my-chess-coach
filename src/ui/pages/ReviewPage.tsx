import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useGames } from "@/app/games";
import { usePreferences } from "@/app/prefs";
import { moveNumberLabel, fenMoveInfo } from "@/core/chess/notation";
import { resolveUserColor } from "@/core/game/record";
import type { GameRecord } from "@/core/game/types";
import { exportPgn } from "@/core/pgn";
import { Button, Card } from "../components/primitives";
import { GameHeader } from "../components/review/GameHeader";
import { MoveList } from "../components/review/MoveList";
import { NavControls } from "../components/review/NavControls";
import { ReviewBoard } from "../components/review/ReviewBoard";
import { useMoveKeys } from "../hooks/useMoveKeys";

export function ReviewPage() {
  const { gameId = "" } = useParams();
  const game = useGames((state) => state.byId[gameId]);
  const missing = useGames((state) => state.missing[gameId] === true);
  const load = useGames((state) => state.load);

  useEffect(() => {
    if (!game && !missing) void load(gameId);
  }, [game, missing, gameId, load]);

  if (!game && missing) {
    return (
      <Card title="Game not found">
        <p className="text-muted">This game isn't saved in this browser. It may have been imported in another browser or profile.</p>
        <Link to="/" className="mt-3 inline-block text-accent underline">
          Import a game
        </Link>
      </Card>
    );
  }
  if (!game) {
    return (
      <p className="text-muted" role="status">
        Loading game…
      </p>
    );
  }
  return <Review key={game.id} game={game} />;
}

function Review({ game }: { game: GameRecord }) {
  const username = usePreferences((state) => state.chesscomUsername);
  const orientationPref = usePreferences((state) => state.boardOrientation);
  const lastPly = game.plies.length;
  const [ply, setPly] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const go = (target: number) => setPly(Math.max(0, Math.min(lastPly, target)));
  const handlers = useMemo(
    () => ({
      previous: () => setPly((p) => Math.max(0, p - 1)),
      next: () => setPly((p) => Math.min(lastPly, p + 1)),
      first: () => setPly(0),
      last: () => setPly(lastPly),
    }),
    [lastPly],
  );
  useMoveKeys(handlers);

  const userColor = resolveUserColor(game, username);
  const baseOrientation = orientationPref === "auto" ? (userColor === "b" ? "black" : "white") : orientationPref;
  const orientation = flipped ? (baseOrientation === "white" ? "black" : "white") : baseOrientation;

  const current = ply === 0 ? undefined : game.plies[ply - 1];
  const fen = current?.fenAfter ?? game.startFen;
  const positionLabel = current ? `Position after ${moveLabel(game, ply)} ${current.san}` : "Start position";

  return (
    <div className="flex flex-col gap-4">
      <GameHeader game={game} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,34rem)_minmax(16rem,1fr)_minmax(16rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <ReviewBoard fen={fen} orientation={orientation} label={positionLabel} {...(current ? { lastMove: current.uci } : {})} />
          <NavControls currentPly={ply} lastPly={lastPly} onGo={go} onFlip={() => setFlipped((f) => !f)} />
          <p className="sr-only" aria-live="polite">
            {positionLabel}
          </p>
        </div>

        <Card title="Moves">
          <MoveList startFen={game.startFen} plies={game.plies} currentPly={ply} onSelect={go} />
          <PositionTools game={game} fen={fen} />
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Engine analysis">
            <p className="text-sm text-muted">Evaluation, best moves and move labels will appear here once the engine is added.</p>
          </Card>
          <Card title="Coach">
            <p className="text-sm text-muted">Explanations of key moments will appear here in a later phase.</p>
          </Card>
          {game.warnings.length > 0 && (
            <Card title="PGN notes">
              <ul className="list-disc pl-5 text-sm text-muted">
                {game.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function moveLabel(game: GameRecord, ply: number): string {
  const { fullmove, turn } = fenMoveInfo(game.startFen);
  const plyOffset = turn === "w" ? ply - 1 : ply; // half-moves since the first White move of the start move number
  return moveNumberLabel(fullmove + Math.floor(plyOffset / 2), plyOffset % 2 === 0 ? "w" : "b");
}

function PositionTools({ game, fen }: { game: GameRecord; fen: string }) {
  const [copied, setCopied] = useState(false);
  const download = () => {
    const blob = new Blob([exportPgn(game)], { type: "application/x-chess-pgn" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${game.white.name}-vs-${game.black.name}.pgn`.replace(/[^\w.-]+/g, "_");
    link.click();
    URL.revokeObjectURL(url);
  };
  const copyFen = async () => {
    try {
      await navigator.clipboard.writeText(fen);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
      <label className="flex flex-col gap-1 text-sm text-muted">
        Position (FEN)
        <input
          readOnly
          value={fen}
          data-testid="current-fen"
          onFocus={(event) => event.target.select()}
          className="w-full rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-text"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void copyFen()}>{copied ? "Copied" : "Copy FEN"}</Button>
        <Button onClick={download}>Download PGN</Button>
      </div>
    </div>
  );
}
