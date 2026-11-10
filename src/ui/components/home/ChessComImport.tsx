import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { useGames } from "@/app/games";
import {
  GameImportError,
  chessComClient,
  importChessComGame,
  summariseChessComGame,
  type ChessComGameSummary,
} from "@/app/importService";
import { usePreferences } from "@/app/prefs";
import { ChessComError, normaliseUsername, type ArchiveMonth } from "@/infra/chesscom";
import { capitalise, formatDate, formatDateTime, formatMonth } from "@/ui/format";
import { Button, Card, ErrorMessage } from "../primitives";

type Loading = "archives" | "month" | "game" | null;

const OUTCOME_LABEL = { win: "Won", loss: "Lost", draw: "Draw" } as const;
const OUTCOME_CLASS = { win: "text-win", loss: "text-loss", draw: "text-draw" } as const;

function errorText(error: unknown): string {
  if (error instanceof ChessComError || error instanceof GameImportError) {
    return error instanceof ChessComError ? error.userMessage : error.message;
  }
  return "Something went wrong while talking to Chess.com.";
}

export function ChessComImport() {
  const inputId = useId();
  const monthId = useId();
  const navigate = useNavigate();
  const addGames = useGames((state) => state.add);
  const savedUsername = usePreferences((state) => state.chesscomUsername);
  const updatePrefs = usePreferences((state) => state.update);

  const [input, setInput] = useState(savedUsername);
  const [user, setUser] = useState<string>();
  const [months, setMonths] = useState<ArchiveMonth[]>([]);
  const [selected, setSelected] = useState<ArchiveMonth>();
  const [games, setGames] = useState<ChessComGameSummary[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [loading, setLoading] = useState<Loading>(null);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("");

  const loadMonth = async (username: string, month: ArchiveMonth) => {
    setSelected(month);
    setLoading("month");
    setError(undefined);
    try {
      const result = await chessComClient.getMonthGames(username, month.year, month.month);
      setGames(result.games.map((game) => summariseChessComGame(game, username)));
      setSkipped(result.skipped);
      setStatus(`${result.games.length} games in ${formatMonth(month.year, month.month)}.`);
      return result.games.length;
    } catch (e) {
      setGames([]);
      setError(errorText(e));
      return -1;
    } finally {
      setLoading(null);
    }
  };

  const findGames = async (raw: string) => {
    const username = normaliseUsername(raw);
    if (!username) {
      setError(new ChessComError("invalid_username").userMessage);
      return;
    }
    setLoading("archives");
    setError(undefined);
    setGames([]);
    setMonths([]);
    setStatus("Looking up archives…");
    let archives: ArchiveMonth[];
    try {
      archives = await chessComClient.getArchives(username);
    } catch (e) {
      setLoading(null);
      setStatus("");
      setError(errorText(e));
      return;
    }
    setLoading(null);
    setUser(username);
    updatePrefs({ chesscomUsername: username });
    setMonths(archives);
    if (archives.length === 0) {
      setStatus(`${username} has no games yet.`);
      return;
    }
    // Early in a month the newest archive may be empty; fall back to the previous one.
    const count = await loadMonth(username, archives[0]!);
    if (count === 0 && archives[1]) await loadMonth(username, archives[1]);
  };

  const openGame = async (summary: ChessComGameSummary) => {
    setLoading("game");
    setError(undefined);
    try {
      const record = await importChessComGame(summary.game);
      void addGames([record]); // in memory at once; saving reports its own problems
      void navigate(`/review/${encodeURIComponent(record.id)}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(null);
    }
  };

  const busy = loading !== null;

  return (
    <Card title="Import from Chess.com">
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void findGames(input);
        }}
      >
        <label htmlFor={inputId} className="text-sm text-muted">
          Chess.com username
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id={inputId}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="e.g. hikaru"
            className="min-h-10 min-w-0 flex-1 rounded-md border border-border bg-bg px-3"
          />
          <Button type="submit" variant="primary" disabled={busy || input.trim() === ""}>
            {loading === "archives" ? "Searching…" : "Find games"}
          </Button>
        </div>
        {savedUsername && !user && (
          <Button variant="ghost" className="self-start" disabled={busy} onClick={() => void findGames(savedUsername)}>
            Show recent games for {savedUsername}
          </Button>
        )}
      </form>

      <p className="sr-only" aria-live="polite">
        {status}
      </p>
      {error && (
        <div className="mt-3">
          <ErrorMessage>{error}</ErrorMessage>
        </div>
      )}

      {user && months.length > 0 && (
        <div className="mt-4 flex flex-col gap-3">
          <label htmlFor={monthId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Month</span>
            <select
              id={monthId}
              value={selected?.url ?? ""}
              disabled={busy}
              onChange={(event) => {
                const month = months.find((m) => m.url === event.target.value);
                if (month) void loadMonth(user, month);
              }}
              className="rounded-md border border-border bg-surface px-2 py-1"
            >
              {months.map((month) => (
                <option key={month.url} value={month.url}>
                  {formatMonth(month.year, month.month)}
                </option>
              ))}
            </select>
          </label>

          {loading === "month" && <p className="text-sm text-muted">Loading games…</p>}
          {loading !== "month" && games.length === 0 && !error && (
            <p className="text-sm text-muted">No games in this month.</p>
          )}
          {skipped > 0 && (
            <p className="text-sm text-muted">{skipped} game(s) in this month had unreadable data and are not listed.</p>
          )}
          {games.length > 0 && (
            <ul aria-label="Chess.com games" className="max-h-[28rem] divide-y divide-border overflow-y-auto rounded-md border border-border">
              {games.map((summary) => (
                <ChessComGameRow key={summary.game.url} summary={summary} disabled={busy} onOpen={() => void openGame(summary)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function ChessComGameRow({ summary, disabled, onOpen }: { summary: ChessComGameSummary; disabled: boolean; onOpen: () => void }) {
  const { game, outcome, opponent, opening, analysable, userColor } = summary;
  const result = userColor ? OUTCOME_LABEL[outcome] : outcome === "draw" ? "Draw" : outcome === "win" ? "White won" : "Black won";
  const side = userColor === "w" ? "White" : userColor === "b" ? "Black" : undefined;
  const vs = userColor ? `vs ${opponent.username}` : `${game.white.username} vs ${game.black.username}`;
  const endedAt = game.end_time ? game.end_time * 1000 : undefined;
  const reviewLabel = `Review ${vs}: ${result}${side ? ` as ${side}` : ""}, ${game.time_class}, ${formatDateTime(endedAt)}`;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium">
          {vs}
          {userColor && opponent.rating !== undefined && <span className="text-muted"> ({opponent.rating})</span>}
        </p>
        <p className="break-words text-sm text-muted">
          <span className={`font-medium ${OUTCOME_CLASS[outcome]}`}>{result}</span>
          {side && ` as ${side}`} · {capitalise(game.time_class)} · {formatDate(endedAt)}
          {opening && ` · ${opening}`}
        </p>
      </div>
      {analysable ? (
        <Button disabled={disabled} onClick={onOpen} aria-label={reviewLabel}>
          Review
        </Button>
      ) : (
        <span className="text-sm text-muted">Not supported ({game.rules})</span>
      )}
    </li>
  );
}
