# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Oh My Pi support from the same package: the configuration is found in `~/.omp/agent` (or
  `~/$PI_CONFIG_DIR/agent`, or the profile folder through `PI_CODING_AGENT_DIR`), `/login` asks
  the method as text where no menu exists and shows the device code in the login dialog, and
  RPC mode falls back to the recommended method.
- Model discovery: without `models`, or with `discoverModels: true`, the list comes from the
  gateway's `GET <baseUrl>/models` called with the Keycloak access token. Declared models
  describe discovered ones by id. pi keeps the list in `models-store.json` for print mode and
  offline starts; Oh My Pi keeps it in its model cache.
- `PI_KC_CONFIG`: full path of the configuration file.
- `loginMethod` / `PI_KC_LOGIN_METHOD`: skip the method choice of `/login`.

### Changed

- `models` is no longer required.
- The configuration file is looked up in the running agent's folder first, then in the other
  agent's folder.
- The bundle is now 40 KiB (32 KiB before).
- Repository workflow only: pull requests are squash-merged only, and their titles (the commit
  messages on `main`) must follow Conventional Commits, checked in CI. An optional
  `.githooks/commit-msg` hook applies the same rule locally.
- Development tooling: Vitest 5, ESLint 10,
  TypeScript 6.0, esbuild 0.28, GitHub Actions v7, and `minimatch` 11 for the linters. The
  development dependency tree has no known vulnerability.

## [0.1.0] - 2026-11-09

### Added

- Keycloak login for pi: Authorization Code + PKCE S256 with automatic loopback capture or a
  pasted redirect URL, and Device Authorization Grant with PKCE.
- Offline tokens (`offline_access`) by default.
- Automatic refresh through pi with a configurable leeway, in-process single-flight, a 60 s
  rotation grace cache, and continued use of a valid token through transient failures.
- Clear `/login` instruction on `invalid_grant`, also shown as a notification.
- OpenAI-compatible provider with statically declared models and optional static headers.
- Configuration from `~/.pi/agent/keycloak-auth.json` and `PI_KC_*` variables, and an error
  mode that names missing or invalid fields.
- Single-file build with no runtime dependency.

[Unreleased]: https://github.com/AyRickk/pi-keycloak-auth/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AyRickk/pi-keycloak-auth/releases/tag/v0.1.0
