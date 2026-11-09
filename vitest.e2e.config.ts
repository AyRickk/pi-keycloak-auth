import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    reporters: ["verbose"],
    testTimeout: 600_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
