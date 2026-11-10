/** Builds the `pi.registerProvider()` configuration, in normal or error mode. */
import type {
  LoginCallbacks,
  OAuthCredentials,
  ProviderConfig,
  ProviderModelConfig,
  RefreshModelsContext,
} from "./pi-types.js";
import type { ConfigResult, KeycloakConfig, ModelSpec } from "./config.js";
import { headlessReason } from "./environment.js";
import { describe } from "./errors.js";
import { createLogin, type LoginDeps } from "./login.js";
import { log } from "./log.js";
import { createTokenMemo, describeModels, fetchModelIds } from "./models.js";
import { defaultNet } from "./oidc.js";
import { createRefresher, type RefresherDeps } from "./refresh.js";

/** Reserved TLD (RFC 2606): never resolves, so no request can leave in error mode. */
export const NOT_CONFIGURED_URL = "https://not-configured.invalid";

export interface ProviderDeps extends LoginDeps, RefresherDeps {}

const toModels = (models: readonly ModelSpec[]): ProviderModelConfig[] =>
  models.map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    ...(m.compat ? { compat: m.compat } : {}),
  }));

type Persisted = NonNullable<Parameters<RefreshModelsContext["publish"]>[0]["persist"]>;

/** Fields pi adds to a stored model, absent from a `ProviderModelConfig`. */
const HOST_MODEL_FIELDS = new Set(["provider", "api", "baseUrl", "type"]);

/** pi: the catalog persisted by an earlier discovery, so offline starts know the models. */
function restoredModels(context: RefreshModelsContext, providerId: string): ProviderModelConfig[] {
  const stored = (context.stored?.models ?? []) as unknown as readonly Record<string, unknown>[];
  return stored
    .filter((m) => m["provider"] === providerId && typeof m["id"] === "string")
    .map(
      (m) =>
        Object.fromEntries(
          Object.entries(m).filter(([key]) => !HOST_MODEL_FIELDS.has(key)),
        ) as unknown as ProviderModelConfig,
    );
}

export function buildProvider(result: ConfigResult, deps: ProviderDeps = {}): ProviderConfig {
  if (!result.ok) {
    const fail = (): never => {
      throw result.error;
    };
    return {
      name: "Keycloak (not configured)",
      api: "openai-completions",
      baseUrl: NOT_CONFIGURED_URL,
      models: toModels(result.models),
      oauth: {
        name: "Keycloak (not configured)",
        login: async () => fail(),
        refreshToken: async () => fail(),
        getApiKey: () => fail(),
      },
    };
  }

  const { config } = result;
  const net = deps.net ?? defaultNet;
  const memo = createTokenMemo(net.now);
  const login = createLogin(config, { headless: headlessReason(), ...deps });
  const refresh = createRefresher(config, deps);
  const remember = <T extends OAuthCredentials>(credentials: T): T => {
    memo.remember(credentials);
    return credentials;
  };

  return {
    name: `Keycloak (${config.providerId})`,
    api: "openai-completions",
    baseUrl: config.baseUrl,
    ...(Object.keys(config.headers).length > 0 ? { headers: config.headers } : {}),
    models: toModels(config.models),
    ...(config.discoverModels ? discovery(config, deps, memo) : {}),
    oauth: {
      name: "Keycloak",
      login: async (callbacks: LoginCallbacks) => remember(await login(callbacks)),
      // Oh My Pi passes no signal.
      refreshToken: async (credentials: OAuthCredentials, signal?: AbortSignal) =>
        remember(await refresh(credentials, signal)),
      // The Keycloak access token itself goes to the gateway as the Bearer token.
      getApiKey: (credentials: OAuthCredentials) => remember(credentials).access,
    },
  };
}

/** Both hosts' model hooks; each host ignores the other one. */
function discovery(
  config: KeycloakConfig,
  deps: ProviderDeps,
  memo: ReturnType<typeof createTokenMemo>,
): Pick<ProviderConfig, "refreshModels" | "fetchDynamicModels"> {
  const net = deps.net ?? defaultNet;
  const discover = async (accessToken: string, signal?: AbortSignal) => {
    try {
      const ids = await fetchModelIds(
        { baseUrl: config.baseUrl, accessToken, headers: config.headers },
        net,
        signal,
      );
      const models = describeModels(ids, config.models);
      log.info(`discovered ${models.length} model(s) for ${config.providerId}: ${ids.join(", ")}`);
      return models;
    } catch (error) {
      if (!signal?.aborted) log.warn(`model discovery for ${config.providerId} failed: ${describe(error)}`);
      throw error;
    }
  };

  return {
    // pi: called offline first (stored catalog, unrefreshed credential), then online with a
    // credential pi has just refreshed. A failure keeps the previous list.
    refreshModels: async (context) => {
      if (!context.allowNetwork) {
        const restored = restoredModels(context, config.providerId);
        return restored.length > 0 ? restored : toModels(config.models);
      }
      const credential = context.credential;
      if (credential?.type !== "oauth") return toModels(config.models);
      memo.remember(credential);
      const models = toModels(await discover(credential.access, context.signal));
      const persist = {
        models: models.map((m) => ({
          ...m,
          provider: config.providerId,
          api: "openai-completions",
          baseUrl: config.baseUrl,
        })),
        checkedAt: Date.now(),
      } as unknown as Persisted;
      await context.publish({ persist });
      return models;
    },
    // Oh My Pi: the key is the stored access token, never refreshed for discovery, so it is
    // usually missing at startup with short-lived tokens. Throwing keeps its cached list.
    fetchDynamicModels: async (apiKey) => {
      const token = apiKey ?? memo.current();
      if (!token) {
        throw new Error(
          `No valid Keycloak access token for ${config.providerId} yet: keeping the cached model list.`,
        );
      }
      return toModels(await discover(token));
    },
  };
}
