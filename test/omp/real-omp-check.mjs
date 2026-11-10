// Real Oh My Pi check: runs the actual `omp --mode rpc` with the built extension against a
// fake Keycloak and a fake OpenAI-compatible gateway (one local HTTP server), in a throwaway
// HOME, and prints PASS/FAIL per check.
//
// Prerequisites: `omp` (and Bun) on PATH, `npm run build`.
// Usage: node test/omp/real-omp-check.mjs
//
// Each scenario: RPC /login (browser with the redirect replayed, or device code), model
// discovery, a chat request, then a restart. The server records the Authorization header of
// every gateway request; the checks compare it with the tokens it issued.
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const bundle = join(root, "dist", "index.js");
const MODELS = ["qwen3-coder", "gpt-oss-120b"];
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

/** Fake Keycloak + gateway. `ttl` is the access token lifetime in seconds. */
async function backend(ttl) {
  const state = { issued: 0, deviceApproved: false, gateway: [] };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url.endsWith("/protocol/openid-connect/auth/device")) {
      return json(200, {
        device_code: "dc",
        user_code: "ABCD-EFGH",
        verification_uri: `${state.base}/realms/dev/device`,
        verification_uri_complete: `${state.base}/realms/dev/device?user_code=ABCD-EFGH`,
        expires_in: 60,
        interval: 1,
      });
    }
    if (req.url.endsWith("/protocol/openid-connect/token")) {
      const grant = new URL(`http://x/?${body}`).searchParams.get("grant_type") ?? "";
      if (grant.endsWith("device_code") && !state.deviceApproved) {
        return json(400, { error: "authorization_pending" });
      }
      state.issued++;
      return json(200, {
        access_token: `access-${state.issued}`,
        refresh_token: `refresh-${state.issued}`,
        expires_in: ttl,
        token_type: "Bearer",
      });
    }
    const authorization = req.headers.authorization ?? null;
    state.gateway.push({ path: req.url, authorization });
    if (!authorization?.startsWith("Bearer access-")) return json(401, { error: "unauthorized" });
    if (req.url === "/v1/models") return json(200, { object: "list", data: MODELS.map((id) => ({ id })) });
    if (req.url === "/v1/chat/completions") {
      const chunk = (choice, extra = {}) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [choice], ...extra })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: null }));
      res.write(
        chunk(
          { index: 0, delta: {}, finish_reason: "stop" },
          { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ),
      );
      return res.end("data: [DONE]\n\n");
    }
    json(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.base = `http://127.0.0.1:${server.address().port}`;
  return { state, close: () => server.close() };
}

/** One `omp --mode rpc` process; `steps` receives `send(command)`. */
function omp(home, env, steps, backendState) {
  const child = spawn("omp", ["--mode", "rpc", "--no-session", "--model", "keycloak/qwen3-coder"], {
    cwd: join(home, "project"),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(String(d)));
  const waiters = new Map();
  createInterface({ input: child.stdout }).on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "extension_ui_request") {
      if (msg.method === "open_url") {
        // Plays the user: a browser login is replayed to the loopback redirect, a device
        // code is confirmed on the "other device".
        const url = new URL(msg.url);
        const redirect = url.searchParams.get("redirect_uri");
        if (!redirect) backendState.deviceApproved = true;
        else {
          const back = new URL(redirect);
          back.searchParams.set("code", "auth-code");
          back.searchParams.set("state", url.searchParams.get("state"));
          await fetch(back);
        }
      } else if (msg.method === "notify" && msg.message.includes("user_code=")) {
        backendState.deviceApproved = true;
      } else if (["select", "confirm", "input", "editor"].includes(msg.method)) {
        child.stdin.write(
          JSON.stringify({ type: "extension_ui_response", id: msg.id, cancelled: true }) + "\n",
        );
      }
    }
    const key = msg.type === "response" ? msg.id : msg.type;
    waiters.get(key)?.(msg);
    waiters.delete(key);
  });
  const wait = (key, ms = 60_000) =>
    new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error(`timeout: ${key}\n${stderr.join("")}`)), ms);
      waiters.set(key, (msg) => (globalThis.clearTimeout(timer), resolve(msg)));
    });
  let n = 0;
  const send = (command) => {
    const id = `r${++n}`;
    const reply = wait(id);
    child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
    return reply;
  };
  return (async () => {
    try {
      await wait("ready");
      return await steps({ send, wait });
    } finally {
      child.kill();
    }
  })();
}

const keycloakModels = (reply) =>
  (reply.data?.models ?? reply.data ?? []).filter((m) => m.provider === "keycloak").map((m) => m.id);

async function scenario(name, { device = false, ttl = 300 }) {
  console.log(`\n== ${name}`);
  const { state, close } = await backend(ttl);
  const home = mkdtempSync(join(tmpdir(), "real-omp-"));
  try {
    const agentDir = join(home, ".omp", "agent");
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(join(home, "project"));
    copyFileSync(bundle, join(agentDir, "extensions", "pi-keycloak-auth.js"));
    // Found in ~/.omp/agent without any variable. RPC mode needs a model before the first
    // login: one is declared, discovery stays on.
    writeFileSync(
      join(agentDir, "keycloak-auth.json"),
      JSON.stringify({
        issuer: `${state.base}/realms/dev`,
        clientId: "pi",
        baseUrl: `${state.base}/v1`,
        callbackPort: 0,
        models: ["qwen3-coder"],
        discoverModels: true,
      }),
    );
    const cleared = new Set([
      "PI_CODING_AGENT_DIR",
      "PI_CONFIG_DIR",
      "PI_KC_CONFIG",
      "OMP_PROFILE",
      "PI_PROFILE",
      "CI",
    ]);
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !cleared.has(k))),
      HOME: home,
      PI_KC_LOG: "warn",
    };
    if (device) env.CI = "1"; // headless: the device code is the recommended method

    await omp(
      home,
      env,
      async ({ send, wait }) => {
        const login = await send({ type: "login", providerId: "keycloak" });
        check(
          "login through RPC (method prompt refused, recommended method used)",
          login.success,
          login.error,
        );
        const models = keycloakModels(await send({ type: "get_available_models" }));
        check(
          "models discovered from GET /v1/models",
          JSON.stringify(models) === JSON.stringify(MODELS),
          models,
        );
        const list = state.gateway.find((r) => r.path === "/v1/models");
        check(
          "model list requested with the Keycloak access token",
          list?.authorization === "Bearer access-1",
        );
        const set = await send({ type: "set_model", provider: "keycloak", modelId: "gpt-oss-120b" });
        check("a discovered model can be selected", set.success, set.error);
        const end = wait("agent_end");
        await send({ type: "prompt", message: "ping" });
        const last = (await end).messages?.at(-1);
        check("chat reply received", JSON.stringify(last?.content ?? "").includes("pong"));
        const chat = state.gateway.find((r) => r.path === "/v1/chat/completions");
        check(
          "chat sent with the latest access token",
          chat?.authorization === `Bearer access-${state.issued}`,
          `${chat?.authorization}, ${state.issued} token(s) issued`,
        );
      },
      state,
    );
    if (ttl < 30) check("short-lived token refreshed before the chat request", state.issued > 1);

    await omp(
      home,
      env,
      async ({ send }) => {
        const models = keycloakModels(await send({ type: "get_available_models" }));
        check(
          "after a restart the discovered models are still listed",
          models.length === MODELS.length,
          models,
        );
      },
      state,
    );
  } finally {
    close();
    rmSync(home, { recursive: true, force: true });
  }
}

await scenario("browser login, discovery, chat, restart", {});
await scenario("device-code login (headless)", { device: true });
await scenario("tokens shorter than the refresh leeway", { ttl: 20 });
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
