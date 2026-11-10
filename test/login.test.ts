import { createServer } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogin } from "../src/login.js";
import { challengeFor } from "../src/pkce.js";
import {
  callbacks,
  captureConsole,
  DEVICE_URL,
  fakeKeycloak,
  ISSUER,
  testConfig,
  tokens,
} from "./helpers.js";

const AUTH_URL = `${ISSUER}/protocol/openid-connect/auth`;
const noTimer = () => () => {};

/** Plays the browser: follows the authorization URL to the loopback redirect. */
async function browserVisits(authorizationUrl: string, code = "the-code") {
  const url = new URL(authorizationUrl);
  const redirect = new URL(url.searchParams.get("redirect_uri")!);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", url.searchParams.get("state")!);
  return fetch(redirect);
}

describe("login", () => {
  let logs: string[];
  beforeEach(() => {
    vi.stubEnv("PI_KC_LOG", "debug");
    logs = captureConsole();
  });

  it("lists the browser flow first on a desktop", async () => {
    const cb = callbacks();
    await createLogin(testConfig())(cb).catch(() => {});
    const prompt = cb.onSelect.mock.calls[0]![0];
    expect(prompt.options.map((o) => o.id)).toEqual(["browser", "paste", "device"]);
    expect(prompt.options[0]!.label).toMatch(/recommended/);
  });

  it("lists the device flow first without a local browser", async () => {
    const cb = callbacks();
    await createLogin(testConfig(), { headless: "SSH session" })(cb).catch(() => {});
    const prompt = cb.onSelect.mock.calls[0]![0];
    expect(prompt.options.map((o) => o.id)).toEqual(["device", "browser", "paste"]);
    expect(prompt.message).toContain("SSH session");
  });

  it("cancelling the method choice cancels the login", async () => {
    await expect(createLogin(testConfig())(callbacks())).rejects.toThrow(/cancelled/);
  });

  describe("browser, auto-capture", () => {
    it("runs Authorization Code + PKCE S256 with state, and captures the redirect", async () => {
      const kc = fakeKeycloak(() => ({ body: tokens(1) }));
      let visit: Promise<Response> | undefined;
      const cb = callbacks({
        onSelect: async () => "browser",
        onAuth: vi.fn(({ url }) => void (visit = browserVisits(url))),
      });
      const creds = await createLogin(testConfig(), { net: kc.net, schedule: noTimer })(cb);
      expect(creds).toEqual({ access: "access-1", refresh: "refresh-1", expires: kc.now() + 300_000 });
      expect(await (await visit!).text()).toContain("Authentication complete");

      const authUrl = new URL(cb.onAuth.mock.calls[0]![0].url);
      expect(authUrl.origin + authUrl.pathname).toBe(AUTH_URL);
      const q = authUrl.searchParams;
      expect(q.get("response_type")).toBe("code");
      expect(q.get("client_id")).toBe("pi-cli");
      expect(q.get("code_challenge_method")).toBe("S256");
      expect(q.get("scope")).toBe("openid offline_access");
      expect(q.get("state")!.length).toBeGreaterThanOrEqual(32);
      expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      const form = kc.calls[0]!.form;
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("the-code");
      expect(form.get("redirect_uri")).toBe(q.get("redirect_uri"));
      expect(form.has("client_secret")).toBe(false);
      expect(challengeFor(form.get("code_verifier")!)).toBe(q.get("code_challenge"));
    });

    it("shows the URL through onProgress instead of onAuth without a local browser", async () => {
      const kc = fakeKeycloak(() => ({ body: tokens(1) }));
      const cb = callbacks({
        onSelect: async () => "browser",
        onProgress: vi.fn((message: string) => {
          const url = message.match(/https:\/\/\S+/)?.[0];
          if (url) void browserVisits(url);
        }),
      });
      await createLogin(testConfig(), { net: kc.net, headless: "SSH session", schedule: noTimer })(cb);
      expect(cb.onAuth).not.toHaveBeenCalled();
      expect(cb.onProgress).toHaveBeenCalledWith(expect.stringContaining(AUTH_URL));
    });

    it("falls back to pasting the code when the callback port is busy", async () => {
      const blocker = createServer();
      await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
      const port = (blocker.address() as { port: number }).port;
      const kc = fakeKeycloak(() => ({ body: tokens(1) }));
      const cb = callbacks({ onSelect: async () => "browser", onManualCodeInput: async () => "pasted-code" });
      await createLogin(testConfig({ callbackPort: port }), { net: kc.net, schedule: noTimer })(cb);
      expect(cb.onProgress).toHaveBeenCalledWith(
        expect.stringMatching(/already in use.*pasting the redirect URL/),
      );
      expect(kc.calls[0]!.form.get("code")).toBe("pasted-code");
      blocker.close();
    });

    it("a new attempt frees the port held by an abandoned one", async () => {
      const kc = fakeKeycloak(() => ({ body: tokens(1) }));
      const probe = createServer();
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((r) => probe.close(() => r()));

      const login = createLogin(testConfig({ callbackPort: port }), { net: kc.net, schedule: noTimer });
      const abandoned = login(callbacks({ onSelect: async () => "browser" }));
      await vi.waitFor(() => expect(logs.join()).not.toContain("already in use"));
      await new Promise((r) => setTimeout(r, 20));
      const retry = login(
        callbacks({ onSelect: async () => "browser", onAuth: vi.fn(({ url }) => void browserVisits(url)) }),
      );
      await expect(abandoned).rejects.toThrow(/superseded/i);
      await expect(retry).resolves.toMatchObject({ access: "access-1" });
    });
  });

  describe("browser, paste the code", () => {
    const run = async (pasted: (state: string) => string) => {
      const kc = fakeKeycloak(() => ({ body: tokens(1) }));
      let state = "";
      const cb = callbacks({
        onSelect: async () => "paste",
        onAuth: vi.fn(({ url }) => void (state = new URL(url).searchParams.get("state")!)),
        onManualCodeInput: async () => pasted(state),
      });
      const result = await createLogin(testConfig({ callbackPort: 49170 }), { net: kc.net })(cb);
      return { kc, result, cb };
    };

    it("accepts the full redirect URL and checks its state", async () => {
      const { kc } = await run((s) => `http://127.0.0.1:49170/callback?state=${s}&code=c-1`);
      expect(kc.calls[0]!.form.get("code")).toBe("c-1");
      expect(kc.calls[0]!.form.get("redirect_uri")).toBe("http://127.0.0.1:49170/callback");
    });

    it("accepts the bare code", async () => {
      const { kc } = await run(() => "  c-2  ");
      expect(kc.calls[0]!.form.get("code")).toBe("c-2");
    });

    it("rejects a URL from another login attempt", async () => {
      await expect(run(() => "http://127.0.0.1:49170/callback?state=forged&code=c")).rejects.toThrow(
        /state mismatch/,
      );
    });

    it("rejects an empty answer", async () => {
      await expect(run(() => " ")).rejects.toThrow(/No authorization code/);
    });
  });

  describe("device code", () => {
    it("runs RFC 8628 with PKCE, honours slow_down, and returns the tokens", async () => {
      const replies = [
        { status: 400, body: { error: "authorization_pending" } },
        { status: 400, body: { error: "slow_down" } },
        { body: tokens(7) },
      ];
      const kc = fakeKeycloak((call) =>
        call.url === DEVICE_URL
          ? {
              body: {
                device_code: "dev-code",
                user_code: "ABCD-EFGH",
                verification_uri: `${ISSUER}/device`,
                verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
                expires_in: 600,
                interval: 5,
              },
            }
          : replies.shift()!,
      );
      const waits: number[] = [];
      const sleep = async (ms: number) => void (waits.push(ms), kc.advance(ms));
      const cb = callbacks({ onSelect: async () => "device" });
      const creds = await createLogin(testConfig(), { net: kc.net, sleep })(cb);

      expect(creds.access).toBe("access-7");
      expect(waits).toEqual([5000, 5000, 10000]);
      expect(cb.onDeviceCode).toHaveBeenCalledWith(
        expect.objectContaining({
          userCode: "ABCD-EFGH",
          verificationUri: `${ISSUER}/device?user_code=ABCD-EFGH`,
          openBrowserOnConfirm: true,
        }),
      );
      const start = kc.calls[0]!.form;
      expect(start.get("code_challenge_method")).toBe("S256");
      expect(start.get("scope")).toBe("openid offline_access");
      const poll = kc.calls[1]!.form;
      expect(poll.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
      expect(challengeFor(poll.get("code_verifier")!)).toBe(start.get("code_challenge"));
    });

    it("does not offer to open a browser when headless", async () => {
      const kc = fakeKeycloak((call) =>
        call.url === DEVICE_URL
          ? {
              body: {
                device_code: "d",
                user_code: "U",
                verification_uri: "https://x/device",
                expires_in: 10,
              },
            }
          : { body: tokens(1) },
      );
      const cb = callbacks({ onSelect: async () => "device" });
      await createLogin(testConfig(), { net: kc.net, headless: "container", sleep: async () => {} })(cb);
      expect(cb.onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({ openBrowserOnConfirm: false }));
    });

    it("fails clearly when the user denies or the code expires", async () => {
      const denied = fakeKeycloak((call) =>
        call.url === DEVICE_URL
          ? { body: { device_code: "d", user_code: "U", verification_uri: "https://x", expires_in: 600 } }
          : { status: 400, body: { error: "access_denied" } },
      );
      await expect(
        createLogin(testConfig(), { net: denied.net, sleep: async () => {} })(
          callbacks({ onSelect: async () => "device" }),
        ),
      ).rejects.toThrow(/access_denied/);

      const expired = fakeKeycloak((call) =>
        call.url === DEVICE_URL
          ? { body: { device_code: "d", user_code: "U", verification_uri: "https://x", expires_in: 10 } }
          : { status: 400, body: { error: "authorization_pending" } },
      );
      await expect(
        createLogin(testConfig(), { net: expired.net, sleep: async (ms) => void expired.advance(ms) })(
          callbacks({ onSelect: async () => "device" }),
        ),
      ).rejects.toThrow(/expired/);
    });
  });

  it("never logs codes, verifiers or tokens during a login", async () => {
    const kc = fakeKeycloak(() => ({ body: tokens(1) }));
    const cb = callbacks({
      onSelect: async () => "paste",
      onManualCodeInput: async () => "secret-auth-code-123456",
    });
    await createLogin(testConfig({ callbackPort: 49170 }), { net: kc.net })(cb);
    const all = logs.join("\n");
    expect(all).toContain("paste login succeeded");
    expect(all).not.toContain("secret-auth-code");
    expect(all).not.toContain(kc.calls[0]!.form.get("code_verifier")!);
    expect(all).not.toMatch(/access-1|refresh-1/);
  });

  describe("Oh My Pi callbacks (no onSelect, no onDeviceCode)", () => {
    const deviceKeycloak = () =>
      fakeKeycloak((call) =>
        call.url === DEVICE_URL
          ? {
              body: {
                device_code: "d",
                user_code: "WXYZ-1234",
                verification_uri: `${ISSUER}/device`,
                verification_uri_complete: `${ISSUER}/device?user_code=WXYZ-1234`,
                expires_in: 60,
              },
            }
          : { body: tokens(3) },
      );
    /** Callbacks shaped like Oh My Pi's interactive /login. */
    const ompCallbacks = (overrides: Parameters<typeof callbacks>[0] = {}) => {
      const { onAuth, onPrompt, onProgress, onManualCodeInput } = callbacks(overrides);
      return { onAuth, onPrompt, onProgress, onManualCodeInput };
    };

    it("asks the method with onPrompt; Enter keeps the recommended one", async () => {
      const cb = ompCallbacks({ onPrompt: vi.fn(async () => "") });
      await createLogin(testConfig(), {
        headless: "SSH session",
        net: deviceKeycloak().net,
        sleep: async () => {},
      })(cb);
      const prompt = cb.onPrompt.mock.calls[0]![0];
      expect(prompt).toMatchObject({ allowEmpty: true, placeholder: "device" });
      expect(prompt.message).toContain("device, browser, paste");
    });

    it("shows the device code with its URL through onAuth on a desktop", async () => {
      const kc = deviceKeycloak();
      const cb = ompCallbacks({ onPrompt: vi.fn(async () => "d") });
      const creds = await createLogin(testConfig(), { net: kc.net, sleep: async () => {} })(cb);
      expect(creds.access).toBe("access-3");
      expect(cb.onAuth).toHaveBeenCalledWith({
        url: `${ISSUER}/device?user_code=WXYZ-1234`,
        instructions: expect.stringContaining("WXYZ-1234"),
      });
    });

    it("prints the device code through onProgress when headless", async () => {
      const cb = ompCallbacks({ onPrompt: vi.fn(async () => "") });
      await createLogin(testConfig(), {
        headless: "container",
        net: deviceKeycloak().net,
        sleep: async () => {},
      })(cb);
      expect(cb.onAuth).not.toHaveBeenCalled();
      expect(cb.onProgress).toHaveBeenCalledWith(expect.stringContaining("WXYZ-1234"));
    });

    it("a refused method prompt (Oh My Pi RPC mode) falls back to the recommended method", async () => {
      const kc = deviceKeycloak();
      const cb = ompCallbacks({
        onPrompt: vi.fn(async () => Promise.reject(new Error("not supported in RPC"))),
      });
      const creds = await createLogin(testConfig(), {
        headless: "SSH session",
        net: kc.net,
        sleep: async () => {},
      })(cb);
      expect(creds.access).toBe("access-3");
    });

    it("a cancelled method prompt cancels the login", async () => {
      const controller = new AbortController();
      const cb = ompCallbacks({
        onPrompt: vi.fn(async () => {
          controller.abort();
          throw new Error("Login cancelled");
        }),
      });
      await expect(createLogin(testConfig())({ ...cb, signal: controller.signal })).rejects.toThrow(
        /cancelled/,
      );
    });

    it("rejects an unknown method", async () => {
      const cb = ompCallbacks({ onPrompt: vi.fn(async () => "carrier pigeon") });
      await expect(createLogin(testConfig())(cb)).rejects.toThrow(/Unknown login method/);
    });

    it("loginMethod skips the choice on any host", async () => {
      const cb = callbacks();
      await createLogin(testConfig({ loginMethod: "device" }), {
        net: deviceKeycloak().net,
        sleep: async () => {},
      })(cb);
      expect(cb.onSelect).not.toHaveBeenCalled();
      expect(cb.onDeviceCode).toHaveBeenCalled();
    });
  });
});
