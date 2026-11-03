const USERNAME_PATTERN = /^[a-z0-9_-]{3,25}$/;

/**
 * Normalises user input to the lowercase form used in API URLs. Accepts a
 * leading "@" and surrounding spaces. Returns undefined if it can't be valid.
 */
export function normaliseUsername(input: string): string | undefined {
  const name = input.trim().replace(/^@/, "").toLowerCase();
  return USERNAME_PATTERN.test(name) ? name : undefined;
}
