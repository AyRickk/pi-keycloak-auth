# Architecture

How the extension plugs into pi, what pi does on its own, and what the extension adds. Facts
about pi below were verified in the pi 1.5.0 source and with tests that run the extension
inside pi's real auth pipeline (`test/host/`).

## Modules

| File                     | Role                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `src/index.ts`           | Extension entry: loads the configuration, registers the provider, wires UI notifications |
| `src/config.ts`          | Global config file + `PI_KC_*` environment, validation, error mode details               |
| `src/provider.ts`        | Builds the `pi.registerProvider()` configuration (normal or error mode)                  |
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

## Error mode

With a missing or invalid setting the provider is still registered, named
_Keycloak (not configured)_, pointing at `https://not-configured.invalid`, and its `login`,
`refreshToken` and `getApiKey` throw the message listing the bad fields, without any network
call. The message is also shown when a pi session starts.

## Test layers

| Layer      | Command                            | Scope                                                                          |
| ---------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| Unit       | `npm test`                         | every module; injected `fetch` and clock; loopback sockets only                |
| Host       | `npm run test:host`                | the provider in pi's real auth pipeline and file store                         |
| End-to-end | `npm run test:e2e`                 | real Keycloak: three logins, real expiry, strict rotation, SSO session expiry  |
| Real pi    | `python3 test/pi/real-pi-check.py` | the pi terminal UI end to end, with a gateway that logs the Bearer it receives |
