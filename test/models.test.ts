import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createTokenMemo, describeModels, fetchModelIds, ModelListError } from "../src/models.js";
import type { Net } from "../src/oidc.js";
import type { RefreshModelsContext } from "../src/pi-types.js";
import { buildProvider } from "../src/provider.js";
import { captureConsole } from "./helpers.js";

const BASE = "https://llm.example.test/v1";
const NOW = 1_700_000_000_000;

/** A fake gateway: answers `GET /models` and records each request. */
function fakeGateway(reply: () => { status?: number; body: unknown } | Error) {
  const requests: { url: string; headers: Headers }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    const r = reply();
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
    });
  });
  const net: Net = { fetch: fetchImpl as unknown as typeof fetch, now: () => NOW };
  return { net, requests };
}

const LIST = { object: "list", data: [{ id: "qwen3-coder" }, { id: "gpt-oss-120b" }, { id: "qwen3-coder" }] };

const providerFor = (file: Record<string, unknown>, net: Net) =>
  buildProvider(
    loadConfig({
      env: {},
      readFile: () =>
        JSON.stringify({
          issuer: "https://sso.example.test/realms/dev",
          clientId: "pi",
          baseUrl: BASE,
          ...file,
        }),
    }),
    { net },
  );

/** A pi refresh context; `publish` records persisted catalogs. */
function piContext(overrides: Partial<RefreshModelsContext> = {}) {
  const published: unknown[] = [];
  const context = {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (publication: { persist?: unknown }) => {
      published.push(publication.persist);
      return true;
    },
    ...overrides,
  } as RefreshModelsContext;
  return { context, published };
}

const oauth = (access: string, expires = NOW + 300_000) =>
  ({ type: "oauth", access, refresh: "r", expires }) as const;

describe("model discovery", () => {
  let logs: string[];
  beforeEach(() => {
    vi.stubEnv("PI_KC_LOG", "debug");
    logs = captureConsole();
  });

  it("GETs <baseUrl>/models with the access token and static headers, ids deduplicated", async () => {
    const gw = fakeGateway(() => ({ body: LIST }));
    const ids = await fetchModelIds(
      { baseUrl: BASE, accessToken: "tok-1", headers: { "X-Client": "pi" } },
      gw.net,
    );
    expect(ids).toEqual(["qwen3-coder", "gpt-oss-120b"]);
    expect(gw.requests[0]!.url).toBe(`${BASE}/models`);
    expect(gw.requests[0]!.headers.get("authorization")).toBe("Bearer tok-1");
    expect(gw.requests[0]!.headers.get("x-client")).toBe("pi");
    expect(logs.join("\n")).not.toContain("tok-1");
  });

  it.each([
    [{ status: 401, body: { error: "unauthorized" } }, /HTTP 401/],
    [{ body: "<html>" }, /did not return JSON/],
    [{ body: { models: [] } }, /OpenAI model list/],
    [new TypeError("fetch failed"), /Could not reach the gateway/],
  ])("fails clearly: %o", async (reply, message) => {
    const gw = fakeGateway(() => reply);
    const attempt = fetchModelIds({ baseUrl: BASE, accessToken: "t", headers: {} }, gw.net);
    await expect(attempt).rejects.toThrow(ModelListError);
    await expect(fetchModelIds({ baseUrl: BASE, accessToken: "t", headers: {} }, gw.net)).rejects.toThrow(
      message,
    );
  });

  it("describes discovered ids with the declared model of the same id, else the defaults", () => {
    const declared = loadConfig({
      env: { PI_KC_ISSUER: "https://x", PI_KC_CLIENT_ID: "c", PI_KC_BASE_URL: BASE },
      readFile: () =>
        JSON.stringify({ models: [{ id: "gpt-oss-120b", reasoning: true, contextWindow: 131072 }] }),
    });
    if (!declared.ok) throw declared.error;
    const models = describeModels(["qwen3-coder", "gpt-oss-120b"], declared.config.models);
    expect(models.map((m) => [m.id, m.reasoning, m.contextWindow])).toEqual([
      ["qwen3-coder", false, 128000],
      ["gpt-oss-120b", true, 131072],
    ]);
  });

  it("the token memo keeps the latest token while it is valid", () => {
    let now = NOW;
    const memo = createTokenMemo(() => now);
    expect(memo.current()).toBeUndefined();
    memo.remember({ access: "a2", expires: NOW + 60_000 });
    memo.remember({ access: "a1", expires: NOW + 30_000 });
    expect(memo.current()).toBe("a2");
    now += 55_000;
    expect(memo.current()).toBeUndefined();
  });

  it("declared models without discoverModels: no model hook at all", () => {
    const provider = providerFor({ models: ["m1"] }, fakeGateway(() => ({ body: LIST })).net);
    expect(provider.refreshModels).toBeUndefined();
    expect(provider.fetchDynamicModels).toBeUndefined();
    expect(provider.models?.map((m) => m.id)).toEqual(["m1"]);
  });

  describe("pi: refreshModels", () => {
    it("online with a refreshed credential: fetches, persists for offline starts, returns the list", async () => {
      const gw = fakeGateway(() => ({ body: LIST }));
      const provider = providerFor({ headers: { "X-Client": "pi" } }, gw.net);
      expect(provider.models).toEqual([]);
      const { context, published } = piContext({ credential: oauth("fresh") });
      const models = await provider.refreshModels!(context);
      expect(models.map((m) => m.id)).toEqual(["qwen3-coder", "gpt-oss-120b"]);
      expect(gw.requests[0]!.headers.get("authorization")).toBe("Bearer fresh");
      expect(published).toEqual([
        expect.objectContaining({
          models: [
            expect.objectContaining({ id: "qwen3-coder", provider: "keycloak", api: "openai-completions" }),
            expect.objectContaining({ id: "gpt-oss-120b", baseUrl: BASE }),
          ],
        }),
      ]);
    });

    it("offline: restores the persisted catalog without the network", async () => {
      const gw = fakeGateway(() => ({ body: LIST }));
      const provider = providerFor({ models: ["fallback"], discoverModels: true }, gw.net);
      const stored = {
        models: [
          {
            id: "qwen3-coder",
            name: "qwen3-coder",
            provider: "keycloak",
            api: "openai-completions",
            type: "chat",
          },
          { id: "elsewhere", provider: "other" },
        ],
      };
      const restored = await provider.refreshModels!(
        piContext({ allowNetwork: false, stored } as unknown as Partial<RefreshModelsContext>).context,
      );
      expect(restored).toEqual([{ id: "qwen3-coder", name: "qwen3-coder" }]);
      const nothingStored = await provider.refreshModels!(piContext({ allowNetwork: false }).context);
      expect(nothingStored.map((m) => m.id)).toEqual(["fallback"]);
      expect(gw.requests).toHaveLength(0);
    });

    it("a gateway failure rejects, so pi keeps the previous list", async () => {
      const gw = fakeGateway(() => ({ status: 503, body: {} }));
      const provider = providerFor({}, gw.net);
      await expect(provider.refreshModels!(piContext({ credential: oauth("t") }).context)).rejects.toThrow(
        /503/,
      );
      expect(logs.some((l) => l.includes("warn:") && l.includes("model discovery"))).toBe(true);
    });
  });

  describe("Oh My Pi: fetchDynamicModels", () => {
    it("uses the key it is given", async () => {
      const gw = fakeGateway(() => ({ body: LIST }));
      const models = await providerFor({}, gw.net).fetchDynamicModels!("stored-token");
      expect(models.map((m) => m.id)).toEqual(["qwen3-coder", "gpt-oss-120b"]);
      expect(gw.requests[0]!.headers.get("authorization")).toBe("Bearer stored-token");
    });

    it("without a key, falls back to the latest valid token the provider has seen", async () => {
      const gw = fakeGateway(() => ({ body: LIST }));
      const provider = providerFor({}, gw.net);
      await expect(provider.fetchDynamicModels!(undefined)).rejects.toThrow(/keeping the cached model list/);
      expect(gw.requests).toHaveLength(0);
      provider.oauth!.getApiKey({ access: "seen", refresh: "r", expires: NOW + 300_000 });
      await provider.fetchDynamicModels!(undefined);
      expect(gw.requests[0]!.headers.get("authorization")).toBe("Bearer seen");
    });
  });
});
