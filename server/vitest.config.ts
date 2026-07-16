import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These tests hit a REAL Postgres (Dockerized), not a mock — that's the
    // whole point. Give them room and run files serially to avoid cross-file
    // contention on the shared database.
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
