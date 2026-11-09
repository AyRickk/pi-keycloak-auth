# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's
[private vulnerability reporting](https://github.com/AyRickk/pi-keycloak-auth/security/advisories/new),
not in public issues or pull requests.

Include the extension version, your pi and Node versions, your Keycloak version, and a
reproduction if possible. **Never include real tokens, authorization codes, or the contents of
`auth.json`**: redact them.

You can expect an acknowledgement within a week. Once a fix is released, the advisory is
published with credit to the reporter unless you prefer otherwise.

## Scope

In scope: the login flows, the loopback callback listener, token refresh and storage handling,
configuration loading, and anything that could leak a token or send it to an unintended host.

Out of scope: Keycloak, pi itself, and your LLM gateway; please report those to their own
maintainers.
