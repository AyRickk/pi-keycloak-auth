/**
 * Runs model discovery through pi's real model registry (pi 1.5.0 internals, loaded by path):
 * `createModels` with the file-backed `AuthStorage` and `FileModelsStore`, and the extension
 * composed by `composeModelProvider`. Keycloak and the gateway are faked; no network.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { buildProvider } from "../../src/provider.js";
import { fakeKeycloak, tokens, TOKEN_URL } from "../helpers.js";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const piRoot = join(projectRoot, "node_modules/@earendil-works/pi-coding-agent");
const piAiRoot = join(piRoot, "..", "pi-ai");
const load = (path: string) => import(pathToFileURL(path).href);

const { AuthStorage } = await load(join(piRoot, "dist/core/auth-storage.js"));
const { FileModelsStore } = await load(join(piRoot, "dist/core/models-store.js"));
const { composeModelProvider } = await load(join(piRoot, "dist/core/provider-composer.js"));
const { createModels } = await load(join(piAiRoot, "dist/models.js"));

const BASE = "https://llm.example.test/v1";
const FILE = { issuer: "https://sso.example.test/realms/dev", clientId: "pi-cli", baseUrl: BASE };

type Kc = ReturnType<typeof fakeKeycloak>;

/** A fake Keycloak that also serves the gateway's model list. */
function backend(models: () => { status?: number; body?: unknown }) {
  const kc = fakeKeycloak((call) => (call.url === TOKEN_URL ? { body: tokens(1, 900) } : models()));
  kc.advance(Date.now() - kc.now());
  return kc;
}

/** One "pi process" sharing auth.json and models-store.json with the others. */
function piProcess(dir: string, kc: Kc, file: Record<string, unknown> = {}) {
  const extension = buildProvider(
    loadConfig({ env: {}, readFile: () => JSON.stringify({ ...FILE, ...file }) }),
    {
      net: kc.net,
    },
  );
  const models = createModels({
    credentials: AuthStorage.create(join(dir, "auth.json")),
    modelsStore: new FileModelsStore(join(dir, "models-store.json")),
  });
  models.setProvider(
    composeModelProvider("keycloak", undefined, { getProvider: () => undefined }, extension),
  );
  return {
    refresh: (allowNetwork: boolean) => models.refresh({ allowNetwork, providers: ["keycloak"] }),
    ids: () => (models.getModels("keycloak") as { id: string }[]).map((m) => m.id),
  };
}

function setup(expiresInMs: number | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "kc-models-"));
  if (expiresInMs !== undefined) {
    const credential = {
      type: "oauth",
      access: "access-0",
      refresh: "refresh-0",
      expires: Date.now() + expiresInMs,
    };
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ keycloak: credential }), { mode: 0o600 });
  }
  return dir;
}

const LIST = { body: { object: "list", data: [{ id: "qwen3-coder" }, { id: "gpt-oss-120b" }] } };

describe("pi model discovery (pi 1.5.0)", () => {
  it("expired token: pi refreshes it, then the list is fetched with the new token and persisted", async () => {
    const dir = setup(-1000);
    const kc = backend(() => LIST);
    const pi = piProcess(dir, kc);
    const result = await pi.refresh(true);
    expect([...result.errors.values()]).toEqual([]);
    expect(pi.ids()).toEqual(["qwen3-coder", "gpt-oss-120b"]);
    const list = kc.calls.find((c) => c.url === `${BASE}/models`)!;
    expect(list.authorization).toBe("Bearer access-1");
    expect(kc.calls.findIndex((c) => c.url === TOKEN_URL)).toBeLessThan(kc.calls.indexOf(list));
    const store = JSON.parse(readFileSync(join(dir, "models-store.json"), "utf8"));
    expect(store.keycloak.models.map((m: { id: string }) => m.id)).toEqual(["qwen3-coder", "gpt-oss-120b"]);
  });

  it("a later offline start restores the persisted list without any request", async () => {
    const dir = setup(10 * 60_000);
    await piProcess(
      dir,
      backend(() => LIST),
    ).refresh(true);
    const kc = backend(() => LIST);
    const offline = piProcess(dir, kc);
    await offline.refresh(false);
    expect(offline.ids()).toEqual(["qwen3-coder", "gpt-oss-120b"]);
    expect(kc.calls).toHaveLength(0);
  });

  it("gateway down: the refresh reports an error and the previous list stays", async () => {
    const dir = setup(10 * 60_000);
    await piProcess(
      dir,
      backend(() => LIST),
    ).refresh(true);
    const pi = piProcess(
      dir,
      backend(() => ({ status: 503, body: {} })),
    );
    const result = await pi.refresh(true);
    expect(result.errors.get("keycloak")?.message).toMatch(/503/);
    expect(pi.ids()).toEqual(["qwen3-coder", "gpt-oss-120b"]);
  });

  it("not logged in: declared models only, no request, nothing persisted", async () => {
    const dir = setup(undefined);
    const kc = backend(() => LIST);
    const pi = piProcess(dir, kc, { models: ["declared"], discoverModels: true });
    await pi.refresh(true);
    expect(pi.ids()).toEqual(["declared"]);
    expect(kc.calls).toHaveLength(0);
    const path = join(dir, "models-store.json");
    const stored = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    expect(stored ? JSON.parse(stored).keycloak : undefined).toBeUndefined();
  });
});
