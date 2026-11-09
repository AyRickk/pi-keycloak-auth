/**
 * A scripted "user with a browser" for Keycloak's login pages: cookie jar, manual
 * redirects, login form, consent and device-grant pages. Test-only.
 */
export const KC_URL = process.env["KC_E2E_URL"] ?? "http://localhost:18080";
export const REALM = "pi-test";
export const ISSUER = `${KC_URL}/realms/${REALM}`;
export const USER = { username: "alice", password: "alice" };

// "&amp;" is decoded last so that an encoded entity such as "&amp;quot;" stays "&quot;".
const decode = (s: string) =>
  s
    .replace(/&#x3D;/g, "=")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

export class Browser {
  private cookies = new Map<string, string>();

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    return res;
  }

  /**
   * Follows redirects and fills in Keycloak's forms until a redirect leaves Keycloak
   * (returned as a URL, not followed) or a final page is reached (returned as HTML).
   */
  async signIn(
    startUrl: string,
    extra: Record<string, string> = {},
  ): Promise<{ redirect?: string; html?: string }> {
    let next: { url: string; init?: RequestInit } | undefined = { url: startUrl };
    for (let hops = 0; next && hops < 20; hops++) {
      const res = await this.request(next.url, next.init);
      const location = res.headers.get("location");
      if (location) {
        const target = new URL(location, next.url).toString();
        if (!target.startsWith(KC_URL)) return { redirect: target };
        next = { url: target };
        continue;
      }
      const html = await res.text();
      const form = this.pickForm(html);
      if (!form) return { html };
      const body = new URLSearchParams(form.fields);
      if (form.id === "kc-form-login") {
        body.set("username", USER.username);
        body.set("password", USER.password);
      }
      for (const [k, v] of Object.entries(extra)) if (html.includes(`name="${k}"`)) body.set(k, v);
      next = {
        url: new URL(form.action, next.url).toString(),
        init: { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } },
      };
    }
    throw new Error("too many redirects");
  }

  private pickForm(html: string) {
    for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
      const attrs = match[1]!;
      const id = attrs.match(/id="([^"]+)"/)?.[1] ?? "";
      const action = attrs.match(/action="([^"]+)"/)?.[1];
      if (!action) continue;
      const fields: Record<string, string> = {};
      for (const input of match[2]!.matchAll(/<input\b[^>]*>/g)) {
        const name = input[0].match(/name="([^"]+)"/)?.[1];
        const type = input[0].match(/type="([^"]+)"/)?.[1] ?? "text";
        const value = decode(input[0].match(/value="([^"]*)"/)?.[1] ?? "");
        if (!name) continue;
        // Consent / device pages: press the "accept"/"Yes" button only.
        if (type === "submit") {
          if (/accept|yes/i.test(name) || /yes|accept/i.test(value)) fields[name] = value;
          continue;
        }
        fields[name] = value;
      }
      return { id, action: decode(action), fields };
    }
    return undefined;
  }
}

/** Decode a JWT payload (no signature check: test assertions only). */
export function claims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
}

/** Admin API helpers (master realm admin from the container bootstrap). */
export async function adminToken(): Promise<string> {
  const res = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: "admin",
      password: "admin",
    }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Revokes every session of the test user, offline sessions included. */
export async function logoutEverywhere(): Promise<void> {
  const token = await adminToken();
  const auth = { authorization: `Bearer ${token}` };
  const users = (await (
    await fetch(`${KC_URL}/admin/realms/${REALM}/users?username=alice`, { headers: auth })
  ).json()) as {
    id: string;
  }[];
  const id = users[0]!.id;
  await fetch(`${KC_URL}/admin/realms/${REALM}/users/${id}/logout`, { method: "POST", headers: auth });
  // Revokes the offline tokens granted to the client.
  await fetch(`${KC_URL}/admin/realms/${REALM}/users/${id}/consents/pi-cli`, {
    method: "DELETE",
    headers: auth,
  });
}
