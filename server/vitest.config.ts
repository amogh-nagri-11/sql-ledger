import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These tests hit a REAL Postgres (Dockerized), not a mock — that's the
    // whole point. They share one database, so they must run strictly serially:
    // a single fork, one file at a time, no concurrent tests. Otherwise two
    // files' concurrent writes + afterAll cleanup race against each other.
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    sequence: { concurrent: false },
    poolOptions: { forks: { singleFork: true } },
  },
});
