/**
 * One-shot loopback HTTP server receiving the authorization-code redirect
 * (RFC 8252 §7.3). It validates the path and the `state`, answers with a small page
 * that tries to close its tab, and hands the code to the waiting login flow.
 */
import { createServer, type Server } from "node:http";
import { stateMatches } from "./pkce.js";

export interface CallbackServer {
  /** The bound port (useful when port 0 asked for an ephemeral one). */
  port: number;
  /** Resolves with the authorization code, rejects on error, timeout, abort or close. */
  code: Promise<string>;
  close(reason?: Error): void;
}

export interface CallbackOptions {
  host: string;
  port: number;
  path: string;
  state: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injected for tests; defaults to setTimeout/clearTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export class PortInUseError extends Error {
  override readonly name = "PortInUseError";
  constructor(host: string, port: number) {
    super(`Port ${port} on ${host} is already in use.`);
  }
}

const page = (title: string, body: string, close: boolean) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem;text-align:center}</style>` +
  `</head><body><h1>${title}</h1><p>${body}</p>` +
  (close ? `<script>setTimeout(function(){window.close()},300)</script>` : "") +
  `</body></html>`;

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const defaultSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

export async function startCallbackServer(options: CallbackOptions): Promise<CallbackServer> {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  code.catch(() => {}); // observed by the caller; never an unhandled rejection
  let done = false;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, html: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    };
    if (url.pathname !== options.path || req.method !== "GET") return send(404, page("Not found", "", false));
    if (done) return send(410, page("Login already handled", "You can close this tab.", true));
    if (!stateMatches(options.state, url.searchParams.get("state"))) {
      // Ignore forged or stale redirects and keep waiting for the genuine one.
      return send(
        400,
        page("Invalid login response", "The state parameter does not match this login.", false),
      );
    }
    const error = url.searchParams.get("error");
    if (error) {
      const description = url.searchParams.get("error_description") ?? "";
      send(400, page("Authentication failed", escapeHtml(`${error} ${description}`.trim()), false));
      return finish(
        new Error(`Keycloak refused the login: ${error}${description ? ` (${description})` : ""}`),
      );
    }
    const received = url.searchParams.get("code");
    if (!received) return send(400, page("Invalid login response", "No authorization code received.", false));
    send(200, page("Authentication complete", "You can close this tab and return to pi.", true));
    finish(undefined, received);
  });

  const cancelTimer = (options.schedule ?? defaultSchedule)(
    () => finish(new Error(`No browser redirect received within ${Math.round(options.timeoutMs / 1000)}s.`)),
    options.timeoutMs,
  );
  const onAbort = () => finish(new Error("Login cancelled."));

  function finish(error: Error | undefined, value?: string) {
    if (done) return;
    done = true;
    cancelTimer();
    options.signal?.removeEventListener("abort", onAbort);
    if (error) settle.reject(error);
    else settle.resolve(value ?? "");
    // Stop listening; in-flight responses (the success page) still complete.
    server.close();
    server.closeIdleConnections();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      cancelTimer();
      reject(error.code === "EADDRINUSE" ? new PortInUseError(options.host, options.port) : error);
    });
    server.listen(options.port, options.host, () => resolve());
  });

  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return { port, code, close: (reason) => finish(reason ?? new Error("Login superseded.")) };
}
