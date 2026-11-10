/**
 * Model discovery: `GET <baseUrl>/models` on the OpenAI-compatible gateway, authenticated
 * with the Keycloak access token, merged with the declared models.
 *
 * The OpenAI list only carries ids, so a discovered model takes its metadata (context
 * window, output limit, reasoning, input, cost, compat) from the declared model with the
 * same id, else the documented defaults. Declared models the gateway no longer lists are
 * dropped: the gateway decides what exists, the configuration only describes it.
 */
import { defaultModelSpec, type ModelSpec } from "./config.js";
import { describe } from "./errors.js";
import { log } from "./log.js";
import type { Net } from "./oidc.js";

/** The gateway refused or failed the model list request. */
export class ModelListError extends Error {
  override readonly name = "ModelListError";
}

export interface ModelListRequest {
  baseUrl: string;
  accessToken: string;
  headers: Record<string, string>;
}

/** Model ids served by the gateway, in its order, without duplicates. */
export async function fetchModelIds(
  request: ModelListRequest,
  net: Net,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = `${request.baseUrl}/models`;
  log.debug(`GET ${url}`);
  let response: Response;
  let text: string;
  try {
    response = await net.fetch(url, {
      method: "GET",
      headers: {
        ...request.headers,
        accept: "application/json",
        authorization: `Bearer ${request.accessToken}`,
      },
      ...(signal ? { signal } : {}),
    });
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new ModelListError(`Could not reach the gateway at ${url}: ${describe(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new ModelListError(`The gateway answered HTTP ${response.status} to GET ${url}.`);
  }
  let data: unknown;
  try {
    data = (JSON.parse(text) as { data?: unknown }).data;
  } catch {
    throw new ModelListError(`GET ${url} did not return JSON.`);
  }
  if (!Array.isArray(data)) {
    throw new ModelListError(`GET ${url} did not return an OpenAI model list ({ "data": [...] }).`);
  }
  const ids = new Set<string>();
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }
  return [...ids];
}

/** Discovered ids described by the declared model of the same id, else by the defaults. */
export function describeModels(ids: readonly string[], declared: readonly ModelSpec[]): ModelSpec[] {
  const byId = new Map(declared.map((m) => [m.id, m]));
  return ids.map((id) => byId.get(id) ?? defaultModelSpec(id));
}

/** The latest access token seen, for hosts that call discovery without a usable one. */
export interface TokenMemo {
  remember(credentials: { access: string; expires: number }): void;
  /** The remembered token while it has at least `marginMs` left, else undefined. */
  current(marginMs?: number): string | undefined;
}

export function createTokenMemo(now: () => number): TokenMemo {
  let latest: { access: string; expires: number } | undefined;
  return {
    remember: (credentials) => {
      if (!latest || credentials.expires >= latest.expires) {
        latest = { access: credentials.access, expires: credentials.expires };
      }
    },
    current: (marginMs = 10_000) => (latest && latest.expires - now() > marginMs ? latest.access : undefined),
  };
}
