# pi-keycloak-auth

Keycloak sign-in for the [pi coding agent](https://pi.dev). Log in once with your company
SSO, then keep working for days: pi sends a short-lived Keycloak **access token** to your
OpenAI-compatible LLM gateway and refreshes it automatically, without a restart or a new login.

- **Three login methods**, all for a _public_ client with PKCE (S256), never a client secret:
  - browser with automatic capture of the redirect on a loopback port;
  - browser with copy-paste of the redirect URL (when the port is busy or unreachable);
  - device code (RFC 8628, with PKCE), offered first over SSH, in containers and in CI.
- **Offline tokens** (`offline_access`) by default, so a session survives nights and weekends.
- **Automatic refresh** driven by pi, de-duplicated so that rotated refresh tokens never cause
  spurious `invalid_grant`, with the current token kept through Keycloak or network hiccups.
- **OpenAI-compatible provider** (`openai-completions`) with statically declared models and
  optional static headers.
- **Zero runtime dependency**: Node built-ins and the global `fetch` only. One 32 KiB file.

| Tested with                            | Version                            |
| -------------------------------------- | ---------------------------------- |
| pi (`@earendil-works/pi-coding-agent`) | **1.5.0**                          |
| Node.js                                | **≥ 22.19** (pi's own requirement) |
| Keycloak                               | 26.4                               |

## Installation

Pick one of the three modes; the extension behaves the same with each.

**1. From npm**

```sh
pi install npm:pi-keycloak-auth
```

**2. From a local path or an offline tarball** (air-gapped machines)

The package has no dependencies, so nothing is downloaded at install time. pi installs
_directories_, not `.tgz` files, so extract the tarball first:

```sh
# on a connected machine:  npm pack pi-keycloak-auth   (or take the .tgz attached to a GitHub release)
tar -xzf pi-keycloak-auth-<version>.tgz          # creates ./package
pi install ./package                             # or: pi install /path/to/a/clone (after npm run build)
```

> `pi install ./pi-keycloak-auth-<version>.tgz` reports success but the extension then fails to
> load with `Unknown file extension ".tgz"`: always install the extracted directory.

**3. Single file**

Download `pi-keycloak-auth.js` from a GitHub release and drop it into pi's extension folder:

```sh
mkdir -p ~/.pi/agent/extensions
cp pi-keycloak-auth.js ~/.pi/agent/extensions/
```

## Configuration

Create `~/.pi/agent/keycloak-auth.json` (pi's agent directory: `$PI_CODING_AGENT_DIR` if set):

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

Then run `pi`, `/login keycloak`, and `/model` to pick a model.

### Options

| Option (file)           | Environment                     | Default      | Meaning                                                                                 |
| ----------------------- | ------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| `issuer`                | `PI_KC_ISSUER`                  | **required** | Realm URL, `https://<host>/realms/<realm>`                                              |
| `clientId`              | `PI_KC_CLIENT_ID`               | **required** | Public client id                                                                        |
| `baseUrl`               | `PI_KC_BASE_URL`                | **required** | OpenAI-compatible base URL (the one ending in `/v1`)                                    |
| `models`                | `PI_KC_MODELS`                  | **required** | Models served by the gateway, see below                                                 |
| `providerId`            | `PI_KC_PROVIDER_ID`             | `keycloak`   | pi provider id: `/login <providerId>`, `<providerId>/<model>`                           |
| `scopes`                | `PI_KC_SCOPES`                  | `openid`     | Extra scopes (array, or space/comma separated). `openid` is always sent                 |
| `offlineAccess`         | `PI_KC_OFFLINE_ACCESS`          | `true`       | Adds the `offline_access` scope                                                         |
| `headers`               | `PI_KC_HEADERS`                 | none         | Static request headers. Env form: `X-Client=pi,X-Team=core`. `Authorization` is refused |
| `callbackHost`          | `PI_KC_CALLBACK_HOST`           | `127.0.0.1`  | Loopback address of the redirect listener                                               |
| `callbackPort`          | `PI_KC_CALLBACK_PORT`           | `49170`      | Its port; `0` picks a free one                                                          |
| `redirectPath`          | `PI_KC_REDIRECT_PATH`           | `/callback`  | Path of the redirect URI                                                                |
| `refreshLeewaySeconds`  | `PI_KC_REFRESH_LEEWAY_SECONDS`  | `30`         | Refresh once the access token has less than this left                                   |
| `browserTimeoutSeconds` | `PI_KC_BROWSER_TIMEOUT_SECONDS` | `300`        | How long the browser login waits for the redirect                                       |
| —                       | `PI_KC_LOG`                     | `warn`       | `silent`, `error`, `warn`, `info` or `debug`                                            |

**Precedence**: for each option, the file wins over the environment, which wins over the
default. Only this global file is read: no project-level configuration is ever consulted, so
a repository cannot redirect your tokens to another issuer or gateway.

### Models

Models are always declared by you; nothing is discovered and there is no default model.

- In the file, each entry is a string (the id) or an object with `id` and optionally `name`,
  `contextWindow`, `maxTokens`, `reasoning`, `input` (`["text"]` or `["text", "image"]`),
  `cost` (`{ input, output, cacheRead, cacheWrite }` per million tokens) and `compat` (pi's
  OpenAI compatibility flags, passed through).
- `PI_KC_MODELS` takes ids only, comma separated (`PI_KC_MODELS=qwen3-coder,gpt-oss-120b`), and
  applies these defaults: `contextWindow` **128000**, `maxTokens` **16384**, `input: ["text"]`,
  `reasoning: false`, cost 0. Use the file to set real values.

### Incomplete configuration

The provider is still registered, as **Keycloak (not configured)**, so it never silently
disappears. `/login`, requests and the startup notification all name the missing or invalid
fields, e.g. `invalid or missing clientId, baseUrl, models`. In this mode the provider points at
`https://not-configured.invalid` (a reserved name that never resolves) and makes no request.

## Logging in

`/login keycloak` asks how to sign in:

| Method                          | When                                                            | What happens                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Browser, captured automatically | desktop (default)                                               | pi opens the login page; after sign-in the browser lands on a local page that reads _Authentication complete_ and tries to close itself |
| Browser, paste the redirect URL | the callback port cannot be used                                | after sign-in the browser fails to load `http://127.0.0.1:…`; copy that URL from the address bar into pi (the bare `code` also works)   |
| Device code                     | SSH, containers, CI, Linux without display (listed first there) | open the URL on any device, enter the code                                                                                              |

Without a local browser, pi is never asked to open one: URLs are printed instead. If the
callback port is taken, the browser method switches to the paste method by itself. Starting a
new login releases the port held by an abandoned one.

On a fresh pi setup, pi then prints `Logged in to Keycloak (keycloak), but no default model is
configured for provider "keycloak". Use /model to select a model.`: this is expected, pick a
model with `/model` (or set `defaultProvider`/`defaultModel` in pi's settings).

Credentials are stored by pi in `~/.pi/agent/auth.json` (mode `0600`).

## Keycloak client setup

Create one client for pi in the realm:

1. **Client type** OpenID Connect, **Client authentication off** (public client).
2. **Authentication flow**: _Standard flow_ on, _OAuth 2.0 Device Authorization Grant_ on.
   Implicit flow, direct access grants and service accounts off.
3. **Advanced → Proof Key for Code Exchange Code Challenge Method**: `S256`. With it,
   Keycloak also requires PKCE on the device grant; this extension always sends it.
4. **Valid redirect URIs**: `http://127.0.0.1:49170/callback` (match `callbackHost`,
   `callbackPort` and `redirectPath`). With `callbackPort: 0` add `http://127.0.0.1/*`:
   Keycloak accepts any port for loopback redirect URIs.
5. **Client scopes**: `offline_access` as an _Optional_ scope (the default). Users need the
   `offline_access` realm role; it is part of `default-roles-<realm>`.
6. **Advanced → Access Token Lifespan**: **10–15 minutes** is recommended (see below).
7. **Realm → Sessions → Offline Session Idle**: how long pi may stay unused before a new login
   is needed (30 days by default). SSO session idle/max no longer matter with offline tokens.

**Why an access token lifespan above 5 minutes.** pi refreshes a token as soon as it has less
than **five minutes** left; this window is fixed in pi. With Keycloak's default 5-minute
lifespan every request falls inside it. The extension then skips the Keycloak call while the
token still has more than `refreshLeewaySeconds` left, but pi still takes its lock on
`auth.json` and rewrites the file on every request (measured: about 0.5 ms and one file write
per request, zero Keycloak calls). With 10–15 minutes, most requests skip all of that.

## What the gateway receives

```
Authorization: Bearer <Keycloak access token>
X-Client: pi                      (static headers you configured)
```

It is the **access token** (a JWT with `typ: "Bearer"`), never the ID token, so a gateway
that already validates Keycloak tokens needs no change. Validate it against the realm's JWKS
(`<issuer>/protocol/openid-connect/certs`) and check:

| Claim                                                  | Expected value                                                                                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iss`                                                  | the realm URL (`issuer`)                                                                                                                                                                |
| `aud`                                                  | your gateway's audience. Keycloak only adds it with an **Audience** mapper on the client (or a client scope): _Included Custom Audience_ = e.g. `llm-gateway`, _Add to access token_ on |
| `azp`                                                  | the pi client id                                                                                                                                                                        |
| `exp`                                                  | in the future                                                                                                                                                                           |
| `realm_access.roles`, `resource_access.<client>.roles` | the roles your gateway authorizes (from the `roles` client scope)                                                                                                                       |
| `scope`                                                | contains `offline_access` when offline tokens are in use                                                                                                                                |

## How the refresh works

- pi asks for request credentials before each call. When the stored access token has less than
  five minutes left, pi takes a **file lock on `auth.json`**, re-checks, calls the extension,
  then **persists the returned token pair** before releasing the lock. Several pi processes
  therefore never redeem the same refresh token twice.
- The extension calls Keycloak only when less than `refreshLeewaySeconds` (30 s) are left;
  otherwise it hands back the current token unchanged.
- Within one process, concurrent refreshes of the same refresh token share **one** Keycloak
  call, and the result is remembered (in memory, never logged) for **60 s**: a caller still
  holding the just-rotated refresh token gets the new pair instead of an `invalid_grant`.
- **Network errors, 5xx, 429 and timeouts**: the current access token keeps being used while it
  is valid; the refresh is retried on the next request.
- **`invalid_grant`** (offline session revoked or idle too long): the request fails with
  `Keycloak session expired for "keycloak" (invalid_grant): … Run /login keycloak to sign in
again.`, also shown as a notification.
- Nothing runs in the background. After a night with pi left open, the first request of the
  morning refreshes the token, and works.

## Logs

Lines are prefixed with `[keycloak-auth]` and written to stderr. `PI_KC_LOG` selects the
level: `silent`, `error`, `warn` (default), `info`, `debug`. Tokens, refresh tokens,
authorization codes and PKCE verifiers are never logged; anything token-shaped that reaches a
log line is masked down to its last four characters at most. In pi's interactive view, log
lines appear above the editor; keep `warn` for daily use and `debug` for troubleshooting.

## Troubleshooting

| Symptom                                                                        | Cause and fix                                                                                                                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_allowed: Offline tokens not allowed for the user or client`               | The user lacks the `offline_access` role, or the scope is not assigned to the client. Fix the realm, or set `offlineAccess: false` (sessions then end with the SSO session) |
| `invalid_grant` after some idle time                                           | Offline session expired or revoked (or `offlineAccess: false` and the SSO session ended): `/login keycloak`                                                                 |
| Keycloak page: _Invalid parameter: redirect_uri_                               | Add the exact redirect URI (or `http://127.0.0.1/*` for `callbackPort: 0`) to the client                                                                                    |
| `unauthorized_client` on the device method                                     | Enable _OAuth 2.0 Device Authorization Grant_ on the client                                                                                                                 |
| `Port 49170 on 127.0.0.1 is already in use`                                    | Another program holds the port: the login falls back to pasting. Or set `callbackPort: 0`                                                                                   |
| Provider shows as _Keycloak (not configured)_                                  | Read the message: it lists the missing fields and the config file path                                                                                                      |
| `no default model is configured for provider "keycloak"` after the first login | Expected on a fresh setup: run `/model`                                                                                                                                     |
| `Unknown file extension ".tgz"`                                                | Install the extracted tarball directory, not the `.tgz`                                                                                                                     |
| Gateway returns 401                                                            | Check `aud`, `iss` and roles in your gateway's logs against the claims table above; the extension never logs tokens                                                         |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
