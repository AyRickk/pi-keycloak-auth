import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly", fetch: "readonly" },
    },
    rules: {
      "no-console": ["error", { allow: ["error", "warn", "info", "debug"] }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!node:|\\.)",
              message: "Runtime code may only import node: built-ins or relative modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      // Type-only imports of the host API are erased at build time.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!node:|\\.|@earendil-works/pi-coding-agent$)",
              message: "Runtime code may only import node: built-ins or relative modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["test/**/*.ts", "test/**/*.mjs", "scripts/**/*.mjs", "*.config.ts", "*.config.js"],
    languageOptions: { globals: { Buffer: "readonly", performance: "readonly" } },
    rules: {
      "no-restricted-imports": "off",
      "no-console": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
