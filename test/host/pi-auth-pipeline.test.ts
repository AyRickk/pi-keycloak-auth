/**
 * Runs the provider through pi's real auth pipeline (pi 1.5.0 internals, loaded by
 * path because they are not part of pi's public exports): provider composition,
 * `resolveProviderAuth` (5-minute window, refresh under the auth.json file lock,
 * persistence) and the file-backed `AuthStorage`. Keycloak is faked; no network.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { buildProvider } from "../../src/provider.js";
import { fakeKeycloak, tokens } from "../helpers.js";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const piRoot = join(projectRoot, "node_modules/@earendil-works/pi-coding-agent");
const piAiRoot = join(piRoot, "..", "pi-ai");
const load = (path: string) => import(pathToFileURL(path).href);

const { AuthStorage } = await load(join(piRoot, "dist/core/auth-storage.js"));
const { composeModelProvider } = await load(join(piRoot, "dist/core/provider-composer.js"));
const { resolveProviderAuth } = await load(join(piAiRoot, "dist/auth/resolve.js"));

const FILE = {
  issuer: "https://sso.example.test/realms/dev",
  clientId: "pi-cli",
  baseUrl: "https://llm.example.test/v1",
  models: ["m1"],
};
const authContext = { env: async () => undefined, fileExists: async () => false };

/** One "pi process": its own provider instance (own in-memory refresher) and store. */
function piProcess(authPath: string, kc: ReturnType<typeof fakeKeycloak>) {
  const extension = buildProvider(loadConfig({ env: {}, readFile: () => JSON.stringify(FILE) }), {
    net: kc.net,
  });
  const provider = composeModelProvider("keycloak", undefined, { getProvider: () => undefined }, extension);
  const store = AuthStorage.create(authPath);
  return {
    getAuth: async () => (await resolveProviderAuth(provider, store, authContext)).auth.apiKey as string,
  };
}

function seed(expiresInMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "kc-host-"));
  const authPath = join(dir, "auth.json");
  const credential = {
    type: "oauth",
    access: "access-0",
    refresh: "refresh-0",
    expires: Date.now() + expiresInMs,
  };
  writeFileSync(authPath, JSON.stringify({ keycloak: credential }, null, 2), { mode: 0o600 });
  return authPath;
}

const stored = (authPath: string) => JSON.parse(readFileSync(authPath, "utf8")).keycloak;

describe("pi auth pipeline (pi 1.5.0)", () => {
  it("expired token: one refresh, Bearer = new access token, rotated pair persisted", async () => {
    const authPath = seed(-1000);
    const kc = fakeKeycloak(() => ({ body: tokens(1, 900) }));
    kc.advance(Date.now() - kc.now());
    const pi = piProcess(authPath, kc);
    expect(await pi.getAuth()).toBe("access-1");
    expect(kc.calls).toHaveLength(1);
    expect(stored(authPath)).toMatchObject({ type: "oauth", access: "access-1", refresh: "refresh-1" });
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it("two processes refreshing at once: pi's file lock lets only one call Keycloak", async () => {
    const authPath = seed(-1000);
    const kc = fakeKeycloak(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { body: tokens(1, 900) };
    });
    kc.advance(Date.now() - kc.now());
    const [a, b] = [piProcess(authPath, kc), piProcess(authPath, kc)];
    const results = await Promise.all([a.getAuth(), b.getAuth(), a.getAuth(), b.getAuth()]);
    expect(new Set(results)).toEqual(new Set(["access-1"]));
    expect(kc.calls).toHaveLength(1);
    expect(stored(authPath).refresh).toBe("refresh-1");
  });

  it("transient failure: the still-valid token keeps being used and stays stored", async () => {
    const authPath = seed(20_000);
    const kc = fakeKeycloak(() => new TypeError("fetch failed"));
    kc.advance(Date.now() - kc.now());
    expect(await piProcess(authPath, kc).getAuth()).toBe("access-0");
    expect(stored(authPath).refresh).toBe("refresh-0");
  });

  it("measures the cost of the leeway short-circuit (token valid 2 min, inside pi's 5-min window)", async () => {
    const N = 50;
    const measure = async (expiresInMs: number) => {
      const authPath = seed(expiresInMs);
      const kc = fakeKeycloak(() => ({ body: tokens(1, 900) }));
      kc.advance(Date.now() - kc.now());
      const pi = piProcess(authPath, kc);
      await pi.getAuth(); // warm-up
      let writes = 0;
      let last = statSync(authPath).mtimeMs;
      const start = performance.now();
      for (let i = 0; i < N; i++) {
        await pi.getAuth();
        const m = statSync(authPath).mtimeMs;
        if (m !== last) writes++;
        last = m;
      }
      return { perCallMs: (performance.now() - start) / N, writes, keycloakCalls: kc.calls.length };
    };
    const outside = await measure(10 * 60_000); // > 5 min: pi does not call refreshToken
    const inside = await measure(2 * 60_000); // < 5 min, > leeway: lock + rewrite, no Keycloak call
    console.info(
      `[cost] ${N} requests — token valid 10 min: ${outside.perCallMs.toFixed(2)} ms/request, ` +
        `${outside.writes} auth.json writes; token valid 2 min: ${inside.perCallMs.toFixed(2)} ms/request, ` +
        `${inside.writes} auth.json writes, ${inside.keycloakCalls} Keycloak calls`,
    );
    expect(outside.keycloakCalls).toBe(0);
    expect(inside.keycloakCalls).toBe(0);
    expect(outside.writes).toBe(0);
    // pi persists whatever refreshToken returns, even unchanged: one lock + one write per request.
    expect(inside.writes).toBeGreaterThan(0);
    expect(inside.perCallMs).toBeLessThan(50);
  });
});
