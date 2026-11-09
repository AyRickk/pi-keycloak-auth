// Approves a device-code login as the test user: node test/e2e/approve-device.ts <user_code>
import { Browser, ISSUER } from "./browser.ts";

const code = process.argv[2];
if (!code) throw new Error("usage: approve-device.ts <user_code>");
const result = await new Browser().signIn(`${ISSUER}/device?user_code=${encodeURIComponent(code)}`);
const ok = /success/i.test(result.html ?? "");
console.log(
  ok ? "device approved" : `unexpected page: ${(result.html ?? result.redirect ?? "").slice(0, 300)}`,
);
process.exit(ok ? 0 : 1);
