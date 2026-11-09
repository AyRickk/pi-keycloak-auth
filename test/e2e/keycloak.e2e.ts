/**
 * End-to-end against a real Keycloak (scripts/e2e-keycloak.sh up). Realm `pi-test`:
 * access tokens live 60 s, SSO session idle 60 s / max 90 s, offline sessions 30 days,
 * strict refresh-token rotation (revokeRefreshToken, maxReuse 0).
 *
 * The suite takes ~3 minutes because it waits for real expiries.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { KeycloakConfig } from "../../src/config.js";
import { SessionExpiredError } from "../../src/errors.js";
import { createLogin } from "../../src/login.js";
import { defaultNet, refreshGrant } from "../../src/oidc.js";
import { createRefresher, type Credentials } from "../../src/refresh.js";
import { callbacks } from "../helpers.js";
import { Browser, claims, ISSUER, KC_URL } from "./browser.js";

const config = (overrides: Partial<KeycloakConfig> = {}): KeycloakConfig => ({
  providerId: "keycloak",
  issuer: ISSUER,
  clientId: "pi-cli",
  scopes: ["openid", "offline_access"],
  callbackHost: "127.0.0.1",
  callbackPort: 0,
  redirectPath: "/callback",
  baseUrl: "http://127.0.0.1:1/v1",
  headers: {},
  models: [],
  refreshLeewaySeconds: 30,
  browserTimeoutSeconds: 60,
  ...overrides,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loginWithBrowser(cfg: KeycloakConfig): Promise<Credentials> {
  const browser = new Browser();
  return createLogin(cfg)(
    callbacks({
      onSelect: async () => "browser",
      onAuth: ({ url }) => {
        void browser.signIn(url).then(({ redirect }) => fetch(redirect!));
      },
    }),
  );
}

async function loginWithPaste(cfg: KeycloakConfig): Promise<Credentials> {
  const browser = new Browser();
  let pasted!: Promise<string>;
  return createLogin(cfg)(
    callbacks({
      onSelect: async () => "paste",
      onAuth: ({ url }) => void (pasted = browser.signIn(url).then(({ redirect }) => redirect!)),
      onManualCodeInput: () => pasted,
    }),
  );
}

async function loginWithDevice(cfg: KeycloakConfig): Promise<Credentials> {
  const browser = new Browser();
  return createLogin(cfg)(
    callbacks({
      onSelect: async () => "device",
      onDeviceCode: ({ verificationUri }) => void browser.signIn(verificationUri),
    }),
  );
}

describe.runIf(
  await fetch(`${ISSUER}/.well-known/openid-configuration`).then(
    (r) => r.ok,
    () => false,
  ),
)(`real Keycloak at ${KC_URL}`, () => {
  const session: Record<string, Credentials> = {};
  let loggedInAt = 0;

  beforeAll(async () => {
    session["browser"] = await loginWithBrowser(config());
    session["paste"] = await loginWithPaste(config({ callbackPort: 49170 }));
    session["device"] = await loginWithDevice(config());
    session["online"] = await loginWithBrowser(config({ scopes: ["openid"] }));
    loggedInAt = Date.now();
  });

  it("the three login methods return offline tokens for the gateway audience", () => {
    for (const method of ["browser", "paste", "device"]) {
      const creds = session[method]!;
      const access = claims(creds.access);
      expect(access["iss"]).toBe(ISSUER);
      expect(access["azp"]).toBe("pi-cli");
      expect(access["aud"]).toEqual(expect.arrayContaining(["llm-gateway"]));
      expect(access["typ"]).toBe("Bearer");
      expect(String(access["scope"])).toContain("offline_access");
      expect(claims(creds.refresh)["typ"]).toBe("Offline");
      expect(creds.expires - Date.now()).toBeLessThanOrEqual(60_000);
    }
    expect(claims(session["online"]!.refresh)["typ"]).toBe("Refresh");
  });

  it("leeway: no Keycloak call while the access token outlives refreshLeewaySeconds", async () => {
    let calls = 0;
    const net = {
      ...defaultNet,
      fetch: ((...a: Parameters<typeof fetch>) => (calls++, fetch(...a))) as typeof fetch,
    };
    const refresh = createRefresher(config(), { net });
    const creds = session["browser"]!;
    expect(await refresh(creds)).toBe(creds);
    expect(calls).toBe(0);
  });

  it("after the 60 s access token expires: refresh works, rotation is strict, single-flight + grace protect it", async () => {
    await sleep(Math.max(0, loggedInAt + 62_000 - Date.now()));
    const stale = session["browser"]!;
    expect(stale.expires).toBeLessThan(Date.now());

    let calls = 0;
    const net = {
      ...defaultNet,
      fetch: ((...a: Parameters<typeof fetch>) => (calls++, fetch(...a))) as typeof fetch,
    };
    const refresh = createRefresher(config(), { net });
    const [a, b, c] = await Promise.all([refresh(stale), refresh({ ...stale }), refresh({ ...stale })]);
    expect(calls).toBe(1);
    expect(a.access).not.toBe(stale.access);
    expect(a.refresh).not.toBe(stale.refresh);
    expect(b).toEqual(a);
    expect(c).toEqual(a);

    // The realm revokes a redeemed refresh token: reusing it directly fails…
    await expect(refreshGrant(config(), stale.refresh, defaultNet)).rejects.toMatchObject({
      code: "invalid_grant",
    });
    // …but a late caller inside the grace period still gets the rotated pair.
    expect(await refresh({ ...stale })).toEqual(a);
    expect(calls).toBe(1);
    session["browser"] = a;

    // The other methods' tokens refresh too.
    for (const method of ["paste", "device"]) {
      const next = await createRefresher(config())(session[method]!);
      expect(claims(next.access)["iss"]).toBe(ISSUER);
      session[method] = next;
    }
  });

  it("idle longer than the SSO session: offline tokens survive, online tokens get invalid_grant", async () => {
    // SSO max lifespan is 90 s (idle 60 s): wait past it.
    await sleep(Math.max(0, loggedInAt + 100_000 - Date.now()));
    const offline = await createRefresher(config())(session["device"]!);
    expect(claims(offline.access)["iss"]).toBe(ISSUER);

    const notified: string[] = [];
    const error = await createRefresher(config({ scopes: ["openid"] }), { notify: (m) => notified.push(m) })(
      session["online"]!,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionExpiredError);
    expect((error as Error).message).toContain("/login keycloak");
    expect(notified).toHaveLength(1);
  });
});
