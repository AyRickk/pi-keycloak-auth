/** PKCE (RFC 7636, S256 only) and anti-CSRF `state` helpers. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** 32 random bytes → a 43-char base64url verifier (RFC 7636 §4.1). */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier), method: "S256" };
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createState(): string {
  return randomBytes(24).toString("base64url");
}

/** Constant-time comparison of the `state` echoed by the authorization server. */
export function stateMatches(expected: string, received: string | null | undefined): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
