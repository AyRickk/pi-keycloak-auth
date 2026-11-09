# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
