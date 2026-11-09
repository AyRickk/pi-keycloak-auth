## What and why

<!-- What does this change, and why? Link the issue it addresses. -->

## Checklist

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:host` pass
- [ ] `npm run build && npm run check:bundle` pass (no runtime dependency added)
- [ ] No token, refresh token, code or verifier can reach a log line or an error message
- [ ] Tests cover the change; `npm run test:e2e` run if login or refresh behavior changed
- [ ] README / docs and `CHANGELOG.md` (Unreleased) updated when behavior changes
