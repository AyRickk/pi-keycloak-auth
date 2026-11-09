/** Best-effort detection of whether a local browser can be opened on this machine. */
import { existsSync } from "node:fs";

type Env = Record<string, string | undefined>;

export interface Host {
  env: Env;
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
}

const defaultHost = (): Host => ({ env: process.env, platform: process.platform, exists: existsSync });

/** Why no local browser is assumed, or undefined when one is available. */
export function headlessReason(host: Host = defaultHost()): string | undefined {
  const { env } = host;
  if (env["SSH_CONNECTION"] || env["SSH_CLIENT"] || env["SSH_TTY"]) return "SSH session";
  if (env["CI"] && env["CI"] !== "false" && env["CI"] !== "0") return "CI environment";
  if (
    env["container"] ||
    env["KUBERNETES_SERVICE_HOST"] ||
    host.exists("/.dockerenv") ||
    host.exists("/run/.containerenv")
  ) {
    return "container";
  }
  if (host.platform === "darwin" || host.platform === "win32") return undefined;
  if (!env["DISPLAY"] && !env["WAYLAND_DISPLAY"]) return "no graphical display";
  return undefined;
}
