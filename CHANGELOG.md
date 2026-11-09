# Changelog

## 0.1.0

First release.

- Keycloak login for pi with Authorization Code + PKCE (automatic redirect capture or pasted
  redirect URL) and Device Authorization Grant with PKCE.
- Offline tokens by default; automatic refresh through pi with a configurable leeway,
  in-process single-flight, 60 s rotation grace cache, and graceful handling of transient errors.
- OpenAI-compatible provider with statically declared models and optional static headers.
- Configuration from `~/.pi/agent/keycloak-auth.json` and `PI_KC_*` variables; error mode that
  names missing fields.
- Single-file bundle with no runtime dependency.
