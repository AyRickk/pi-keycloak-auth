// Signs in as the test user at an authorization URL and prints the redirect it ends on.
//   node test/e2e/browser-signin.ts <authorization-url> [--follow]
// With --follow the redirect is also requested (what a browser does with the loopback callback).
import { Browser } from "./browser.ts";

const url = process.argv[2];
if (!url) throw new Error("usage: browser-signin.ts <authorization-url> [--follow]");
const { redirect, html } = await new Browser().signIn(url);
if (!redirect) {
  console.error(`no redirect; page: ${(html ?? "").slice(0, 300)}`);
  process.exit(1);
}
if (process.argv.includes("--follow")) {
  const page = await (await fetch(redirect)).text();
  console.log(
    /Authentication complete/.test(page) ? "callback page: Authentication complete" : page.slice(0, 200),
  );
} else {
  console.log(redirect);
}
