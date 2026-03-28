import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Run I/O-heavy test files (real git repos, Unix sockets) in a separate
    // sequential pool so they don't get starved by 60+ parallel mock-based files.
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    sequence: {
      sequentialFiles: [
        "test/worktree.test.ts",
        "test/daemon-ipc.test.ts",
        "test/relay.test.ts",
        "test/relay-extended.test.ts",
        "test/reflection-lock.test.ts",
        "test/researcher.test.ts",
      ],
    },
  },
});
