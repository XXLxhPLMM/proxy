import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: "forks",
    sequence: { shuffle: false },
  },
});
