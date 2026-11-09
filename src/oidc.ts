/**
 * Minimal Keycloak OIDC client over the global `fetch`: authorization-code exchange,
 * refresh-token grant and device authorization grant, all for a public client with PKCE.
 */
import { endpoints, type KeycloakConfig } from "./config.js";
import { NetworkError, OAuthError } from "./errors.js";
import { log } from "./log.js";
import type { Pkce } from "./pkce.js";

export interface Net {
  fetch: typeof fetch;
  now: () => number;
}

export const defaultNet: Net = { fetch: (...args) => globalThis.fetch(...args), now: () => Date.now() };

export interface TokenSet {
  access: string;
  /** Absent only when the server did not rotate on refresh. */
  refresh: string | undefined;
  /** Absolute expiry of the access token, ms since epoch. */
  expires: number;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | undefined;
  expiresAt: number;
  intervalSeconds: number;
}

type OidcConfig = Pick<KeycloakConfig, "issuer" | "clientId" | "scopes">;

async function postForm(
  net: Net,
  url: string,
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Only the grant type is logged: the body carries codes, verifiers and tokens.
  log.debug(`POST ${url} (${form["grant_type"] ?? "device_authorization"})`);
  let response: Response;
  try {
    response = await net.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new NetworkError(url, error);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new NetworkError(url, error);
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    if (response.ok) throw new OAuthError(response.status, "invalid_response", "response is not JSON");
  }
  if (!response.ok) {
    const code = typeof body["error"] === "string" ? body["error"] : `http_${response.status}`;
    const description = typeof body["error_description"] === "string" ? body["error_description"] : undefined;
    throw new OAuthError(response.status, code, description);
  }
  return body;
}

function toTokenSet(body: Record<string, unknown>, now: number): TokenSet {
  const access = body["access_token"];
  if (typeof access !== "string" || !access) {
    throw new OAuthError(200, "invalid_response", "missing access_token");
  }
  const refresh =
    typeof body["refresh_token"] === "string" && body["refresh_token"] ? body["refresh_token"] : undefined;
  const expiresIn =
    typeof body["expires_in"] === "number" && body["expires_in"] > 0 ? body["expires_in"] : 60;
  return { access, refresh, expires: now + expiresIn * 1000 };
}

export function authorizationUrl(
  config: OidcConfig,
  args: { redirectUri: string; state: string; pkce: Pkce },
): string {
  const url = new URL(endpoints(config.issuer).authorization);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: args.redirectUri,
    scope: config.scopes.join(" "),
    state: args.state,
    code_challenge: args.pkce.challenge,
    code_challenge_method: args.pkce.method,
  }).toString();
  return url.toString();
}

export async function exchangeCode(
  config: OidcConfig,
  args: { code: string; verifier: string; redirectUri: string },
  net: Net,
  signal?: AbortSignal,
): Promise<TokenSet> {
  const body = await postForm(
    net,
    endpoints(config.issuer).token,
    {
      grant_type: "authorization_code",
      client_id: config.clientId,
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.verifier,
    },
    signal,
  );
  return toTokenSet(body, net.now());
}

export async function refreshGrant(
  config: OidcConfig,
  refreshToken: string,
  net: Net,
  signal?: AbortSignal,
): Promise<TokenSet> {
  const body = await postForm(
    net,
    endpoints(config.issuer).token,
    { grant_type: "refresh_token", client_id: config.clientId, refresh_token: refreshToken },
    signal,
  );
  return toTokenSet(body, net.now());
}

/** RFC 8628 §3.1, with PKCE: Keycloak requires it when the client enforces S256. */
export async function startDeviceAuthorization(
  config: OidcConfig,
  pkce: Pkce,
  net: Net,
  signal?: AbortSignal,
): Promise<DeviceAuthorization> {
  const body = await postForm(
    net,
    endpoints(config.issuer).device,
    {
      client_id: config.clientId,
      scope: config.scopes.join(" "),
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
    },
    signal,
  );
  const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = body;
  if (
    typeof device_code !== "string" ||
    typeof user_code !== "string" ||
    typeof verification_uri !== "string"
  ) {
    throw new OAuthError(200, "invalid_response", "incomplete device authorization response");
  }
  return {
    deviceCode: device_code,
    userCode: user_code,
    verificationUri: verification_uri,
    verificationUriComplete:
      typeof verification_uri_complete === "string" ? verification_uri_complete : undefined,
    expiresAt: net.now() + (typeof expires_in === "number" ? expires_in : 600) * 1000,
    intervalSeconds: typeof interval === "number" && interval > 0 ? interval : 5,
  };
}

export type DevicePoll =
  { status: "done"; tokens: TokenSet } | { status: "pending" } | { status: "slow_down" };

/** One poll of the token endpoint (RFC 8628 §3.4). Terminal errors are thrown. */
export async function pollDeviceToken(
  config: OidcConfig,
  args: { deviceCode: string; verifier: string },
  net: Net,
  signal?: AbortSignal,
): Promise<DevicePoll> {
  try {
    const body = await postForm(
      net,
      endpoints(config.issuer).token,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.clientId,
        device_code: args.deviceCode,
        code_verifier: args.verifier,
      },
      signal,
    );
    return { status: "done", tokens: toTokenSet(body, net.now()) };
  } catch (error) {
    if (error instanceof OAuthError && error.code === "authorization_pending") return { status: "pending" };
    if (error instanceof OAuthError && error.code === "slow_down") return { status: "slow_down" };
    throw error;
  }
}
