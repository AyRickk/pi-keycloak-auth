/** Builds the `pi.registerProvider()` configuration, in normal or error mode. */
import type { OAuthCredentials, OAuthLoginCallbacks, ProviderConfig } from "./pi-types.js";
import type { ConfigResult, ModelSpec } from "./config.js";
import { headlessReason } from "./environment.js";
import { createLogin, type LoginDeps } from "./login.js";
import { createRefresher, type RefresherDeps } from "./refresh.js";

/** Reserved TLD (RFC 2606): never resolves, so no request can leave in error mode. */
export const NOT_CONFIGURED_URL = "https://not-configured.invalid";

export interface ProviderDeps extends LoginDeps, Omit<RefresherDeps, "net"> {}

const toModels = (models: ModelSpec[]): NonNullable<ProviderConfig["models"]> =>
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
  const login = createLogin(config, { headless: headlessReason(), ...deps });
  const refresh = createRefresher(config, { ...deps, ...(deps.net ? { net: deps.net } : {}) });
  return {
    name: `Keycloak (${config.providerId})`,
    api: "openai-completions",
    baseUrl: config.baseUrl,
    ...(Object.keys(config.headers).length > 0 ? { headers: config.headers } : {}),
    models: toModels(config.models),
    oauth: {
      name: "Keycloak",
      login: (callbacks: OAuthLoginCallbacks) => login(callbacks),
      refreshToken: (credentials: OAuthCredentials, signal?: AbortSignal) => refresh(credentials, signal),
      // The Keycloak access token itself goes to the gateway as the Bearer token.
      getApiKey: (credentials: OAuthCredentials) => credentials.access,
    },
  };
}
