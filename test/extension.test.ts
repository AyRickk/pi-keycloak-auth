import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import keycloakAuth from "../src/index.js";
import type { ExtensionAPI, ProviderConfig } from "../src/pi-types.js";
import { loadConfig } from "../src/config.js";
import { buildProvider, NOT_CONFIGURED_URL } from "../src/provider.js";
import { callbacks, captureConsole, fakeKeycloak } from "./helpers.js";

type Handler = (event: unknown, ctx: unknown) => void;

/** Loads the extension against a stub pi API with an isolated agent directory. */
function loadExtension(config: unknown, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kc-ext-"));
  if (config !== undefined) writeFileSync(join(dir, "keycloak-auth.json"), JSON.stringify(config));
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const registered: { id: string; config: ProviderConfig }[] = [];
  const handlers = new Map<string, Handler>();
  const pi = {
    registerProvider: (id: string, cfg: ProviderConfig) => registered.push({ id, config: cfg }),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  keycloakAuth(pi);
  const notify = vi.fn();
  handlers.get("session_start")?.({ type: "session_start" }, { hasUI: true, ui: { notify } });
  return { registered, notify };
}

const FULL = {
  issuer: "https://sso.example.test/realms/dev",
  clientId: "pi-cli",
  baseUrl: "https://llm.example.test/v1",
  headers: { "X-Client": "pi" },
  models: ["m1"],
};

describe("extension", () => {
  let logs: string[];
  beforeEach(() => {
    vi.stubEnv("PI_KC_LOG", "warn");
    for (const k of Object.keys(process.env))
      if (k.startsWith("PI_KC_") && k !== "PI_KC_LOG") vi.stubEnv(k, "");
    logs = captureConsole();
  });

  it("registers an OpenAI-compatible provider with static headers and models", () => {
    const { registered, notify } = loadExtension(FULL);
    expect(registered).toHaveLength(1);
    const { id, config } = registered[0]!;
    expect(id).toBe("keycloak");
    expect(config).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://llm.example.test/v1",
      headers: { "X-Client": "pi" },
    });
    expect(
      config.models?.map((m) => [
        m.id,
        "contextWindow" in m && m.contextWindow,
        "maxTokens" in m && m.maxTokens,
      ]),
    ).toEqual([["m1", 128000, 16384]]);
    expect(config.oauth?.getApiKey({ access: "the-access-token", refresh: "r", expires: 0 })).toBe(
      "the-access-token",
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("honours a custom provider id", () => {
    expect(loadExtension({ ...FULL, providerId: "corp-llm" }).registered[0]!.id).toBe("corp-llm");
  });

  it("incomplete config: still registered, in error mode, naming the missing fields", async () => {
    const { registered, notify } = loadExtension({ issuer: FULL.issuer });
    expect(registered).toHaveLength(1);
    const { id, config } = registered[0]!;
    expect(id).toBe("keycloak");
    expect(config.name).toMatch(/not configured/);
    expect(config.baseUrl).toBe(NOT_CONFIGURED_URL);
    expect(new URL(config.baseUrl!).hostname.endsWith(".invalid")).toBe(true);
    await expect(config.oauth!.login(callbacks())).rejects.toThrow(/clientId, baseUrl\./);
    await expect(
      config.oauth!.refreshToken({ access: "a", refresh: "r", expires: 0 }, new AbortController().signal),
    ).rejects.toThrow(/not configured/);
    expect(() => config.oauth!.getApiKey({ access: "a", refresh: "r", expires: 0 })).toThrow(
      /not configured/,
    );
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/clientId, baseUrl\./), "error");
    expect(logs.some((l) => l.startsWith("[keycloak-auth] warn:") && l.includes("error mode"))).toBe(true);
  });

  it("error mode never touches the network", async () => {
    const kc = fakeKeycloak(() => ({ body: {} }));
    const provider = buildProvider(loadConfig({ env: {}, readFile: () => undefined }), { net: kc.net });
    await provider.oauth!.login(callbacks({ onSelect: async () => "device" })).catch(() => {});
    await provider
      .oauth!.refreshToken({ access: "a", refresh: "r", expires: 0 }, new AbortController().signal)
      .catch(() => {});
    expect(kc.fetch).not.toHaveBeenCalled();
  });

  it("invalid_grant during a refresh is pushed to the pi UI", async () => {
    const kc = fakeKeycloak(() => ({ status: 400, body: { error: "invalid_grant" } }));
    const notify = vi.fn();
    const result = loadConfig({ env: {}, readFile: () => JSON.stringify(FULL) });
    const provider = buildProvider(result, { net: kc.net, notify });
    await expect(
      provider.oauth!.refreshToken({ access: "a", refresh: "r", expires: 0 }, new AbortController().signal),
    ).rejects.toThrow(/\/login keycloak/);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Run /login keycloak"));
  });
});
