import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useAnalysis } from "@/app/analysis/analysisStore";
import { useGames } from "@/app/games";
import { usePreferences } from "@/app/prefs";
import { startReviewSync, useReview } from "@/app/review/reviewStore";
import { moveNumberLabel, fenMoveInfo, parseUci } from "@/core/chess/notation";
import { resolveUserColor } from "@/core/game/record";
import type { GameRecord } from "@/core/game/types";
import type { GameReview } from "@/core/review";
import { exportPgn } from "@/core/pgn";
import { Button, Card } from "../components/primitives";
import { AboutAnalysis } from "../components/review/AboutAnalysis";
import { AnalysisControls } from "../components/review/AnalysisControls";
import { AnalysisDebugPanel } from "../components/review/AnalysisDebugPanel";
import { DisplayOptions } from "../components/review/DisplayOptions";
import { EvalBar } from "../components/review/EvalBar";
import { EvalGraph } from "../components/review/EvalGraph";
import { GameHeader } from "../components/review/GameHeader";
import { GameSummary } from "../components/review/GameSummary";
import { MoveList } from "../components/review/MoveList";
import { MovePanel } from "../components/review/MovePanel";
import { NavControls } from "../components/review/NavControls";
import { ReviewBoard, type BoardArrow } from "../components/review/ReviewBoard";
import { useMoveKeys } from "../hooks/useMoveKeys";
import { LABEL_INFO, displayLabel, formatWin } from "../review/presentation";

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
  const preset = usePreferences((state) => state.analysisPreset);
  const showExperimental = usePreferences((state) => state.showExperimentalLabels);
  const showChesscom = usePreferences((state) => state.showChesscomAccuracy);
  const [searchParams] = useSearchParams();
  // The raw engine debug view (Phase 3 decision Q4): ?debug=1, or localStorage "chess-coach.debug" = "1".
  const debug = searchParams.get("debug") === "1" || debugFlag();
  // Narrow subscriptions: the page re-renders when the review or the current move changes, not on
  // every engine result while an analysis runs (Phase 3: no main-thread task over 50 ms).
  const analysisId = useAnalysis((state) => {
    const view = state.view;
    return view && view.gameId === game.id && view.preset === preset && (view.analysis?.completedCount ?? 0) > 0 ? view.analysisId : undefined;
  });
  const liveReview = useReview((state) => state.review);
  useEffect(() => startReviewSync(), []);
  const lastPly = game.plies.length;
  const [ply, setPly] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const go = useCallback((target: number) => setPly(Math.max(0, Math.min(lastPly, target))), [lastPly]);
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

  // The review of the analysis the controls show (same game and preset), if there is one.
  // A new review is rendered in the background (React time-slices deferred renders), so a long
  // game's review appearing never blocks the main thread (Phase 3 performance gate).
  const deferredReview = useDeferredValue(liveReview);
  const review = analysisId && deferredReview?.rawAnalysisId === analysisId ? deferredReview : undefined;
  const labels = useMemo(() => review?.moves.map((m) => displayLabel(m.label, showExperimental)), [review, showExperimental]);
  const move = review && ply > 0 ? review.moves[ply - 1] : undefined;
  const shownLabel = labels?.[ply - 1];
  const score = review ? (ply === 0 ? review.moves[0]?.scoreBefore : move?.scoreAfter) : undefined;
  // At the position after a move: the played move, and the engine's best move instead of it.
  const arrows = useMemo<BoardArrow[]>(() => {
    if (!current || !move) return [];
    const list: BoardArrow[] = [{ uci: current.uci, kind: "played" }];
    if (move.bestMove && move.bestMove.uci !== current.uci) list.push({ uci: move.bestMove.uci, kind: "best" });
    return list;
  }, [current, move]);
  const badgeSquare = current ? parseUci(current.uci)?.to : undefined;
  const badge = useMemo(() => (badgeSquare && shownLabel ? { square: badgeSquare, label: shownLabel } : undefined), [badgeSquare, shownLabel]);
  const positionLabel = current
    ? `Position after ${moveLabel(game, ply)} ${current.san}${shownLabel ? ` — ${LABEL_INFO[shownLabel].name}` : ""}`
    : "Start position";
  const describe = (k: number) => {
    const win = review?.winSeries[k];
    const where = k === 0 ? "Start position" : `${moveLabel(game, k)} ${game.plies[k - 1]!.san}`;
    const label = labels?.[k - 1];
    return `${where}${label ? ` (${LABEL_INFO[label].name})` : ""} · ${win === null || win === undefined ? "no evaluation" : `White ${formatWin(win)}`}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <GameHeader game={game} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,34rem)_minmax(16rem,1fr)_minmax(16rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-stretch gap-2">
            {review && <EvalBar score={score} orientation={orientation} />}
            <div className="min-w-0 flex-1">
              <ReviewBoard
                fen={fen}
                orientation={orientation}
                label={positionLabel}
                arrows={arrows}
                badge={badge}
                {...(current ? { lastMove: current.uci } : {})}
              />
            </div>
          </div>
          <NavControls currentPly={ply} lastPly={lastPly} onGo={go} onFlip={() => setFlipped((f) => !f)} />
          {review && <EvalGraph series={review.winSeries} labels={labels ?? []} ply={ply} onSelect={go} describe={describe} />}
          <p className="sr-only" aria-live="polite">
            {positionLabel}
          </p>
        </div>

        <Card title="Moves">
          <MoveList startFen={game.startFen} plies={game.plies} currentPly={ply} onSelect={go} {...(labels ? { labels } : {})} />
          {review && (
            <div className="mt-4 border-t border-border pt-3">
              <MovePanel game={game} review={review} ply={ply} showExperimental={showExperimental} />
            </div>
          )}
          <PositionTools game={game} fen={fen} />
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <AnalysisControls game={game} />
          {analysisId && <SummaryCard game={game} review={review} showExperimental={showExperimental} showChesscom={showChesscom} onSelect={go} />}
          <Card title="Display">
            <DisplayOptions />
          </Card>
          {debug && <AnalysisDebugPanel game={game} ply={ply} onSelect={go} />}
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

/** The summary card; it alone follows the analysis store's progress (for About this analysis). */
function SummaryCard({
  game,
  review,
  showExperimental,
  showChesscom,
  onSelect,
}: {
  game: GameRecord;
  review: GameReview | undefined;
  showExperimental: boolean;
  showChesscom: boolean;
  onSelect: (ply: number) => void;
}) {
  const status = useReview((state) => state.status);
  const error = useReview((state) => state.error);
  const raw = useAnalysis((state) => (state.view?.analysisId === review?.rawAnalysisId ? state.view?.analysis : undefined));
  return (
    <Card title="Summary">
      {review ? (
        <GameSummary game={game} review={review} showExperimental={showExperimental} showChesscom={showChesscom} onSelect={onSelect} />
      ) : status === "error" ? (
        <p className="text-sm text-danger" role="alert">
          The review could not be prepared: {error}
        </p>
      ) : (
        <p className="text-sm text-muted" role="status">
          Preparing the review…
        </p>
      )}
      {review && raw && (
        <div className="mt-4 border-t border-border pt-3">
          <AboutAnalysis raw={raw} review={review} />
        </div>
      )}
    </Card>
  );
}

function debugFlag(): boolean {
  try {
    return localStorage.getItem("chess-coach.debug") === "1";
  } catch {
    return false;
  }
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
