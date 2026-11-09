# Keycloak setup

This guide creates everything pi needs in a Keycloak realm: one public client, the audience
your gateway expects, and token lifetimes suited to a long-running coding agent. It applies to
Keycloak 22 and later (tested with 26.4).

- [What pi needs](#what-pi-needs)
- [Admin console](#admin-console)
- [Command line (`kcadm.sh`)](#command-line-kcadmsh)
- [Importable client definition](#importable-client-definition)
- [Token and session lifetimes](#token-and-session-lifetimes)
- [Roles and gateway authorization](#roles-and-gateway-authorization)
- [Checking the result](#checking-the-result)

## What pi needs

| Setting                                               | Value                                       | Why                                                                               |
| ----------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| Client authentication                                 | **off** (public client)                     | pi runs on user machines and cannot keep a secret                                 |
| Standard flow                                         | on                                          | browser login (Authorization Code)                                                |
| OAuth 2.0 Device Authorization Grant                  | on                                          | login over SSH, in containers, in CI                                              |
| Implicit flow, direct access grants, service accounts | off                                         | not used                                                                          |
| PKCE code challenge method                            | `S256`                                      | enforced PKCE; Keycloak then also requires it on the device grant, which pi sends |
| Valid redirect URIs                                   | `http://127.0.0.1:49170/callback`           | must match `callbackHost`, `callbackPort`, `redirectPath`                         |
| Optional client scope                                 | `offline_access`                            | sessions that survive nights and weekends                                         |
| Audience mapper                                       | your gateway's audience, e.g. `llm-gateway` | so the gateway can check `aud`                                                    |
| Access token lifespan (client)                        | 10–15 min                                   | see [lifetimes](#token-and-session-lifetimes)                                     |

If users set `callbackPort: 0` (random free port), also add `http://127.0.0.1/*`. Keycloak
treats loopback redirect URIs as port-agnostic, as recommended for native apps by RFC 8252.

## Admin console

1. **Clients → Create client**: type _OpenID Connect_, client ID e.g. `pi`, name `pi`.
2. **Capability config**: _Client authentication_ off. Check _Standard flow_ and _OAuth 2.0
   Device Authorization Grant_; uncheck everything else.
3. **Login settings**: _Valid redirect URIs_ `http://127.0.0.1:49170/callback`. Leave _Web
   origins_ empty.
4. **Advanced → Advanced settings**: _Proof Key for Code Exchange Code Challenge Method_ =
   `S256`; _Access Token Lifespan_ = `10` or `15` minutes.
5. **Client scopes** tab: check that `offline_access` is listed as _Optional_ (default for new
   clients).
6. **Client scopes → `pi-dedicated` → Configure a new mapper → Audience**: name
   `gateway audience`, _Included Custom Audience_ = `llm-gateway` (your gateway's value),
   _Add to access token_ on, _Add to ID token_ off.
7. **Realm settings → Sessions**: _Offline Session Idle_ = how long pi may sit unused before a
   new login (default 30 days). Optionally enable _Offline Session Max Limited_.
8. Users need the `offline_access` realm role. It is part of `default-roles-<realm>`, so new
   users have it; check users imported or created with custom role mappings.

## Command line (`kcadm.sh`)

```sh
REALM=engineering
kcadm.sh config credentials --server https://sso.example.com --realm master --user admin

kcadm.sh create clients -r "$REALM" -f - <<'EOF'
{
  "clientId": "pi",
  "name": "pi",
  "publicClient": true,
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": false,
  "implicitFlowEnabled": false,
  "serviceAccountsEnabled": false,
  "redirectUris": ["http://127.0.0.1:49170/callback"],
  "webOrigins": [],
  "attributes": {
    "pkce.code.challenge.method": "S256",
    "oauth2.device.authorization.grant.enabled": "true",
    "access.token.lifespan": "900"
  },
  "optionalClientScopes": ["offline_access"],
  "protocolMappers": [
    {
      "name": "gateway audience",
      "protocol": "openid-connect",
      "protocolMapper": "oidc-audience-mapper",
      "config": {
        "included.custom.audience": "llm-gateway",
        "access.token.claim": "true",
        "id.token.claim": "false"
      }
    }
  ]
}
EOF
```

## Importable client definition

You can also load the JSON above in the admin console (**Clients → Import client**). The
realm used by this project's end-to-end tests,
[`test/e2e/keycloak/realm.json`](../test/e2e/keycloak/realm.json), is a complete working
example (with deliberately tiny lifetimes).

## Token and session lifetimes

| Setting                               | Recommended       | Effect on pi                                |
| ------------------------------------- | ----------------- | ------------------------------------------- |
| Access Token Lifespan (client)        | 10–15 min         | how long a token sent to the gateway lives  |
| Offline Session Idle (realm)          | 30 days (default) | unused time before `/login` is needed again |
| Offline Session Max (realm, optional) | e.g. 90 days      | absolute limit, regardless of use           |
| SSO Session Idle / Max                | unchanged         | irrelevant once offline tokens are used     |
| Revoke Refresh Token (realm)          | either            | pi handles single-use refresh tokens        |

**Why more than 5 minutes for access tokens.** pi asks for a refresh as soon as a token has
less than five minutes left, and this threshold is fixed in pi. With Keycloak's default
5-minute access tokens every request falls inside that window: the extension avoids calling
Keycloak until the last `refreshLeewaySeconds` (30 s), but pi still locks and rewrites
`~/.pi/agent/auth.json` on each request (about 0.5 ms each). With 10–15 minutes, most
requests skip that entirely and Keycloak sees one refresh per lifespan.

**Without offline tokens** (`offlineAccess: false`, or users without the `offline_access`
role), the refresh token dies with the SSO session: expect a `/login` after the SSO idle
timeout (30 minutes by default) or the SSO max lifespan.

## Roles and gateway authorization

The access token carries the user's roles when the default `roles` client scope is assigned:

- realm roles in `realm_access.roles`;
- client roles in `resource_access.<client-id>.roles`.

To limit gateway access to a group of users, create a role (e.g. realm role `llm-user`),
assign it, and have the gateway require it. Restricting who may log in to the `pi` client
itself needs an authentication-flow condition or a gateway-side check; Keycloak does not do it
by default.

## Checking the result

1. Log in from pi: `/login keycloak`.
2. Inspect the stored access token's claims locally (it never leaves your machine):

   ```sh
   node -e 'const t=require(process.env.HOME+"/.pi/agent/auth.json").keycloak.access;
            console.log(JSON.parse(Buffer.from(t.split(".")[1],"base64url")))'
   ```

3. Check `iss`, `aud` (contains your gateway audience), `azp` (the client id), `scope`
   (contains `offline_access`) and the role claims.
