/** Host types, derived from the public `ProviderConfig` (type-only, erased at build). */
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

export type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
export type OAuthProviderConfig = NonNullable<ProviderConfig["oauth"]>;
export type OAuthLoginCallbacks = Parameters<OAuthProviderConfig["login"]>[0];
export type OAuthCredentials = Awaited<ReturnType<OAuthProviderConfig["login"]>>;
