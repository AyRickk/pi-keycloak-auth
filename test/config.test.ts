import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configPath, loadConfig, MODEL_DEFAULTS } from "../src/config.js";

const ENV_MIN = {
  PI_KC_ISSUER: "https://sso.example.test/realms/dev/",
  PI_KC_CLIENT_ID: "pi-cli",
  PI_KC_BASE_URL: "https://llm.example.test/v1",
  PI_KC_MODELS: "model-a, model-b",
};

const load = (env: Record<string, string | undefined>, file?: unknown) =>
  loadConfig({ env, readFile: () => (file === undefined ? undefined : JSON.stringify(file)) });

describe("config", () => {
  it("reads only the global file in pi's agent directory", () => {
    const readFile = vi.fn(() => undefined);
    loadConfig({ env: {}, readFile });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(join(homedir(), ".pi", "agent", "keycloak-auth.json"));
    expect(configPath({ PI_CODING_AGENT_DIR: "/srv/pi" })).toBe("/srv/pi/keycloak-auth.json");
    expect(configPath({ PI_CODING_AGENT_DIR: "~/alt" })).toBe(join(homedir(), "alt", "keycloak-auth.json"));
  });

  it("builds a complete config from the environment with defaults", () => {
    const result = load(ENV_MIN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      providerId: "keycloak",
      issuer: "https://sso.example.test/realms/dev",
      clientId: "pi-cli",
      scopes: ["openid", "offline_access"],
      callbackHost: "127.0.0.1",
      callbackPort: 49170,
      redirectPath: "/callback",
      refreshLeewaySeconds: 30,
      browserTimeoutSeconds: 300,
      headers: {},
    });
    expect(result.config.models).toEqual([
      expect.objectContaining({
        id: "model-a",
        name: "model-a",
        ...MODEL_DEFAULTS,
        input: ["text"],
        reasoning: false,
      }),
      expect.objectContaining({ id: "model-b" }),
    ]);
  });

  it("the file wins over the environment, field by field", () => {
    const result = load(
      { ...ENV_MIN, PI_KC_PROVIDER_ID: "from-env", PI_KC_CALLBACK_PORT: "1234" },
      {
        clientId: "from-file",
        callbackPort: 0,
        models: [{ id: "big", name: "Big", contextWindow: 200000, maxTokens: 8000, reasoning: true }],
      },
    );
    if (!result.ok) throw result.error;
    expect(result.config.clientId).toBe("from-file");
    expect(result.config.providerId).toBe("from-env");
    expect(result.config.callbackPort).toBe(0);
    expect(result.config.models).toEqual([
      expect.objectContaining({
        id: "big",
        name: "Big",
        contextWindow: 200000,
        maxTokens: 8000,
        reasoning: true,
      }),
    ]);
  });

  it("always requests openid; offline_access is on by default and can be disabled", () => {
    const on = load({ ...ENV_MIN, PI_KC_SCOPES: "profile,email" });
    const off = load({ ...ENV_MIN, PI_KC_SCOPES: "offline_access profile", PI_KC_OFFLINE_ACCESS: "false" });
    if (!on.ok || !off.ok) throw new Error("unexpected");
    expect(on.config.scopes).toEqual(["openid", "profile", "email", "offline_access"]);
    expect(off.config.scopes).toEqual(["openid", "profile"]);
  });

  it("parses static headers from the environment and rejects Authorization", () => {
    const ok = load({ ...ENV_MIN, PI_KC_HEADERS: "X-Client=pi, X-Team=core" });
    if (!ok.ok) throw ok.error;
    expect(ok.config.headers).toEqual({ "X-Client": "pi", "X-Team": "core" });
    const bad = load(ENV_MIN, { headers: { Authorization: "Bearer x" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.fields).toEqual(["headers"]);
  });

  it("names every missing field, models included (no default model)", () => {
    const result = load({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.fields).toEqual(["issuer", "clientId", "baseUrl", "models"]);
    expect(result.error.message).toContain("PI_KC_MODELS");
    expect(result.providerId).toBe("keycloak");
  });

  it("keeps the provider id and models in error mode", () => {
    const result = load({ PI_KC_PROVIDER_ID: "corp", PI_KC_MODELS: "m" });
    if (result.ok) throw new Error("expected error mode");
    expect(result.providerId).toBe("corp");
    expect(result.models.map((m) => m.id)).toEqual(["m"]);
    expect(result.error.fields).toEqual(["issuer", "clientId", "baseUrl"]);
  });

  it.each([
    [{ PI_KC_CALLBACK_PORT: "70000" }, "callbackPort"],
    [{ PI_KC_REFRESH_LEEWAY_SECONDS: "-1" }, "refreshLeewaySeconds"],
    [{ PI_KC_BROWSER_TIMEOUT_SECONDS: "abc" }, "browserTimeoutSeconds"],
    [{ PI_KC_OFFLINE_ACCESS: "maybe" }, "offlineAccess"],
    [{ PI_KC_ISSUER: "ftp://x" }, "issuer"],
    [{ PI_KC_BASE_URL: "not a url" }, "baseUrl"],
  ])("reports invalid values: %o", (env, field) => {
    const result = load({ ...ENV_MIN, ...env });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.fields).toEqual([field]);
  });

  it("reports an unreadable config file by name", () => {
    const result = loadConfig({ env: ENV_MIN, readFile: () => "{ not json" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.fields).toEqual(["keycloak-auth.json"]);
  });

  it("validates model entries", () => {
    const result = load(ENV_MIN, { models: [{ name: "no id" }, { id: "x", maxTokens: 0 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/non-empty "id".*maxTokens/s);
  });
});
