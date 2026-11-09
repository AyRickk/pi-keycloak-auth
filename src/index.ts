/**
 * pi extension: Keycloak OAuth2/OIDC login for an OpenAI-compatible gateway.
 *
 * Registers one provider (default id `keycloak`) whose `/login` runs a PKCE browser or
 * device flow, and whose access tokens pi refreshes through `oauth.refreshToken`.
 */
import type { ExtensionAPI } from "./pi-types.js";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { buildProvider } from "./provider.js";

export default function keycloakAuth(pi: ExtensionAPI): void {
  const result = loadConfig();
  let notify: ((message: string) => void) | undefined;

  const providerId = result.ok ? result.config.providerId : result.providerId;
  if (!result.ok) {
    log.warn(`provider "${providerId}" registered in error mode: ${result.error.message}`);
  } else {
    log.debug(`loaded ${result.source}: issuer=${result.config.issuer} clientId=${result.config.clientId}`);
  }

  pi.registerProvider(
    providerId,
    buildProvider(result, {
      notify: (message) => notify?.(message),
    }),
  );

  pi.on("session_start", (_event, ctx) => {
    notify = ctx.hasUI ? (message) => ctx.ui.notify(message, "error") : undefined;
    if (!result.ok && ctx.hasUI) ctx.ui.notify(result.error.message, "error");
  });
  pi.on("session_shutdown", () => {
    notify = undefined;
  });
}
