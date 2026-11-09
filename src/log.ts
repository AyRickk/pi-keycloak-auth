/**
 * Leveled logger with a fixed `[keycloak-auth]` prefix.
 *
 * The level comes from `PI_KC_LOG` (`silent|error|warn|info|debug`, default `warn`)
 * and is re-read on every call, so it can be changed without reloading.
 *
 * Secrets (access tokens, refresh tokens, authorization codes, device codes, PKCE
 * verifiers) must never reach this logger verbatim: pass them through {@link redact}.
 * As a second line of defence every message is scrubbed of anything that looks like
 * a JWT or a long opaque token before it is written.
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
type ActiveLevel = Exclude<LogLevel, "silent">;

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
export const LOG_PREFIX = "[keycloak-auth]";
export const LOG_ENV = "PI_KC_LOG";

export type LogSink = Record<ActiveLevel, (line: string) => void>;

export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  enabled(level: ActiveLevel): boolean;
}

export function parseLogLevel(value: string | undefined): LogLevel {
  const v = value?.trim().toLowerCase();
  if (v && v in RANK) return v as LogLevel;
  return "warn";
}

/** Show at most a short suffix of a secret so log lines stay correlatable. */
export function redact(secret: string | undefined): string {
  if (!secret) return "<none>";
  if (secret.length < 16) return "<redacted>";
  return `<redacted …${secret.slice(-4)}>`;
}

// JWTs (three base64url segments starting with "eyJ") and long opaque tokens; path
// segments (preceded by "/") are left alone.
const JWT = /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g;
const OPAQUE = /(?<![\w/-])[\w-]{40,}(?![\w-])/g;

/** Remove anything that looks like a token from a log line. */
export function scrub(message: string): string {
  return message.replace(JWT, "<redacted-jwt>").replace(OPAQUE, (m) => redact(m));
}

const consoleSink: LogSink = {
  error: (line) => console.error(line),
  warn: (line) => console.warn(line),
  info: (line) => console.info(line),
  debug: (line) => console.debug(line),
};

export function createLogger(
  sink: LogSink = consoleSink,
  level: () => LogLevel = () => parseLogLevel(process.env[LOG_ENV]),
): Logger {
  const enabled = (l: ActiveLevel) => RANK[level()] >= RANK[l];
  const at = (l: ActiveLevel) => (message: string) => {
    if (enabled(l)) sink[l](`${LOG_PREFIX} ${l}: ${scrub(message)}`);
  };
  return { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug"), enabled };
}

export const log: Logger = createLogger();
