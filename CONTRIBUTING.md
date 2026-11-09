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
python3 -m pip install --require-hashes -r test/pi/requirements.txt
python3 test/pi/real-pi-check.py /tmp/real-pi    # prints PASS/FAIL per check, keeps screen captures
```

## Pull requests

`main` is protected: every change, including the maintainer's, goes through a pull request.

- Fork the repository (or create a branch if you have write access) and open a pull request
  against `main`. One topic per pull request; link the issue it addresses.
- **The pull request title becomes the commit message**: pull requests are squash-merged, so
  write the title as a short imperative sentence ("Fix device polling interval").
- All required checks must pass: typecheck, lint, format, unit and host tests on Linux and
  macOS with Node 22.19 and 24, bundle and package checks, the end-to-end suite against
  Keycloak and the real pi check. The branch must be up to date with `main`.
- Review conversations must be resolved before merging.
- Add or update tests with the change; update the README or `docs/` when behavior or
  configuration changes, and add a line under `## [Unreleased]` in `CHANGELOG.md`.
- History stays linear: no merge commits, no force pushes to `main`.

## Releases

Maintainers only. Release tags `v*` can only be created by maintainers and can never be moved
or deleted; GitHub releases are immutable once published.

1. Open a pull request titled `Release vX.Y.Z` that moves the `Unreleased` entries of
   `CHANGELOG.md` under `## [X.Y.Z] - YYYY-MM-DD`, updates the comparison links at the bottom,
   and sets `"version": "X.Y.Z"` in `package.json` (`npm version X.Y.Z --no-git-tag-version`
   updates the lockfile too).
2. Once it is merged, tag the merge commit on `main` and push the tag:
   `git switch main && git pull && git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The release workflow checks that the tag matches `package.json` and the changelog, runs
   every test including the end-to-end suite, publishes to npm with provenance through trusted
   publishing (environment `npm`, no token), then creates the GitHub release (draft, assets,
   publish) with `pi-keycloak-auth.js`, the `.tgz`, `SHA256SUMS`, and the changelog section as
   notes.
