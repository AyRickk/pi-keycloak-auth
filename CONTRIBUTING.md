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

Node ≥ 22.19 (`.nvmrc` pins the minimum).

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

## Pull requests

- One topic per pull request; describe the user-visible change and link the issue.
- Add or update tests with the change; run the end-to-end suite when login or refresh
  behavior changes.
- Update the README or `docs/` when behavior or configuration changes, and add a line under
  `## [Unreleased]` in `CHANGELOG.md`.
- Keep commit messages short and imperative ("Fix device polling interval").
- CI must be green: typecheck, lint, format, unit and host tests on Linux and macOS with Node
  22.19 and 24, bundle and package checks, then end-to-end and real pi checks.

## Releases

Maintainers only.

1. Move the `Unreleased` entries of `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD`
   heading and update the comparison links at the bottom.
2. Set `"version": "X.Y.Z"` in `package.json` and run `npm install --package-lock-only`.
3. Commit, then tag and push: `git tag vX.Y.Z && git push origin main vX.Y.Z`.
4. The release workflow checks that the tag matches `package.json` and the changelog, runs
   every test including the end-to-end suite, publishes to npm with provenance through trusted
   publishing (environment `npm`), and creates the GitHub release with `pi-keycloak-auth.js`,
   the `.tgz`, `SHA256SUMS`, and the changelog section as notes.
