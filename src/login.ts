/**
 * The `/login` flow: the user picks one of three methods.
 *
 * - `browser`: Authorization Code + PKCE, redirect captured by a loopback server.
 *   Falls back to `paste` when the callback port is busy.
 * - `paste`: same request; the user pastes the redirect URL (or just the code).
 * - `device`: Device Authorization Grant (RFC 8628) with PKCE.
 *
 * pi opens a browser for every `onAuth` URL. Without a local browser (SSH, container,
 * CI, no display) the URL is shown through `onProgress` instead, and the device flow
 * is listed first.
 */
import type { OAuthLoginCallbacks } from "./pi-types.js";
import { startCallbackServer, PortInUseError, type CallbackServer } from "./callback-server.js";
import { redirectUri, type KeycloakConfig } from "./config.js";
import { describe } from "./errors.js";
import { log } from "./log.js";
import {
  authorizationUrl,
  defaultNet,
  exchangeCode,
  pollDeviceToken,
  startDeviceAuthorization,
  type Net,
} from "./oidc.js";
import { createPkce, createState, stateMatches } from "./pkce.js";
import { toCredentials, type Credentials } from "./refresh.js";

export type LoginMethod = "browser" | "paste" | "device";

export interface LoginDeps {
  net?: Net;
  /** Why no local browser is available, or undefined on a desktop. */
  headless?: string | undefined;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  schedule?: (fn: () => void, ms: number) => () => void;
}

const LABELS: Record<LoginMethod, string> = {
  browser: "Browser (sign in, redirect captured automatically)",
  paste: "Browser (sign in, then paste the redirect URL)",
  device: "Device code (sign in from any device)",
};

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Login cancelled."));
      },
      { once: true },
    );
  });

export function createLogin(config: KeycloakConfig, deps: LoginDeps = {}) {
  const net = deps.net ?? defaultNet;
  const sleep = deps.sleep ?? realSleep;
  // A newer attempt frees the port held by an abandoned one.
  let activeServer: CallbackServer | undefined;

  const showUrl = (callbacks: OAuthLoginCallbacks, url: string, instructions: string) => {
    if (deps.headless) callbacks.onProgress?.(`${instructions}\nOpen this URL in a browser:\n${url}`);
    else callbacks.onAuth({ url, instructions });
  };

  async function browser(callbacks: OAuthLoginCallbacks): Promise<Credentials> {
    activeServer?.close(new Error("Superseded by a newer login attempt."));
    activeServer = undefined;
    const pkce = createPkce();
    const state = createState();
    let server: CallbackServer;
    try {
      server = await startCallbackServer({
        host: config.callbackHost,
        port: config.callbackPort,
        path: config.redirectPath,
        state,
        timeoutMs: config.browserTimeoutSeconds * 1000,
        ...(callbacks.signal ? { signal: callbacks.signal } : {}),
        ...(deps.schedule ? { schedule: deps.schedule } : {}),
      });
    } catch (error) {
      if (!(error instanceof PortInUseError)) throw error;
      log.warn(`${error.message} Falling back to pasting the redirect URL.`);
      callbacks.onProgress?.(`${error.message} Falling back to pasting the redirect URL.`);
      return paste(callbacks);
    }
    activeServer = server;
    try {
      const uri = redirectUri(config, server.port);
      showUrl(
        callbacks,
        authorizationUrl(config, { redirectUri: uri, state, pkce }),
        "Sign in with Keycloak.",
      );
      const code = await server.code;
      callbacks.onProgress?.("Exchanging the authorization code…");
      return toCredentials(
        await exchangeCode(config, { code, verifier: pkce.verifier, redirectUri: uri }, net),
      );
    } finally {
      server.close();
      if (activeServer === server) activeServer = undefined;
    }
  }

  async function paste(callbacks: OAuthLoginCallbacks): Promise<Credentials> {
    const pkce = createPkce();
    const state = createState();
    const uri = redirectUri(config, config.callbackPort || 49170);
    showUrl(
      callbacks,
      authorizationUrl(config, { redirectUri: uri, state, pkce }),
      "Sign in with Keycloak. The browser then fails to load the redirect page: " +
        "copy the full URL from its address bar and paste it here.",
    );
    const input = (
      callbacks.onManualCodeInput
        ? await callbacks.onManualCodeInput()
        : await callbacks.onPrompt({ message: "Paste the redirect URL (or the authorization code)" })
    ).trim();
    if (!input) throw new Error("No authorization code entered.");
    let code = input;
    if (/^https?:\/\//i.test(input)) {
      const params = new URL(input).searchParams;
      const error = params.get("error");
      if (error) throw new Error(`Keycloak refused the login: ${error}`);
      if (!stateMatches(state, params.get("state"))) {
        throw new Error("The pasted URL does not belong to this login attempt (state mismatch).");
      }
      code = params.get("code") ?? "";
      if (!code) throw new Error("The pasted URL contains no authorization code.");
    }
    callbacks.onProgress?.("Exchanging the authorization code…");
    return toCredentials(
      await exchangeCode(config, { code, verifier: pkce.verifier, redirectUri: uri }, net),
    );
  }

  async function device(callbacks: OAuthLoginCallbacks): Promise<Credentials> {
    const pkce = createPkce();
    const auth = await startDeviceAuthorization(config, pkce, net, callbacks.signal);
    callbacks.onDeviceCode({
      userCode: auth.userCode,
      verificationUri: auth.verificationUriComplete ?? auth.verificationUri,
      openBrowserOnConfirm: !deps.headless,
      intervalSeconds: auth.intervalSeconds,
      expiresInSeconds: Math.max(0, Math.round((auth.expiresAt - net.now()) / 1000)),
    });
    let interval = auth.intervalSeconds;
    while (net.now() < auth.expiresAt) {
      await sleep(interval * 1000, callbacks.signal);
      const poll = await pollDeviceToken(
        config,
        { deviceCode: auth.deviceCode, verifier: pkce.verifier },
        net,
        callbacks.signal,
      );
      if (poll.status === "done") return toCredentials(poll.tokens);
      if (poll.status === "slow_down") interval += 5; // RFC 8628 §3.5
    }
    throw new Error("The device code expired before the sign-in was completed. Run /login again.");
  }

  const flows: Record<LoginMethod, (c: OAuthLoginCallbacks) => Promise<Credentials>> = {
    browser,
    paste,
    device,
  };

  return async function login(callbacks: OAuthLoginCallbacks): Promise<Credentials> {
    const order: LoginMethod[] = deps.headless
      ? ["device", "browser", "paste"]
      : ["browser", "paste", "device"];
    const choice = await callbacks.onSelect({
      message: deps.headless
        ? `Sign in to Keycloak (${deps.headless}: the device code is recommended)`
        : "Sign in to Keycloak",
      options: order.map((id, i) => ({ id, label: i === 0 ? `${LABELS[id]} — recommended` : LABELS[id] })),
    });
    if (!choice) throw new Error("Login cancelled.");
    const flow = flows[choice as LoginMethod];
    if (!flow) throw new Error(`Unknown login method "${choice}".`);
    try {
      const credentials = await flow(callbacks);
      log.info(`${choice} login succeeded for ${config.providerId}`);
      return credentials;
    } catch (error) {
      log.error(`${choice} login failed for ${config.providerId}: ${describe(error)}`);
      throw error;
    }
  };
}
