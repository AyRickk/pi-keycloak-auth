import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError, SessionExpiredError } from "../src/errors.js";
import { createRefresher, ROTATION_GRACE_MS, type Credentials } from "../src/refresh.js";
import { captureConsole, fakeKeycloak, testConfig, tokens, TOKEN_URL } from "./helpers.js";

describe("refresh", () => {
  let logs: string[];
  beforeEach(() => {
    vi.stubEnv("PI_KC_LOG", "debug");
    logs = captureConsole();
  });

  const setup = (handler: Parameters<typeof fakeKeycloak>[0], notify = vi.fn()) => {
    const kc = fakeKeycloak(handler);
    const refresh = createRefresher(testConfig(), { net: kc.net, notify });
    const cred = (expiresInMs: number, n = 0): Credentials => ({
      access: `access-${n}`,
      refresh: `refresh-${n}`,
      expires: kc.now() + expiresInMs,
    });
    return { kc, refresh, cred, notify };
  };

  it("does not call Keycloak while the access token outlives the leeway", async () => {
    const { kc, refresh, cred } = setup(() => ({ body: tokens(1) }));
    const current = cred(31_000);
    await expect(refresh(current)).resolves.toBe(current);
    expect(kc.calls).toHaveLength(0);
  });

  it("refreshes inside the leeway and returns the rotated pair", async () => {
    const { kc, refresh, cred } = setup(() => ({ body: tokens(1, 600) }));
    const next = await refresh(cred(29_000));
    expect(next).toEqual({ access: "access-1", refresh: "refresh-1", expires: kc.now() + 600_000 });
    expect(kc.calls).toHaveLength(1);
    expect(kc.calls[0]?.url).toBe(TOKEN_URL);
    expect(Object.fromEntries(kc.calls[0]!.form)).toEqual({
      grant_type: "refresh_token",
      client_id: "pi-cli",
      refresh_token: "refresh-0",
    });
  });

  it("keeps the previous refresh token when Keycloak does not rotate it", async () => {
    const { refresh, cred } = setup(() => ({ body: { access_token: "access-1", expires_in: 300 } }));
    expect((await refresh(cred(0))).refresh).toBe("refresh-0");
  });

  it("single-flight: concurrent refreshes of the same token make one Keycloak call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { kc, refresh, cred } = setup(async () => {
      await gate;
      return { body: tokens(1) };
    });
    const current = cred(-1);
    const all = Promise.all([refresh(current), refresh({ ...current }), refresh({ ...current })]);
    release();
    const results = await all;
    expect(kc.calls).toHaveLength(1);
    expect(new Set(results.map((r) => r.refresh))).toEqual(new Set(["refresh-1"]));
  });

  it("grace cache: a late caller holding the redeemed token gets the new pair without a call", async () => {
    // Simulates pi's lock being bypassed (compromised lock, write lost): the old
    // credential is presented again after its refresh token was rotated.
    let n = 0;
    const { kc, refresh, cred } = setup(() => ({ body: tokens(++n) }));
    const stale = cred(-1);
    const first = await refresh(stale);
    kc.advance(ROTATION_GRACE_MS - 1);
    const late = await refresh({ ...stale });
    expect(late).toEqual(first);
    expect(kc.calls).toHaveLength(1);
  });

  it("grace cache expires after 60 s and is never written to the logs", async () => {
    let n = 0;
    const { kc, refresh, cred } = setup(() => ({ body: tokens(++n) }));
    const stale = cred(-1);
    await refresh(stale);
    kc.advance(ROTATION_GRACE_MS);
    await refresh({ ...stale });
    expect(kc.calls).toHaveLength(2);
    expect(logs.join("\n")).not.toMatch(/refresh-\d/);
  });

  it("grace cache is keyed by refresh token: another token is refreshed normally", async () => {
    let n = 10;
    const { kc, refresh, cred } = setup(() => ({ body: tokens(++n) }));
    await refresh(cred(-1, 0));
    await refresh(cred(-1, 5));
    expect(kc.calls.map((c) => c.form.get("refresh_token"))).toEqual(["refresh-0", "refresh-5"]);
  });

  it("invalid_grant → SessionExpiredError naming /login, logged and pushed to the UI", async () => {
    const { refresh, cred, notify } = setup(() => ({
      status: 400,
      body: { error: "invalid_grant", error_description: "Offline user session not found" },
    }));
    const error = await refresh(cred(-1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionExpiredError);
    expect((error as Error).message).toContain("/login keycloak");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/login keycloak"));
    expect(logs.some((l) => l.startsWith("[keycloak-auth] error:") && l.includes("/login keycloak"))).toBe(
      true,
    );
  });

  it("invalid_grant is not cached: the next attempt calls Keycloak again", async () => {
    const { kc, refresh, cred } = setup(() => ({ status: 400, body: { error: "invalid_grant" } }));
    await refresh(cred(-1)).catch(() => {});
    await refresh(cred(-1)).catch(() => {});
    expect(kc.calls).toHaveLength(2);
  });

  it.each([
    ["network error", () => new TypeError("fetch failed")],
    ["5xx", () => ({ status: 503, body: { error: "temporarily_unavailable" } })],
    ["429", () => ({ status: 429, body: {} })],
    ["timeout", () => Object.assign(new Error("timed out"), { name: "TimeoutError" })],
  ])("transient %s: keeps the still-valid access token, retries next time", async (_name, reply) => {
    let fail = true;
    const { kc, refresh, cred } = setup(() => (fail ? reply() : { body: tokens(1) }));
    const current = cred(10_000);
    await expect(refresh(current)).resolves.toBe(current);
    fail = false;
    await expect(refresh(current)).resolves.toMatchObject({ access: "access-1" });
    expect(kc.calls).toHaveLength(2);
    expect(logs.some((l) => l.includes("warn:") && l.includes("failed transiently"))).toBe(true);
  });

  it("transient failure with an expired access token throws", async () => {
    const { refresh, cred } = setup(() => new TypeError("fetch failed"));
    await expect(refresh(cred(-1))).rejects.toThrow(
      /Token refresh failed for keycloak.*Could not reach Keycloak/,
    );
  });

  it("transient wrapper: network failures become NetworkError", async () => {
    const { refresh, cred } = setup(() => new TypeError("fetch failed"));
    const error = (await refresh(cred(-1)).catch((e: unknown) => e)) as Error;
    expect(error.cause).toBeInstanceOf(NetworkError);
  });

  it("other OAuth errors fail with a /login hint", async () => {
    const { refresh, cred } = setup(() => ({ status: 401, body: { error: "unauthorized_client" } }));
    await expect(refresh(cred(-1))).rejects.toThrow(/unauthorized_client.*\/login keycloak/);
  });

  it("passes the host's abort signal to fetch", async () => {
    const { kc, refresh, cred } = setup(() => ({ body: tokens(1) }));
    const controller = new AbortController();
    await refresh(cred(-1), controller.signal);
    const init = kc.fetch.mock.calls[0]?.[1];
    expect(init?.signal).toBe(controller.signal);
  });

  it("never logs access or refresh tokens", async () => {
    const { refresh, cred } = setup(() => ({
      body: {
        access_token: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl",
        refresh_token: "r".repeat(64),
        expires_in: 300,
      },
    }));
    await refresh(cred(-1));
    const all = logs.join("\n");
    expect(all).toContain("refreshed access token");
    expect(all).not.toContain("eyJhbGci");
    expect(all).not.toContain("r".repeat(20));
  });
});
