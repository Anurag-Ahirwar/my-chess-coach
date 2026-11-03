import { Button } from "../primitives";

export interface NavControlsProps {
  currentPly: number;
  lastPly: number;
  onGo: (ply: number) => void;
  onFlip: () => void;
}

export function NavControls({ currentPly, lastPly, onGo, onFlip }: NavControlsProps) {
  const atStart = currentPly <= 0;
  const atEnd = currentPly >= lastPly;
  return (
    <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Move navigation">
      <Button aria-label="First position" title="First position (Home)" disabled={atStart} onClick={() => onGo(0)}>
        <span aria-hidden="true">⏮</span>
      </Button>
      <Button aria-label="Previous move" title="Previous move (←)" disabled={atStart} onClick={() => onGo(currentPly - 1)}>
        <span aria-hidden="true">◀</span>
      </Button>
      <Button aria-label="Next move" title="Next move (→)" disabled={atEnd} onClick={() => onGo(currentPly + 1)}>
        <span aria-hidden="true">▶</span>
      </Button>
      <Button aria-label="Last position" title="Last position (End)" disabled={atEnd} onClick={() => onGo(lastPly)}>
        <span aria-hidden="true">⏭</span>
      </Button>
      <Button variant="ghost" onClick={onFlip} className="ml-auto">
        Flip board
      </Button>
    </div>
  );
}
