/**
 * Token refresh, called by pi through `oauth.refreshToken`.
 *
 * pi decides *when* to call this: on each request whose stored access token expires
 * within five minutes, under a file lock on auth.json, and it persists whatever is
 * returned before releasing the lock. On top of that this module:
 *
 * - skips the Keycloak call while the access token is still valid for more than
 *   `refreshLeewaySeconds` (pi's five-minute window would otherwise mean one refresh
 *   per request with Keycloak's default 5-minute access tokens);
 * - de-duplicates concurrent refreshes of the same refresh token in this process and
 *   remembers each result for a short grace period, so a caller still holding a
 *   rotated (now single-use) refresh token gets the new pair instead of `invalid_grant`;
 * - rides out transient failures (network, 5xx, 429, timeout) with the current access
 *   token while it has not expired;
 * - turns `invalid_grant` into an explicit "run /login" error.
 */
import { createHash } from "node:crypto";
import type { KeycloakConfig } from "./config.js";
import { describe, isTransient, OAuthError, SessionExpiredError } from "./errors.js";
import { log } from "./log.js";
import { defaultNet, refreshGrant, type Net, type TokenSet } from "./oidc.js";

/** Structural twin of pi's `OAuthCredentials`. */
export interface Credentials {
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export const ROTATION_GRACE_MS = 60_000;

export interface RefresherDeps {
  net?: Net;
  /** Surfaces a message in pi's UI (set once a session has started). */
  notify?: (message: string) => void;
  graceMs?: number;
}

export type Refresh = (credentials: Credentials, signal?: AbortSignal) => Promise<Credentials>;

export function toCredentials(tokens: TokenSet, previousRefresh?: string): Credentials {
  const refresh = tokens.refresh ?? previousRefresh;
  if (!refresh) throw new OAuthError(200, "invalid_response", "missing refresh_token");
  return { access: tokens.access, refresh, expires: tokens.expires };
}

/** Cache key: a digest, so the in-memory maps never hold a refresh token as a key. */
const keyOf = (refreshToken: string) => createHash("sha256").update(refreshToken).digest("base64url");

export function createRefresher(
  config: Pick<KeycloakConfig, "providerId" | "issuer" | "clientId" | "scopes" | "refreshLeewaySeconds">,
  deps: RefresherDeps = {},
): Refresh {
  const net = deps.net ?? defaultNet;
  const graceMs = deps.graceMs ?? ROTATION_GRACE_MS;
  const leewayMs = config.refreshLeewaySeconds * 1000;
  const inFlight = new Map<string, Promise<Credentials>>();
  const recent = new Map<string, { result: Credentials; until: number }>();

  const redeem = async (current: Credentials, signal?: AbortSignal): Promise<Credentials> => {
    try {
      const next = toCredentials(await refreshGrant(config, current.refresh, net, signal), current.refresh);
      log.info(
        `refreshed access token for ${config.providerId}, valid ${Math.round((next.expires - net.now()) / 1000)}s`,
      );
      return next;
    } catch (error) {
      if (error instanceof OAuthError && error.code === "invalid_grant") {
        const expired = new SessionExpiredError(config.providerId, error);
        log.error(expired.message);
        deps.notify?.(expired.message);
        throw expired;
      }
      if (isTransient(error) && current.expires > net.now()) {
        log.warn(
          `token refresh for ${config.providerId} failed transiently (${describe(error)}); ` +
            `keeping the current access token, valid ${Math.round((current.expires - net.now()) / 1000)}s`,
        );
        return current;
      }
      const message =
        `Token refresh failed for ${config.providerId}: ${describe(error)}. ` +
        `If it persists, run /login ${config.providerId}.`;
      log.error(message);
      throw new Error(message, { cause: error });
    }
  };

  return (current, signal) => {
    const now = net.now();
    if (current.expires - now > leewayMs) {
      log.debug(
        `access token for ${config.providerId} still valid ${Math.round((current.expires - now) / 1000)}s`,
      );
      return Promise.resolve(current);
    }

    for (const [key, entry] of recent) if (entry.until <= now) recent.delete(key);
    const key = keyOf(current.refresh);
    const cached = recent.get(key);
    if (cached) {
      log.debug(`refresh token for ${config.providerId} already redeemed; reusing its result`);
      return Promise.resolve(cached.result);
    }
    const pending = inFlight.get(key);
    if (pending) return pending;

    const attempt = redeem(current, signal)
      .then((result) => {
        // A transient fallback returns `current`: do not pin it, retry next time.
        if (result !== current) recent.set(key, { result, until: net.now() + graceMs });
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, attempt);
    return attempt;
  };
}
