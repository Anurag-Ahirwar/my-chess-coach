import { useEffect } from "react";

export interface MoveKeyHandlers {
  previous: () => void;
  next: () => void;
  first: () => void;
  last: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** ← → Home End move through the game, except while typing in a form field. */
export function useMoveKeys(handlers: MoveKeyHandlers): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isTypingTarget(event.target)) return;
      const actions: Record<string, (() => void) | undefined> = {
        ArrowLeft: handlers.previous,
        ArrowRight: handlers.next,
        Home: handlers.first,
        End: handlers.last,
      };
      const action = actions[event.key];
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}
