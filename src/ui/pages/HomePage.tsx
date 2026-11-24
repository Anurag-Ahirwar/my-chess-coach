import { useEffect } from "react";
import { useGames } from "@/app/games";
import { useStorageStatus } from "@/app/storage";
import { Card } from "../components/primitives";
import { ChessComImport } from "../components/home/ChessComImport";
import { GameList } from "../components/home/GameList";
import { PgnImport } from "../components/home/PgnImport";

export function HomePage() {
  const order = useGames((state) => state.order);
  const byId = useGames((state) => state.byId);
  const listLoaded = useGames((state) => state.listLoaded);
  const loadAll = useGames((state) => state.loadAll);
  const storageMode = useStorageStatus((state) => state.mode);
  const unsaved = useGames((state) => state.unsaved);
  const unsavedStates = order.map((id) => unsaved[id]);
  const games = order.map((id) => byId[id]).filter((game) => game !== undefined);

  useEffect(() => {
    if (!listLoaded) void loadAll();
  }, [listLoaded, loadAll]);

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
        <Card title="Your games">
          <GameList games={games} label="Your games" />
          <p className="mt-2 text-sm text-muted">
            {storageMode === "memory"
              ? "Saving isn't available in this browser, so these games are kept until you close the tab."
              : unsavedStates.includes("saving")
                ? "Still saving… don't close or reload this tab yet."
                : unsavedStates.includes("failed")
                  ? "Some of these games couldn't be saved and may be gone after you close or reload this tab."
                  : "Saved in this browser."}
          </p>
        </Card>
      )}
    </div>
  );
}
