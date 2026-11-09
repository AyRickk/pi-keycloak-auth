# pi-keycloak-auth

[![CI](https://github.com/AyRickk/pi-keycloak-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/AyRickk/pi-keycloak-auth/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-keycloak-auth)](https://www.npmjs.com/package/pi-keycloak-auth)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.19-brightgreen)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/AyRickk/pi-keycloak-auth/badge)](https://scorecard.dev/viewer/?uri=github.com/AyRickk/pi-keycloak-auth)

Keycloak sign-in for the [pi coding agent](https://pi.dev). Log in once with your
organization's SSO, then keep working for days: pi sends a short-lived Keycloak **access
token** to your OpenAI-compatible LLM gateway and refreshes it automatically, with no restart
and no new login.

- **Three login methods** for a public client with PKCE (S256), never a client secret:
  browser with automatic redirect capture, browser with a pasted redirect URL, and device code
  (RFC 8628) for SSH sessions, containers and CI.
- **Offline tokens** by default: a session survives nights, weekends and SSO session expiry.
- **Automatic refresh** through pi, safe with single-use (rotated) refresh tokens, and resilient
  to Keycloak or network hiccups.
- **OpenAI-compatible provider** with models you declare and optional static headers.
- **No runtime dependency**: Node built-ins and the global `fetch`. One 32 KiB file, installable
  offline.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Logging in](#logging-in)
- [Keycloak client](#keycloak-client)
- [What the gateway receives](#what-the-gateway-receives)
- [Token refresh](#token-refresh)
- [Logs](#logs)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Contributing](#contributing)

## Requirements

| Component                              | Version                            |
| -------------------------------------- | ---------------------------------- |
| pi (`@earendil-works/pi-coding-agent`) | tested with **1.5.0**              |
| Node.js                                | **≥ 22.19** (pi's own requirement) |
| Keycloak                               | 22 or later, tested with **26.4**  |

## Quick start

1. Ask your Keycloak admin for a public client set up as in [Keycloak client](#keycloak-client).
2. Install the extension:

   ```sh
   pi install npm:pi-keycloak-auth
   ```

3. Create `~/.pi/agent/keycloak-auth.json`:

   ```json
   {
     "issuer": "https://sso.example.com/realms/engineering",
     "clientId": "pi",
     "baseUrl": "https://llm-gateway.example.com/v1",
     "models": ["qwen3-coder"]
   }
   ```

4. Start `pi`, run `/login keycloak`, sign in, then pick the model with `/model`.

## Installation

Pick the mode that fits your environment; the extension behaves the same with each.

### From npm

```sh
pi install npm:pi-keycloak-auth            # latest
pi install npm:pi-keycloak-auth@0.1.0      # pinned
```

### From a local directory or an offline tarball

The package has no dependencies, so nothing is downloaded at install time. pi installs
directories, not `.tgz` files: extract the tarball first.

```sh
# on a connected machine: npm pack pi-keycloak-auth, or take the .tgz from a GitHub release
tar -xzf pi-keycloak-auth-<version>.tgz        # creates ./package
pi install ./package
```

`pi install ./pi-keycloak-auth-<version>.tgz` reports success, but the extension then fails to
load with `Unknown file extension ".tgz"`: always install the extracted directory. A clone of
this repository works too, after `npm ci && npm run build`.

### As a single file

Each [GitHub release](https://github.com/AyRickk/pi-keycloak-auth/releases) ships
`pi-keycloak-auth.js` (with `SHA256SUMS`). Drop it into pi's extension folder:

```sh
mkdir -p ~/.pi/agent/extensions
cp pi-keycloak-auth.js ~/.pi/agent/extensions/
```

Update or remove the extension with `pi update` / `pi remove` in the first two modes, or by
replacing or deleting the file in the third.

## Configuration

Settings come from `~/.pi/agent/keycloak-auth.json` (inside `$PI_CODING_AGENT_DIR` when that is
set) and from `PI_KC_*` environment variables. **For each option the file wins over the
environment, which wins over the default.**

Only this global file is read. Project-level configuration is never consulted, so a repository
you open cannot send your tokens to another issuer or gateway.

```json
{
  "issuer": "https://sso.example.com/realms/engineering",
  "clientId": "pi",
  "baseUrl": "https://llm-gateway.example.com/v1",
  "headers": { "X-Client": "pi" },
  "models": [
    { "id": "qwen3-coder", "name": "Qwen3 Coder", "contextWindow": 262144, "maxTokens": 32768 },
    { "id": "gpt-oss-120b", "reasoning": true }
  ]
}
```

| Option (file)           | Environment                     | Default      | Meaning                                                                                 |
| ----------------------- | ------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| `issuer`                | `PI_KC_ISSUER`                  | **required** | Realm URL, `https://<host>/realms/<realm>`                                              |
| `clientId`              | `PI_KC_CLIENT_ID`               | **required** | Public client id                                                                        |
| `baseUrl`               | `PI_KC_BASE_URL`                | **required** | Gateway base URL, the one ending in `/v1`                                               |
| `models`                | `PI_KC_MODELS`                  | **required** | Models served by the gateway, see [Models](#models)                                     |
| `providerId`            | `PI_KC_PROVIDER_ID`             | `keycloak`   | pi provider id: `/login <providerId>`, `<providerId>/<model>`                           |
| `scopes`                | `PI_KC_SCOPES`                  | `openid`     | Extra scopes, array or space/comma separated. `openid` is always sent                   |
| `offlineAccess`         | `PI_KC_OFFLINE_ACCESS`          | `true`       | Adds the `offline_access` scope                                                         |
| `headers`               | `PI_KC_HEADERS`                 | none         | Static request headers. Env form: `X-Client=pi,X-Team=core`. `Authorization` is refused |
| `callbackHost`          | `PI_KC_CALLBACK_HOST`           | `127.0.0.1`  | Loopback address of the redirect listener                                               |
| `callbackPort`          | `PI_KC_CALLBACK_PORT`           | `49170`      | Its port; `0` picks a free one                                                          |
| `redirectPath`          | `PI_KC_REDIRECT_PATH`           | `/callback`  | Path of the redirect URI                                                                |
| `refreshLeewaySeconds`  | `PI_KC_REFRESH_LEEWAY_SECONDS`  | `30`         | Call Keycloak once the access token has less than this left                             |
| `browserTimeoutSeconds` | `PI_KC_BROWSER_TIMEOUT_SECONDS` | `300`        | How long a browser login waits for the redirect                                         |
| —                       | `PI_KC_LOG`                     | `warn`       | `silent`, `error`, `warn`, `info` or `debug`                                            |

### Models

Models are always declared by you: nothing is discovered and there is no default model.

- **In the file**, each entry is a string (the id) or an object with `id` and optionally
  `name`, `contextWindow`, `maxTokens`, `reasoning`, `input` (`["text"]` or
  `["text", "image"]`), `cost` (`{ input, output, cacheRead, cacheWrite }` in dollars per
  million tokens) and `compat` (pi's OpenAI compatibility flags, passed through as is).
- **`PI_KC_MODELS`** takes ids only, comma separated (`PI_KC_MODELS=qwen3-coder,gpt-oss-120b`),
  with these defaults: `contextWindow` **128000**, `maxTokens` **16384**, `input: ["text"]`,
  `reasoning: false`, cost 0. Use the file to set real values.

### Incomplete configuration

The provider is still registered, as **Keycloak (not configured)**, so it never silently
disappears. pi shows a message at startup, and `/login` and requests fail with it; it names
the missing or invalid fields and the config file, e.g. `invalid or missing clientId, baseUrl,
models`. In this mode the provider points at `https://not-configured.invalid`, a reserved name
that never resolves, and sends nothing anywhere.

## Logging in

`/login keycloak` asks how to sign in:

| Method                                   | Best for                                                        | What happens                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Browser, redirect captured automatically | desktops (listed first)                                         | pi opens the login page; afterwards the browser shows _Authentication complete_ and tries to close the tab                            |
| Browser, paste the redirect URL          | when the callback port cannot be reached                        | after sign-in the browser fails to load `http://127.0.0.1:…`; copy that URL from the address bar into pi (the bare `code` also works) |
| Device code                              | SSH, containers, CI, Linux without display (listed first there) | open the shown URL on any device and confirm the code                                                                                 |

- Without a local browser, pi never tries to open one: URLs are printed instead.
- If the callback port is taken, the browser method switches to the paste method by itself.
- Starting a new login frees the port held by an abandoned one.
- On a brand-new pi setup, pi then prints `Logged in to Keycloak (keycloak), but no default
model is configured for provider "keycloak". Use /model to select a model.` This is expected:
  choose a model with `/model`, or set `defaultProvider` / `defaultModel` in pi's settings.

pi stores the credentials in `~/.pi/agent/auth.json` (mode `0600`). `/logout` removes them.

## Keycloak client

One public client is enough. The full guide, with admin-console steps, a `kcadm.sh` script and
an importable definition, is in [docs/keycloak-setup.md](docs/keycloak-setup.md). In short:

1. **Client authentication off** (public client).
2. **Standard flow** and **OAuth 2.0 Device Authorization Grant** on; everything else off.
3. **PKCE code challenge method `S256`**.
4. **Valid redirect URIs** `http://127.0.0.1:49170/callback` (plus `http://127.0.0.1/*` if
   `callbackPort` is `0`).
5. **`offline_access`** as an optional client scope; users need the `offline_access` role
   (included in `default-roles-<realm>`).
6. An **Audience** mapper adding your gateway's audience to the access token.
7. **Access Token Lifespan of 10–15 minutes.** pi refreshes a token as soon as it has less
   than five minutes left, a threshold fixed in pi. With Keycloak's default 5 minutes every
   request falls inside that window; the extension still calls Keycloak only in the last 30 s,
   but pi locks and rewrites `auth.json` on each of those requests.

## What the gateway receives

```http
Authorization: Bearer <Keycloak access token>
X-Client: pi
```

The bearer is the **access token** (a JWT with `"typ": "Bearer"`), never the ID token, so a
gateway that already validates Keycloak tokens needs no change. Validate it against the realm
keys (`<issuer>/protocol/openid-connect/certs`) and check:

| Claim                                                  | Expected                                                 |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `iss`                                                  | the realm URL                                            |
| `aud`                                                  | your gateway's audience (added by the Audience mapper)   |
| `azp`                                                  | the pi client id                                         |
| `exp`                                                  | in the future                                            |
| `realm_access.roles`, `resource_access.<client>.roles` | the roles your gateway requires                          |
| `scope`                                                | includes `offline_access` when offline tokens are in use |

## Token refresh

- Before each request pi checks the stored token. With less than five minutes left it locks
  `auth.json`, calls the extension, and saves the returned pair before unlocking, so several pi
  processes never redeem the same refresh token twice.
- The extension calls Keycloak only when less than `refreshLeewaySeconds` remain. Concurrent
  refreshes in one process share one call, and each result is remembered in memory for 60
  seconds, so a late caller holding a just-rotated refresh token gets the new pair instead of
  `invalid_grant`.
- Keycloak unreachable, 5xx, 429 or timeout: the current access token keeps being used while it
  is valid, and the refresh is retried on the next request.
- Refresh token rejected (`invalid_grant`, e.g. offline session revoked or idle too long): the
  request fails with `Keycloak session expired for "keycloak" (invalid_grant): … Run /login
keycloak to sign in again.`, also shown as a notification.
- Nothing runs in the background: after a night with pi left open, the first request of the
  morning refreshes the token and goes through.

Details and the request flow: [docs/architecture.md](docs/architecture.md).

## Logs

Log lines start with `[keycloak-auth]` and go to stderr. `PI_KC_LOG` sets the level: `silent`,
`error`, `warn` (default), `info`, `debug`. In pi's interactive view they appear above the
editor, so keep `warn` day to day and use `debug` to troubleshoot.

Tokens, refresh tokens, authorization codes and PKCE verifiers are never logged. As a safety
net, anything token-shaped in a log line is masked to at most its last four characters.

## Troubleshooting

| Symptom                                                          | Cause and fix                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_allowed: Offline tokens not allowed for the user or client` | The user lacks the `offline_access` role, or the scope is not assigned to the client. Fix the realm, or set `offlineAccess: false` (sessions then end with the SSO session)                                                  |
| `invalid_grant` after a long pause                               | Offline session expired or revoked, or SSO session ended with `offlineAccess: false`. Run `/login keycloak`                                                                                                                  |
| Keycloak page _Invalid parameter: redirect_uri_                  | Add the exact redirect URI to the client (or `http://127.0.0.1/*` with `callbackPort: 0`)                                                                                                                                    |
| `unauthorized_client` with the device method                     | Enable _OAuth 2.0 Device Authorization Grant_ on the client                                                                                                                                                                  |
| `Port 49170 on 127.0.0.1 is already in use`                      | Another program holds the port; the login falls back to pasting. Or set `callbackPort: 0`                                                                                                                                    |
| Provider shown as _Keycloak (not configured)_                    | Read the message: it lists the fields to fix and the config file path                                                                                                                                                        |
| `no default model is configured for provider "keycloak"`         | Expected after the first login on a fresh setup: run `/model`                                                                                                                                                                |
| `Unknown file extension ".tgz"`                                  | Install the extracted tarball directory, not the `.tgz`                                                                                                                                                                      |
| Gateway answers 401 or 403                                       | Compare `iss`, `aud` and roles in the gateway logs with [What the gateway receives](#what-the-gateway-receives); [docs/keycloak-setup.md](docs/keycloak-setup.md#checking-the-result) shows how to inspect the token locally |
| Anything else                                                    | `PI_KC_LOG=debug pi`, then [open an issue](https://github.com/AyRickk/pi-keycloak-auth/issues/new/choose) with the log (it contains no secret)                                                                               |

## Security

- Public client with PKCE S256 on every flow and `state` checked on every redirect; no client
  secret exists anywhere.
- The loopback listener binds `127.0.0.1` only, ignores forged redirects, and stops after one
  login or the timeout.
- Credentials are stored by pi with mode `0600`; the extension writes nothing else to disk.
- Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © AyRickk
