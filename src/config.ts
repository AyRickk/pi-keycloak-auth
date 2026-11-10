/**
 * Configuration: the user's global `keycloak-auth.json`, then `PI_KC_*` environment
 * variables, then defaults. Per field, the file wins.
 *
 * The file is `$PI_KC_CONFIG` when set, otherwise `keycloak-auth.json` in the host's agent
 * directory: `$PI_CODING_AGENT_DIR` when set (both pi and Oh My Pi honour it, and Oh My Pi
 * sets it for named profiles), else `~/.pi/agent` (pi) or `~/.omp/agent` (Oh My Pi, root
 * renamed by `PI_CONFIG_DIR`). The running host's directory is tried first, the other one
 * second, so one file works with both.
 *
 * Project-level configuration is deliberately never read: a repository must not be
 * able to send the user's tokens to another issuer or another gateway.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors.js";

export const CONFIG_FILE_NAME = "keycloak-auth.json";
export const ENV_PREFIX = "PI_KC_";
/** pi's own override of its agent directory (default `~/.pi/agent`). */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/** Full path of the configuration file, bypassing the agent-directory lookup. */
export const CONFIG_PATH_ENV = "PI_KC_CONFIG";
/** Oh My Pi's config root directory name under home (default `.omp`). */
export const OMP_CONFIG_DIR_ENV = "PI_CONFIG_DIR";

export type Host = "pi" | "omp";
/** Oh My Pi runs on Bun, pi on Node: only a preference, both locations are tried. */
export const detectHost = (): Host => (typeof process.versions["bun"] === "string" ? "omp" : "pi");

export const LOGIN_METHODS = ["browser", "paste", "device"] as const;
export type LoginMethod = (typeof LOGIN_METHODS)[number];

export const MODEL_DEFAULTS = { contextWindow: 128_000, maxTokens: 16_384 } as const;

export interface ModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: Record<string, unknown>;
}

/** A model known only by its id, with the documented defaults. */
export function defaultModelSpec(id: string): ModelSpec {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    ...MODEL_DEFAULTS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export interface KeycloakConfig {
  providerId: string;
  issuer: string;
  clientId: string;
  scopes: string[];
  callbackHost: string;
  callbackPort: number;
  redirectPath: string;
  baseUrl: string;
  headers: Record<string, string>;
  /** Declared models: the whole catalog, or overrides and fallback when discovering. */
  models: ModelSpec[];
  /** Fetch the model list from the gateway's `GET <baseUrl>/models` with the access token. */
  discoverModels: boolean;
  /** Skip the method menu of `/login` and always use this method. */
  loginMethod: LoginMethod | undefined;
  refreshLeewaySeconds: number;
  browserTimeoutSeconds: number;
}

export type ConfigResult =
  | { ok: true; config: KeycloakConfig; source: string }
  | { ok: false; providerId: string; error: ConfigError; models: ModelSpec[]; source: string };

type Env = Record<string, string | undefined>;
type Raw = Record<string, unknown>;

export interface LoadOptions {
  env?: Env;
  host?: Host;
  readFile?: (path: string) => string | undefined;
}

const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/** At least one path. */
type Paths = [string, ...string[]];

/** Agent directories to look in, the running host's first. */
export function agentDirs(env: Env = process.env, host: Host = detectHost()): Paths {
  const dir = env[AGENT_DIR_ENV]?.trim();
  if (dir) return [expandHome(dir)];
  const pi = join(homedir(), ".pi", "agent");
  const omp = join(homedir(), env[OMP_CONFIG_DIR_ENV]?.trim() || ".omp", "agent");
  return host === "omp" ? [omp, pi] : [pi, omp];
}

/** Configuration files to try, in order. */
export function configPaths(env: Env = process.env, host: Host = detectHost()): Paths {
  const explicit = env[CONFIG_PATH_ENV]?.trim();
  if (explicit) return [expandHome(explicit)];
  const [first, ...rest] = agentDirs(env, host);
  return [join(first, CONFIG_FILE_NAME), ...rest.map((dir) => join(dir, CONFIG_FILE_NAME))];
}

/** Where the configuration is expected when none exists yet: the first candidate. */
export function configPath(env: Env = process.env, host: Host = detectHost()): string {
  return configPaths(env, host)[0];
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Never throws: an invalid configuration yields `{ ok: false }` naming every bad field. */
export function loadConfig(options: LoadOptions = {}): ConfigResult {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? readOptional;
  const candidates = configPaths(env, options.host);
  let path = candidates[0];
  const problems: { field: string; message: string }[] = [];
  const fail = (field: string, message: string) => problems.push({ field, message });

  let file: Raw = {};
  try {
    let text: string | undefined;
    for (const candidate of candidates) {
      path = candidate;
      text = readFile(candidate);
      if (text !== undefined) break;
    }
    if (text === undefined) path = candidates[0];
    if (text !== undefined && text.trim() !== "") {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      file = parsed as Raw;
    }
  } catch (error) {
    fail(CONFIG_FILE_NAME, `${path} is not valid: ${(error as Error).message}`);
  }

  const fromEnv = (name: string): string | undefined => {
    const value = env[ENV_PREFIX + name]?.trim();
    return value ? value : undefined;
  };
  /** File value, else env value, else undefined. */
  const pick = (key: string, envName: string): unknown => file[key] ?? fromEnv(envName);

  const str = (key: string, envName: string, fallback?: string): string | undefined => {
    const value = pick(key, envName) ?? fallback;
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      fail(key, `"${key}" must be a non-empty string.`);
      return undefined;
    }
    return value.trim();
  };
  const int = (key: string, envName: string, fallback: number, min: number, max: number): number => {
    const value = pick(key, envName) ?? fallback;
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) {
      fail(key, `"${key}" must be an integer between ${min} and ${max}, got ${JSON.stringify(value)}.`);
      return fallback;
    }
    return n;
  };
  const bool = (key: string, envName: string, fallback: boolean): boolean => {
    const value = pick(key, envName) ?? fallback;
    if (typeof value === "boolean") return value;
    const v = String(value).toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
    fail(key, `"${key}" must be true or false, got ${JSON.stringify(value)}.`);
    return fallback;
  };
  const httpUrl = (key: string, envName: string): string | undefined => {
    const value = str(key, envName);
    if (value === undefined) return undefined;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("not http(s)");
      return value.replace(/\/+$/, "");
    } catch {
      fail(key, `"${key}" must be an http(s) URL, got ${JSON.stringify(value)}.`);
      return undefined;
    }
  };

  const providerId = str("providerId", "PROVIDER_ID", "keycloak") ?? "keycloak";
  const issuer = httpUrl("issuer", "ISSUER");
  const clientId = str("clientId", "CLIENT_ID");
  const baseUrl = httpUrl("baseUrl", "BASE_URL");
  const offlineAccess = bool("offlineAccess", "OFFLINE_ACCESS", true);
  const scopes = parseScopes(pick("scopes", "SCOPES"), offlineAccess, fail);
  const callbackHost = str("callbackHost", "CALLBACK_HOST", "127.0.0.1") ?? "127.0.0.1";
  const callbackPort = int("callbackPort", "CALLBACK_PORT", 49170, 0, 65535);
  const redirectPathRaw = str("redirectPath", "REDIRECT_PATH", "/callback") ?? "/callback";
  const redirectPath = redirectPathRaw.startsWith("/") ? redirectPathRaw : `/${redirectPathRaw}`;
  const refreshLeewaySeconds = int("refreshLeewaySeconds", "REFRESH_LEEWAY_SECONDS", 30, 0, 3600);
  const browserTimeoutSeconds = int("browserTimeoutSeconds", "BROWSER_TIMEOUT_SECONDS", 300, 10, 3600);
  const headers = parseHeaders(pick("headers", "HEADERS"), fail);
  const models = parseModels(file["models"] ?? fromEnv("MODELS"), fail);
  const discoverModels = bool("discoverModels", "DISCOVER_MODELS", models.length === 0);
  const loginMethodRaw = str("loginMethod", "LOGIN_METHOD");
  let loginMethod: LoginMethod | undefined;
  if (loginMethodRaw !== undefined) {
    const method = loginMethodRaw.toLowerCase();
    if ((LOGIN_METHODS as readonly string[]).includes(method)) loginMethod = method as LoginMethod;
    else
      fail(
        "loginMethod",
        `"loginMethod" must be ${LOGIN_METHODS.join(", ")}, got ${JSON.stringify(loginMethodRaw)}.`,
      );
  }

  const required: [string, unknown, string][] = [
    ["issuer", issuer, "PI_KC_ISSUER"],
    ["clientId", clientId, "PI_KC_CLIENT_ID"],
    ["baseUrl", baseUrl, "PI_KC_BASE_URL"],
  ];
  if (!discoverModels && models.length === 0 && !problems.some((p) => p.field === "models")) {
    fail("models", `"models" is empty and "discoverModels" is off: declare models or enable discovery.`);
  }
  for (const [field, value, envName] of required) {
    if (value === undefined && !problems.some((p) => p.field === field)) {
      fail(field, `"${field}" is missing (set it in ${path} or ${envName}).`);
    }
  }

  if (problems.length > 0 || !issuer || !clientId || !baseUrl) {
    const fields = [...new Set(problems.map((p) => p.field))];
    const error = new ConfigError(
      `Keycloak auth is not configured: invalid or missing ${fields.join(", ")}. ` +
        problems.map((p) => p.message).join(" "),
      fields,
    );
    return { ok: false, providerId, error, models, source: path };
  }

  return {
    ok: true,
    source: path,
    config: {
      providerId,
      issuer,
      clientId,
      scopes,
      callbackHost,
      callbackPort,
      redirectPath,
      baseUrl,
      headers,
      models,
      discoverModels,
      loginMethod,
      refreshLeewaySeconds,
      browserTimeoutSeconds,
    },
  };
}

type Fail = (field: string, message: string) => void;

function parseScopes(value: unknown, offlineAccess: boolean, fail: Fail): string[] {
  let list: string[] = [];
  if (Array.isArray(value) && value.every((s) => typeof s === "string")) list = value;
  else if (typeof value === "string") list = value.split(/[\s,]+/);
  else if (value !== undefined) fail("scopes", `"scopes" must be a string or an array of strings.`);
  const scopes = new Set(["openid", ...list.map((s) => s.trim()).filter(Boolean)]);
  if (offlineAccess) scopes.add("offline_access");
  else scopes.delete("offline_access");
  return [...scopes];
}

function parseHeaders(value: unknown, fail: Fail): Record<string, string> {
  if (value === undefined) return {};
  const headers: Record<string, string> = {};
  const add = (name: string, v: unknown) => {
    const key = name.trim();
    if (!/^[!#$%&'*+.^`|~\w-]+$/.test(key) || typeof v !== "string") {
      fail("headers", `"headers" has an invalid entry ${JSON.stringify(name)}.`);
      return;
    }
    if (key.toLowerCase() === "authorization") {
      fail("headers", `"headers" must not set Authorization: the Keycloak access token is sent there.`);
      return;
    }
    headers[key] = v.trim();
  };
  if (typeof value === "string") {
    // Environment form: "Name=value,Other=value".
    for (const pair of value.split(",").filter((p) => p.trim())) {
      const i = pair.indexOf("=");
      if (i <= 0)
        fail("headers", `PI_KC_HEADERS entries must look like Name=value, got ${JSON.stringify(pair)}.`);
      else add(pair.slice(0, i), pair.slice(i + 1));
    }
  } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [name, v] of Object.entries(value)) add(name, v);
  } else {
    fail("headers", `"headers" must be an object of strings.`);
  }
  return headers;
}

function parseModels(value: unknown, fail: Fail): ModelSpec[] {
  if (value === undefined) return [];
  const entries: unknown[] = typeof value === "string" ? value.split(",").map((s) => s.trim()) : [];
  if (Array.isArray(value)) entries.push(...(value as unknown[]));
  else if (typeof value !== "string") {
    fail("models", `"models" must be an array.`);
    return [];
  }
  const models: ModelSpec[] = [];
  for (const entry of entries) {
    if (entry === "") continue;
    const raw: Raw = typeof entry === "string" ? { id: entry } : (entry as Raw);
    if (typeof raw !== "object" || raw === null || typeof raw["id"] !== "string" || !raw["id"].trim()) {
      fail("models", `every model needs a non-empty "id", got ${JSON.stringify(entry)}.`);
      continue;
    }
    const id = raw["id"].trim();
    const positive = (key: "contextWindow" | "maxTokens"): number => {
      const v = raw[key] ?? MODEL_DEFAULTS[key];
      if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
      fail("models", `model "${id}": "${key}" must be a positive integer.`);
      return MODEL_DEFAULTS[key];
    };
    const input = raw["input"] ?? ["text"];
    const validInput =
      Array.isArray(input) && input.length > 0 && input.every((i) => i === "text" || i === "image");
    if (!validInput) fail("models", `model "${id}": "input" must list "text" and/or "image".`);
    const cost = (raw["cost"] ?? {}) as Raw;
    const num = (k: string) => (typeof cost[k] === "number" ? (cost[k] as number) : 0);
    const spec: ModelSpec = {
      id,
      name: typeof raw["name"] === "string" && raw["name"].trim() ? raw["name"].trim() : id,
      reasoning: raw["reasoning"] === true,
      input: validInput ? (input as ModelSpec["input"]) : ["text"],
      contextWindow: positive("contextWindow"),
      maxTokens: positive("maxTokens"),
      cost: {
        input: num("input"),
        output: num("output"),
        cacheRead: num("cacheRead"),
        cacheWrite: num("cacheWrite"),
      },
    };
    const compat = raw["compat"];
    if (compat !== undefined) {
      if (typeof compat === "object" && compat !== null && !Array.isArray(compat))
        spec.compat = compat as Raw;
      else fail("models", `model "${id}": "compat" must be an object.`);
    }
    models.push(spec);
  }
  return models;
}

export interface Endpoints {
  authorization: string;
  token: string;
  device: string;
}

export function endpoints(issuer: string): Endpoints {
  const base = `${issuer}/protocol/openid-connect`;
  return { authorization: `${base}/auth`, token: `${base}/token`, device: `${base}/auth/device` };
}

export function redirectUri(
  config: Pick<KeycloakConfig, "callbackHost" | "redirectPath">,
  port: number,
): string {
  const host = config.callbackHost.includes(":") ? `[${config.callbackHost}]` : config.callbackHost;
  return `http://${host}:${port}${config.redirectPath}`;
}
