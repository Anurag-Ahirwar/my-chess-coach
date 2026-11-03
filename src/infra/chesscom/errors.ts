export type ChessComErrorKind =
  | "invalid_username"
  | "not_found"
  | "gone"
  | "rate_limited"
  | "offline"
  | "http"
  | "invalid_response";

const MESSAGES: Record<ChessComErrorKind, string> = {
  invalid_username: "That doesn't look like a Chess.com username (3–25 letters, digits, '_' or '-').",
  not_found: "No Chess.com player or archive was found for that name.",
  gone: "Chess.com says this archive is permanently unavailable.",
  rate_limited: "Chess.com is limiting requests right now. Wait a minute and try again.",
  offline: "Couldn't reach Chess.com. Check your internet connection and try again.",
  http: "Chess.com returned an unexpected error.",
  invalid_response: "Chess.com returned data in an unexpected format.",
};

export class ChessComError extends Error {
  constructor(
    readonly kind: ChessComErrorKind,
    readonly status?: number,
    detail?: string,
  ) {
    super(detail ? `${MESSAGES[kind]} (${detail})` : MESSAGES[kind]);
    this.name = "ChessComError";
  }

  /** The message to show the user. */
  get userMessage(): string {
    return MESSAGES[this.kind];
  }
}
