import { Link } from "react-router";
import type { GameRecord } from "@/core/game/types";
import { formatDate, formatPlayer, formatResult } from "@/ui/format";

/** Imported games, each linking to its review page. */
export function GameList({ games, label }: { games: readonly GameRecord[]; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-border rounded-md border border-border">
      {games.map((game) => (
        <li key={game.id}>
          <Link
            to={`/review/${encodeURIComponent(game.id)}`}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-text no-underline hover:bg-surface-2"
          >
            <span className="min-w-0 break-words font-medium">
              {formatPlayer(game.white)} vs {formatPlayer(game.black)}
            </span>
            <span className="text-sm text-muted">
              {formatResult(game.result)} · {game.plies.length} plies · {formatDate(game.playedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
