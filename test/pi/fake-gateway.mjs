// A minimal OpenAI-compatible gateway for the real-pi check. It answers every chat
// completion with "pong" and appends one JSON line per request to $GATEWAY_LOG with the
// Authorization header and the X-Client header it received. Local test tool only.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env.GATEWAY_PORT ?? 18181);
const logFile = process.env.GATEWAY_LOG ?? "gateway.log";

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const entry = {
      at: new Date().toISOString(),
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization ?? null,
      xClient: req.headers["x-client"] ?? null,
    };
    appendFileSync(logFile, JSON.stringify(entry) + "\n");
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const model = (() => {
      try {
        return JSON.parse(body).model;
      } catch {
        return "unknown";
      }
    })();
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } } : {}),
      })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(chunk({ role: "assistant", content: "pong" }, null));
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
}).listen(port, "127.0.0.1", () => console.log(`fake gateway on http://127.0.0.1:${port}/v1`));
