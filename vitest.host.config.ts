import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/host/**/*.test.ts"], testTimeout: 60_000 },
});
