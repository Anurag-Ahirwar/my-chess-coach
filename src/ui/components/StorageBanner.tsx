import { useStorageStatus } from "@/app/storage";
import { Button } from "./primitives";

/** Shows the latest storage problem (unavailable, full, blocked…) until dismissed. */
export function StorageBanner() {
  const problem = useStorageStatus((state) => state.problem);
  const dismiss = useStorageStatus((state) => state.dismiss);
  if (!problem) return null;
  return (
    <div role="alert" className="border-b border-danger bg-danger-surface">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm text-danger">
        <p className="min-w-0 flex-1">
          <span className="font-medium">Storage: </span>
          {problem.message}
          {problem.detail && <span className="block text-xs opacity-80">Details: {problem.detail}</span>}
        </p>
        <Button variant="ghost" onClick={dismiss} aria-label="Dismiss storage message">
          Dismiss
        </Button>
      </div>
    </div>
  );
}
