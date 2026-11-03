import { describeTimeControl } from "@/core/game/record";
import type { GameRecord } from "@/core/game/types";
import { capitalise, formatDate, formatPlayer, formatResult } from "@/ui/format";

export function GameHeader({ game }: { game: GameRecord }) {
  const details = [
    formatDate(game.playedAt),
    game.timeControl && describeTimeControl(game.timeControl),
    game.source.kind === "chesscom" && game.source.timeClass ? capitalise(game.source.timeClass) : undefined,
    game.termination,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-1">
      <h1 className="break-words text-xl font-semibold">
        <span>{formatPlayer(game.white)}</span>
        <span className="text-muted"> vs </span>
        <span>{formatPlayer(game.black)}</span>
        <span className="ml-3 font-mono text-base text-muted">{formatResult(game.result)}</span>
      </h1>
      <p className="break-words text-sm text-muted">
        {details.join(" · ")}
        {game.source.kind === "chesscom" && (
          <>
            {" · "}
            <a href={game.source.url} target="_blank" rel="noreferrer noopener" className="text-accent underline">
              View on Chess.com
            </a>
          </>
        )}
      </p>
    </div>
  );
}
