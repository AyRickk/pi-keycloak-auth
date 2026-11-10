# Architecture

How the extension plugs into pi, what pi does on its own, and what the extension adds. Facts
about pi below were verified in the pi 1.5.0 source and with tests that run the extension
inside pi's real auth pipeline and model registry (`test/host/`). Oh My Pi (verified with
18.18.6 and `test/omp/real-omp-check.mjs`) loads the same bundle; its differences are in
[Oh My Pi](#oh-my-pi).

## Modules

| File                     | Role                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `src/index.ts`           | Extension entry: loads the configuration, registers the provider, wires UI notifications |
| `src/config.ts`          | Global config file + `PI_KC_*` environment, validation, error mode details               |
| `src/provider.ts`        | Builds the `pi.registerProvider()` configuration (normal or error mode), model hooks     |
| `src/models.ts`          | Model discovery: `GET <baseUrl>/models`, merge with declared models, token memo          |
| `src/login.ts`           | `/login`: method choice, browser (auto-capture / paste) and device flows                 |
| `src/callback-server.ts` | One-shot loopback HTTP server receiving the redirect                                     |
| `src/refresh.ts`         | `refreshToken`: leeway, single-flight, rotation grace, error policy                      |
| `src/oidc.ts`            | Token, refresh and device endpoints over `fetch`                                         |
| `src/pkce.ts`            | PKCE S256 and `state`                                                                    |
| `src/environment.ts`     | Detection of SSH, containers, CI and missing displays                                    |
| `src/log.ts`             | Leveled logger with secret scrubbing                                                     |

The build bundles these into `dist/index.js`; its only imports are `node:` built-ins.

## Registration

The extension calls `pi.registerProvider(providerId, config)` with `api: "openai-completions"`,
the gateway `baseUrl`, optional static `headers`, the configured `models`, and an `oauth`
object with `login`, `refreshToken` and `getApiKey`. pi lists the provider in `/login`, stores
what `login` returns in `~/.pi/agent/auth.json`, and sends `getApiKey(credentials)` (the access
token) as `Authorization: Bearer`.

## Model discovery

With `discoverModels` (the default when no `models` are declared) the provider carries two
hooks; each agent calls its own and ignores the other.

- **pi, `refreshModels(context)`.** pi calls it in two phases. Offline (`allowNetwork: false`,
  every start and after `/login`): the extension returns the catalog it persisted earlier
  (`context.stored`, from `~/.pi/agent/models-store.json`), else the declared models. Online
  (interactive start and `/model`, only with a stored credential): pi has refreshed the OAuth
  credential first, so the extension calls `GET <baseUrl>/models` with that access token,
  persists the result through `context.publish({ persist })` and returns it. A failure rejects
  and pi keeps the previous list. `pi -p` and `--list-models` never run the online phase.
- **Oh My Pi, `fetchDynamicModels(apiKey)`.** Called after `/login` and when its 24-hour
  model cache expires. `apiKey` is the stored access token _without_ refresh, `undefined` once
  expired. The extension then falls back to the latest still-valid token it saw through
  `login`, `refreshToken` or `getApiKey`; with none it throws, which makes Oh My Pi keep its
  cached list (returning `[]` would empty it).

Discovered ids are described by the declared model of the same id, else by the defaults.

## Request flow

```
pi request ──► stored credential has > 5 min left? ── yes ──► Bearer <access token>
                         │ no
                         ▼
               lock auth.json (file lock, cross-process)
               re-read: still < 5 min left? ── no ──► unlock, use the stored token
                         │ yes
                         ▼
               extension refreshToken(credential)
                 ├─ > refreshLeewaySeconds left ─► return it unchanged (no network)
                 ├─ same refresh token redeemed < 60 s ago ─► return that result
                 ├─ same refresh token being redeemed ─► await that call
                 └─ POST /token grant_type=refresh_token
                       ├─ ok ─► new pair
                       ├─ invalid_grant ─► error "Run /login …" + UI notification
                       ├─ network / 5xx / 429 / timeout, token still valid ─► current pair
                       └─ other ─► error
               persist the returned pair, unlock ──► Bearer <access token>
```

What pi guarantees (not reimplemented):

- the refresh runs under a lock on `auth.json`, re-checked under the lock, so concurrent
  requests and several pi processes redeem a refresh token once;
- the returned pair is written before the lock is released (file mode `0600`);
- the refresh call gets a 15-second abort signal and is not cancelled with the user's request,
  so a rotated refresh token is never lost mid-flight.

What the extension adds:

- **leeway**: pi's 5-minute threshold is fixed; Keycloak is only called in the last
  `refreshLeewaySeconds`. pi still locks and rewrites `auth.json` for those requests;
  `test/host/pi-auth-pipeline.test.ts` measures it (~0.5 ms, one write per request);
- **in-process single-flight and 60 s grace cache**, keyed by a SHA-256 digest of the refresh
  token, held in memory only: protection if pi's lock is ever bypassed or a write is lost while
  Keycloak enforces single-use refresh tokens;
- **error policy**: keep serving a still-valid token through transient failures; turn
  `invalid_grant` into an explicit `/login` instruction.

No timer runs in the background: after hours of inactivity the first request refreshes.

## Login methods

| Method    | Grant                                   | Notes                                                                                                                           |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `browser` | Authorization Code + PKCE S256, `state` | loopback server bound before the URL is shown; falls back to `paste` if the port is busy; a new attempt closes an abandoned one |
| `paste`   | same                                    | accepts the full redirect URL (state checked) or the bare code                                                                  |
| `device`  | Device Authorization Grant + PKCE S256  | honours `interval` and `slow_down`; fails on `access_denied` / `expired_token`                                                  |

pi opens a browser for every authorization URL it is given. When no local browser is detected
the extension prints the URL instead, puts the device method first, and asks pi not to open a
browser for the device page.

## Oh My Pi

Oh My Pi reads `pi.extensions` from `package.json` and calls the same `registerProvider`,
`on("session_start" | "session_shutdown")`, `ctx.hasUI` and `ctx.ui.notify`. Differences the
extension handles:

| Topic           | pi                                    | Oh My Pi                                                                           |
| --------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| Agent folder    | `~/.pi/agent`                         | `~/.omp/agent`, `PI_CONFIG_DIR` renames `.omp`, profiles set `PI_CODING_AGENT_DIR` |
| Method choice   | `onSelect` menu                       | no `onSelect`: asked with `onPrompt`; RPC mode refuses it, recommended method used |
| Device code     | `onDeviceCode`                        | no `onDeviceCode`: URL and code through `onAuth` (or `onProgress` headless)        |
| `refreshToken`  | receives an abort signal              | no signal                                                                          |
| Model discovery | `refreshModels`, refreshed credential | `fetchDynamicModels`, unrefreshed stored token                                     |
| Credentials     | `~/.pi/agent/auth.json`               | the agent database under `~/.omp/agent`                                            |

The runtime (Bun for Oh My Pi, Node for pi) decides which agent folder is tried first; the
other is tried second, so a single file serves both.

## Error mode

With a missing or invalid setting the provider is still registered, named
_Keycloak (not configured)_, pointing at `https://not-configured.invalid`, and its `login`,
`refreshToken` and `getApiKey` throw the message listing the bad fields, without any network
call. The message is also shown when a session starts.

## Test layers

| Layer      | Command                            | Scope                                                                          |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| Unit       | `npm test`                         | every module; injected `fetch` and clock; loopback sockets only                |
| Host       | `npm run test:host`                | the provider in pi's real auth pipeline and file store                         |
| End-to-end | `npm run test:e2e`                 | real Keycloak: three logins, real expiry, strict rotation, SSO session expiry  |
| Real pi    | `python3 test/pi/real-pi-check.py` | the pi terminal UI end to end, with a gateway that logs the Bearer it receives |
| Real omp   | `node test/omp/real-omp-check.mjs` | Oh My Pi in RPC mode: both logins, discovery, chat, refresh, restart           |
