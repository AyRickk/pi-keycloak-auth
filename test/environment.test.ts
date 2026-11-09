import { describe, expect, it } from "vitest";
import { headlessReason } from "../src/environment.js";

const host = (env: Record<string, string>, platform: NodeJS.Platform = "linux", files: string[] = []) => ({
  env,
  platform,
  exists: (p: string) => files.includes(p),
});

describe("headless detection", () => {
  it("desktop: macOS, Windows, Linux with a display", () => {
    expect(headlessReason(host({}, "darwin"))).toBeUndefined();
    expect(headlessReason(host({}, "win32"))).toBeUndefined();
    expect(headlessReason(host({ DISPLAY: ":0" }))).toBeUndefined();
    expect(headlessReason(host({ WAYLAND_DISPLAY: "wayland-0" }))).toBeUndefined();
  });

  it("headless: SSH, CI, containers, Linux without display", () => {
    expect(headlessReason(host({ SSH_CONNECTION: "1 2 3 4" }, "darwin"))).toBe("SSH session");
    expect(headlessReason(host({ SSH_TTY: "/dev/pts/1", DISPLAY: ":0" }))).toBe("SSH session");
    expect(headlessReason(host({ CI: "true" }, "darwin"))).toBe("CI environment");
    expect(headlessReason(host({ DISPLAY: ":0" }, "linux", ["/.dockerenv"]))).toBe("container");
    expect(headlessReason(host({ DISPLAY: ":0" }, "linux", ["/run/.containerenv"]))).toBe("container");
    expect(headlessReason(host({ KUBERNETES_SERVICE_HOST: "10.0.0.1", DISPLAY: ":0" }))).toBe("container");
    expect(headlessReason(host({}))).toBe("no graphical display");
  });

  it("CI=false does not count as CI", () => {
    expect(headlessReason(host({ CI: "false" }, "darwin"))).toBeUndefined();
  });
});
