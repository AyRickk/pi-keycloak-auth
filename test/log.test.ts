import { describe, expect, it, vi } from "vitest";
import { createLogger, parseLogLevel, redact, scrub, type LogLevel } from "../src/log.js";

const sink = () => {
  const lines: string[] = [];
  const write = (line: string) => void lines.push(line);
  return { lines, sink: { error: write, warn: write, info: write, debug: write } };
};

describe("log", () => {
  it("defaults to warn and accepts the five levels", () => {
    expect(parseLogLevel(undefined)).toBe("warn");
    expect(parseLogLevel("nonsense")).toBe("warn");
    for (const l of ["silent", "error", "warn", "info", "debug"])
      expect(parseLogLevel(` ${l.toUpperCase()} `)).toBe(l);
  });

  it.each<[LogLevel, number]>([
    ["silent", 0],
    ["error", 1],
    ["warn", 2],
    ["info", 3],
    ["debug", 4],
  ])("level %s writes %i of 4 lines, prefixed", (level, count) => {
    const { lines, sink: s } = sink();
    const log = createLogger(s, () => level);
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(lines).toHaveLength(count);
    for (const line of lines) expect(line).toMatch(/^\[keycloak-auth\] (error|warn|info|debug): /);
  });

  it("reads PI_KC_LOG at call time", () => {
    const { lines, sink: s } = sink();
    const log = createLogger(s);
    vi.stubEnv("PI_KC_LOG", "silent");
    log.error("hidden");
    vi.stubEnv("PI_KC_LOG", "debug");
    log.debug("shown");
    expect(lines).toEqual(["[keycloak-auth] debug: shown"]);
  });

  it("redact keeps at most a 4-char suffix", () => {
    expect(redact(undefined)).toBe("<none>");
    expect(redact("short")).toBe("<redacted>");
    expect(redact("abcdefghijklmnopqrstuvwxyz")).toBe("<redacted …wxyz>");
  });

  it("leaves long path segments readable", () => {
    const path = "/tmp/-Users-someone-Documents-2-Projects-very-long-folder-name/keycloak-auth.json";
    expect(scrub(`loaded ${path}`)).toBe(`loaded ${path}`);
    expect(scrub(`refresh_token=${"a1".repeat(30)}`)).toBe("refresh_token=<redacted …a1a1>");
  });

  it("scrubs JWTs and long opaque tokens from any message", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
    const opaque = "x".repeat(50);
    const out = scrub(`token ${jwt} and ${opaque} end`);
    expect(out).toBe(`token <redacted-jwt> and <redacted …xxxx> end`);
    const { lines, sink: s } = sink();
    createLogger(s, () => "debug").warn(`leak ${jwt}`);
    expect(lines[0]).not.toContain("eyJ");
  });
});
