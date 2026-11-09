// Verifies the built bundle: ESM, only node: built-in imports, default export, no stray secrets.
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "dist/index.js";
const code = readFileSync(file, "utf8");
const problems = [];

const specifiers = [
  ...code.matchAll(/\bimport\s+(?:[^"';]+?\s+from\s+)?["']([^"']+)["']/g),
  ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ...code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
].map((m) => m[1]);
for (const spec of new Set(specifiers)) {
  if (!spec.startsWith("node:")) problems.push(`non built-in import: ${spec}`);
}
if (!/export\s*\{[^}]*\bas default\b[^}]*\}|export default/.test(code)) problems.push("no default export");
if (/eyJ[\w-]{10,}\.[\w-]{10,}\./.test(code))
  problems.push("bundle contains something that looks like a JWT");

const kb = (Buffer.byteLength(code) / 1024).toFixed(1);
if (problems.length) {
  console.error(`check-bundle: ${file} FAILED\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
console.log(`check-bundle: ${file} OK (${kb} KiB; imports: ${[...new Set(specifiers)].join(", ")})`);
