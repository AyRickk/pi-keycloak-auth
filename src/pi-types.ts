/**
 * Host types, derived from pi's public `ProviderConfig` (type-only, erased at build), plus
 * the differences of Oh My Pi, which loads the same extension through its pi compatibility.
 */
import type { ProviderConfig as PiProviderConfig } from "@earendil-works/pi-coding-agent";

export type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export type OAuthProviderConfig = NonNullable<PiProviderConfig["oauth"]>;
export type OAuthLoginCallbacks = Parameters<OAuthProviderConfig["login"]>[0];
export type OAuthCredentials = Awaited<ReturnType<OAuthProviderConfig["login"]>>;
export type ProviderModelConfig = NonNullable<PiProviderConfig["models"]>[number];
export type RefreshModelsContext = Parameters<NonNullable<PiProviderConfig["refreshModels"]>>[0];

/**
 * Login callbacks as either host provides them. Oh My Pi has no `onSelect` and no
 * `onDeviceCode`, and declares `onPrompt` optional.
 */
export type LoginCallbacks = Omit<OAuthLoginCallbacks, "onSelect" | "onDeviceCode" | "onPrompt"> &
  Partial<Pick<OAuthLoginCallbacks, "onSelect" | "onDeviceCode" | "onPrompt">>;

/**
 * The registered provider: pi's `ProviderConfig` plus Oh My Pi's `fetchDynamicModels`.
 * Each host ignores the other's model hook.
 */
export interface ProviderConfig extends PiProviderConfig {
  /** Oh My Pi: live model list, given the stored access token (never refreshed) or undefined. */
  fetchDynamicModels?: (apiKey: string | undefined) => Promise<readonly ProviderModelConfig[]>;
}
