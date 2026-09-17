import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The agent tests spin up temporary project trees; run them in isolation
    // so filesystem assertions cannot interleave.
    pool: "forks",
    maxWorkers: 1,
  },
});
