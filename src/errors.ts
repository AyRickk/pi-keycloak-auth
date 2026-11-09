/** Error types. Messages are user-facing and never contain secrets. */

/** Keycloak answered with an OAuth error body (RFC 6749 §5.2) or a non-2xx status. */
export class OAuthError extends Error {
  override readonly name = "OAuthError";
  constructor(
    readonly status: number,
    readonly code: string,
    readonly description?: string,
  ) {
    super(description ? `${code}: ${description}` : code);
  }
}

/** Keycloak could not be reached (DNS, TLS, refused connection, timeout). */
export class NetworkError extends Error {
  override readonly name = "NetworkError";
  constructor(endpoint: string, cause: unknown) {
    super(`Could not reach Keycloak at ${endpoint}: ${describe(cause)}`, { cause });
  }
}

/** The configuration is incomplete or invalid; `fields` names the culprits. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    message: string,
    readonly fields: readonly string[],
  ) {
    super(message);
  }
}

/** The refresh token was rejected: the user has to log in again. */
export class SessionExpiredError extends Error {
  override readonly name = "SessionExpiredError";
  constructor(providerId: string, cause: unknown) {
    super(sessionExpiredMessage(providerId), { cause });
  }
}

export function sessionExpiredMessage(providerId: string): string {
  return (
    `Keycloak session expired for "${providerId}" (invalid_grant): the refresh token is no longer ` +
    `accepted. Run /login ${providerId} to sign in again.`
  );
}

/**
 * Failures worth riding out with the current access token: Keycloak unreachable,
 * a 5xx, rate limiting, or the host's refresh timeout.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  if (error instanceof OAuthError) return error.status >= 500 || error.status === 429;
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = cause.cause instanceof Error ? ` (${cause.cause.message})` : "";
    return `${cause.message}${inner}`;
  }
  return String(cause);
}
