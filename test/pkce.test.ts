import { describe, expect, it } from "vitest";
import { challengeFor, createPkce, createState, stateMatches } from "../src/pkce.js";

describe("pkce", () => {
  it("matches the RFC 7636 appendix B test vector", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates a 43-char base64url verifier with its S256 challenge", () => {
    const pkce = createPkce();
    expect(pkce.method).toBe("S256");
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toBe(challengeFor(pkce.verifier));
    expect(createPkce().verifier).not.toBe(pkce.verifier);
  });

  it("creates unpredictable states and compares them strictly", () => {
    const state = createState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(createState()).not.toBe(state);
    expect(stateMatches(state, state)).toBe(true);
    expect(stateMatches(state, `${state}x`)).toBe(false);
    expect(stateMatches(state, null)).toBe(false);
    expect(stateMatches(state, "")).toBe(false);
  });
});
