import { vi } from "vitest";
import type { KeycloakConfig } from "../src/config.js";
import type { Net } from "../src/oidc.js";
import type { OAuthLoginCallbacks } from "../src/pi-types.js";

export const ISSUER = "https://sso.example.test/realms/dev";
export const TOKEN_URL = `${ISSUER}/protocol/openid-connect/token`;
export const DEVICE_URL = `${ISSUER}/protocol/openid-connect/auth/device`;

export function testConfig(overrides: Partial<KeycloakConfig> = {}): KeycloakConfig {
  return {
    providerId: "keycloak",
    issuer: ISSUER,
    clientId: "pi-cli",
    scopes: ["openid", "offline_access"],
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    redirectPath: "/callback",
    baseUrl: "https://llm.example.test/v1",
    headers: {},
    models: [
      {
        id: "m1",
        name: "m1",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    discoverModels: false,
    loginMethod: undefined,
    refreshLeewaySeconds: 30,
    browserTimeoutSeconds: 300,
    ...overrides,
  };
}

export interface Call {
  url: string;
  form: URLSearchParams;
  authorization: string | null;
}

type Reply = { status?: number; body?: unknown } | Error;
type Handler = (call: Call) => Reply | Promise<Reply>;

/** A fake Keycloak behind an injected `fetch` and a manual clock. */
export function fakeKeycloak(handler: Handler) {
  let now = 1_700_000_000_000;
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      form: new URLSearchParams(String(init?.body ?? "")),
      authorization: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    if (init?.signal?.aborted) throw init.signal.reason;
    const reply = await handler(call);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  const net: Net = { fetch: fetchImpl as unknown as typeof fetch, now: () => now };
  return {
    net,
    calls,
    fetch: fetchImpl,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

export const tokens = (n: number, expiresIn = 300) => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_in: expiresIn,
  token_type: "Bearer",
});

export function callbacks(overrides: Partial<OAuthLoginCallbacks> = {}) {
  type C = OAuthLoginCallbacks;
  return {
    onAuth: vi.fn<C["onAuth"]>(overrides.onAuth ?? (() => {})),
    onDeviceCode: vi.fn<C["onDeviceCode"]>(overrides.onDeviceCode ?? (() => {})),
    onPrompt: vi.fn<C["onPrompt"]>(overrides.onPrompt ?? (async () => "")),
    onProgress: vi.fn<NonNullable<C["onProgress"]>>(overrides.onProgress ?? (() => {})),
    onManualCodeInput: vi.fn<NonNullable<C["onManualCodeInput"]>>(
      overrides.onManualCodeInput ?? (async () => ""),
    ),
    onSelect: vi.fn<C["onSelect"]>(overrides.onSelect ?? (async () => undefined)),
  } satisfies OAuthLoginCallbacks;
}

/** Capture everything written through console during a test. */
export function captureConsole() {
  const lines: string[] = [];
  for (const level of ["error", "warn", "info", "debug", "log"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return lines;
}
