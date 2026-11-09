// Bundles the extension into a single ESM file with no runtime dependency.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Anything that is not a node: built-in must stay an import so check-bundle flags it.
  external: ["@earendil-works/*"],
  legalComments: "none",
  banner: { js: `// pi-keycloak-auth ${version} (MIT). Single-file build, no runtime dependency.` },
  logLevel: "info",
});
