export type EngineErrorKind =
  /** The caller cancelled the job. */
  | "cancelled"
  /** Initialisation, the search budget or the inactivity watchdog ran out. */
  | "timeout"
  /** The engine reported an error or exited unexpectedly. */
  | "crashed"
  /** The worker or pool was shut down. */
  | "quit"
  /** The engine could not be started at all. */
  | "unavailable"
  /** The worker was asked to do something in the wrong state (a programming error). */
  | "busy";

export class EngineError extends Error {
  constructor(
    readonly kind: EngineErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}
