// Loopback-only: these tests bind 127.0.0.1 with ephemeral ports, nothing leaves the machine.
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { PortInUseError, startCallbackServer } from "../src/callback-server.js";

const base = { host: "127.0.0.1", port: 0, path: "/callback", state: "s-123", timeoutMs: 60_000 };
const noTimer = () => () => {};

async function get(port: number, query: string, path = "/callback") {
  const res = await fetch(`http://127.0.0.1:${port}${path}?${query}`);
  return { status: res.status, html: await res.text() };
}

describe("callback server", () => {
  it("binds an ephemeral port when asked for port 0 and returns the code", async () => {
    const server = await startCallbackServer({ ...base, schedule: noTimer });
    expect(server.port).toBeGreaterThan(0);
    const page = await get(server.port, "code=abc&state=s-123");
    expect(page.status).toBe(200);
    expect(page.html).toContain("Authentication complete");
    expect(page.html).toContain("window.close()");
    await expect(server.code).resolves.toBe("abc");
  });

  it("ignores a redirect with the wrong state and keeps waiting for the genuine one", async () => {
    const server = await startCallbackServer({ ...base, schedule: noTimer });
    expect((await get(server.port, "code=evil&state=other")).status).toBe(400);
    expect((await get(server.port, "code=evil")).status).toBe(400);
    await get(server.port, "code=good&state=s-123");
    await expect(server.code).resolves.toBe("good");
  });

  it("answers 404 on other paths", async () => {
    const server = await startCallbackServer({ ...base, schedule: noTimer });
    expect((await get(server.port, "code=x&state=s-123", "/favicon.ico")).status).toBe(404);
    server.close();
  });

  it("rejects with the Keycloak error when the user denies access", async () => {
    const server = await startCallbackServer({ ...base, schedule: noTimer });
    const page = await get(server.port, "error=access_denied&error_description=<b>no</b>&state=s-123");
    expect(page.html).not.toContain("<b>");
    await expect(server.code).rejects.toThrow(/access_denied/);
  });

  it("times out using the injected scheduler", async () => {
    let fire!: () => void;
    const server = await startCallbackServer({
      ...base,
      timeoutMs: 5_000,
      schedule: (fn) => ((fire = fn), () => {}),
    });
    fire();
    await expect(server.code).rejects.toThrow(/within 5s/);
  });

  it("stops when the login is aborted", async () => {
    const controller = new AbortController();
    const server = await startCallbackServer({ ...base, schedule: noTimer, signal: controller.signal });
    controller.abort();
    await expect(server.code).rejects.toThrow(/cancelled/);
  });

  it("reports a busy port as PortInUseError", async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as { port: number }).port;
    const cancel = vi.fn();
    await expect(startCallbackServer({ ...base, port, schedule: () => cancel })).rejects.toBeInstanceOf(
      PortInUseError,
    );
    expect(cancel).toHaveBeenCalled();
    blocker.close();
  });

  it("frees its port once closed", async () => {
    const server = await startCallbackServer({ ...base, schedule: noTimer });
    server.close();
    await expect(server.code).rejects.toThrow(/superseded/i);
    const again = await startCallbackServer({ ...base, port: server.port, schedule: noTimer });
    expect(again.port).toBe(server.port);
    again.close();
  });
});
