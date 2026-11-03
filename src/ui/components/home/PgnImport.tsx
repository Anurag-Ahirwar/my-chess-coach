import { useId, useState } from "react";
import { useNavigate } from "react-router";
import { useGames } from "@/app/games";
import { importPgnText } from "@/app/importService";
import type { GameRecord } from "@/core/game/types";
import { describePgnError, type PgnError } from "@/core/pgn";
import { Button, Card, ErrorMessage } from "../primitives";
import { GameList } from "./GameList";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function PgnImport() {
  const textId = useId();
  const fileId = useId();
  const navigate = useNavigate();
  const addGames = useGames((state) => state.add);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<PgnError[]>([]);
  const [problem, setProblem] = useState<string>();
  const [choices, setChoices] = useState<GameRecord[]>([]);

  const runImport = async (pgn: string, fileName?: string) => {
    setBusy(true);
    setProblem(undefined);
    setChoices([]);
    try {
      const { records, errors: parseErrors } = await importPgnText(pgn, fileName);
      setErrors(parseErrors);
      if (records.length === 0) {
        if (parseErrors.length === 0) setProblem("No games were found in that PGN.");
        return;
      }
      addGames(records);
      if (records.length === 1 && parseErrors.length === 0) void navigate(`/review/${encodeURIComponent(records[0]!.id)}`);
      else setChoices(records);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setErrors([]);
      setProblem(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.`);
      return;
    }
    await runImport(await file.text(), file.name);
  };

  return (
    <Card title="Paste or upload a PGN">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void runImport(text);
        }}
      >
        <label htmlFor={textId} className="text-sm text-muted">
          PGN text (one or more games)
        </label>
        <textarea
          id={textId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={'[Event "Casual game"]\n\n1. e4 e5 2. Nf3 Nc6 *'}
          className="w-full resize-y rounded-md border border-border bg-bg p-2 font-mono text-sm"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy || text.trim() === ""}>
            Load PGN
          </Button>
          <label htmlFor={fileId} className="text-sm text-muted">
            or upload a .pgn file
          </label>
          <input
            id={fileId}
            type="file"
            accept=".pgn,application/x-chess-pgn,application/vnd.chess-pgn,text/plain"
            disabled={busy}
            onChange={(event) => {
              void onFile(event.target.files?.[0]);
              event.target.value = "";
            }}
            className="max-w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-text"
          />
        </div>
      </form>

      <div className="mt-3 flex flex-col gap-3" aria-live="polite">
        {problem && <ErrorMessage>{problem}</ErrorMessage>}
        {errors.length > 0 && (
          <ErrorMessage>
            <p className="font-medium">
              {errors.length === 1 ? "1 game could not be read:" : `${errors.length} games could not be read:`}
            </p>
            <ul className="mt-1 list-disc pl-5">
              {errors.map((error) => (
                <li key={`${error.gameIndex}-${error.line}-${error.column}`} className="break-words">
                  {describePgnError(error)}
                </li>
              ))}
            </ul>
          </ErrorMessage>
        )}
        {choices.length > 0 && (
          <div>
            <p className="mb-2 text-sm">
              {choices.length === 1 ? "1 game loaded. Choose it to review:" : `${choices.length} games loaded. Choose one to review:`}
            </p>
            <GameList games={choices} label="Games in this PGN" />
          </div>
        )}
      </div>
    </Card>
  );
}
