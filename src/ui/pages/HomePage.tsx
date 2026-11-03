import { useGames } from "@/app/games";
import { Card } from "../components/primitives";
import { ChessComImport } from "../components/home/ChessComImport";
import { GameList } from "../components/home/GameList";
import { PgnImport } from "../components/home/PgnImport";

export function HomePage() {
  const order = useGames((state) => state.order);
  const byId = useGames((state) => state.byId);
  const games = order.map((id) => byId[id]).filter((game) => game !== undefined);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Review a game</h1>
        <p className="mt-1 text-muted">Import a game from Chess.com or paste a PGN, then step through it move by move.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChessComImport />
        <PgnImport />
      </div>
      {games.length > 0 && (
        <Card title="Imported this session">
          <GameList games={games} label="Imported this session" />
          <p className="mt-2 text-sm text-muted">Games are kept until you reload the page.</p>
        </Card>
      )}
    </div>
  );
}
