# Contributing

## Project rules

1. **No runtime dependency.** Runtime code imports only `node:` built-ins and relative
   modules, and uses the global `fetch`. Types from `@earendil-works/pi-coding-agent` are
   allowed as `import type` only (erased at build time). ESLint and `npm run check:bundle`
   enforce this: the bundle must import nothing but `node:` modules.
2. **No secret is ever logged.** Access tokens, refresh tokens, authorization codes, device
   codes and PKCE verifiers must not reach a log line, an error message or a test snapshot.
   Use `redact()` when a correlation suffix is genuinely needed. The logger also scrubs
   token-shaped strings, but that is a safety net, not a licence.
3. **Only the user's global configuration is read** (`<agent dir>/keycloak-auth.json` and
   `PI_KC_*`). Never read project-level files: they could redirect tokens elsewhere.
4. **Public client only**: no client secret option, PKCE S256 on every flow.
5. Unit tests use an injected `fetch` and clock: no network and no real timers.

## Setup

Node ≥ 22.19.

```sh
npm ci
npm run build          # dist/index.js, the single-file extension
npm run check:bundle
```

Building offline works once the dev dependencies are in the npm cache
(`npm ci --offline`). Installing the built package never needs the network.

## Checks

```sh
npm run typecheck
npm run lint
npm run format:check
npm test               # unit tests
npm run test:host      # the provider inside pi's real auth pipeline (lock, persistence, cost)
```

### End-to-end against Keycloak

Needs docker or podman. The realm (`test/e2e/keycloak/realm.json`) has 60 s access
tokens, a 60 s / 90 s SSO session, 30-day offline sessions and strict refresh-token rotation.

```sh
./scripts/e2e-keycloak.sh up
npm run test:e2e       # ~2 minutes: waits for real token and SSO session expiry
./scripts/e2e-keycloak.sh down
```

### Real pi check

Drives the actual pi terminal UI (login with the three methods, `/model`, messages, refresh
after expiry, `invalid_grant` after revocation) against the e2e Keycloak and a fake
OpenAI-compatible gateway that logs the `Authorization` header it receives.

```sh
./scripts/e2e-keycloak.sh up
npm run build
python3 -m pip install pyte
python3 test/pi/real-pi-check.py /tmp/real-pi    # prints PASS/FAIL per check, keeps screen captures
```

## Releases

1. Update `version` in `package.json` and `CHANGELOG.md`.
2. Tag `vX.Y.Z` and push the tag. The release workflow checks, builds, publishes to npm with
   provenance (trusted publishing) and attaches `pi-keycloak-auth.js` and the `.tgz` to a
   GitHub release.
