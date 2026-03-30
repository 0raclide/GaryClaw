// Regression: ISSUE-002 — commit count cache race condition
// Found by /qa on 2026-03-30
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
//
// The commit count cache in buildIPCHandler set lastCommitCountRefresh AFTER the
// async getWorktreeCommitCount() completed. Concurrent IPC requests arriving within
// the 3s git timeout window would both see stale cache and spawn duplicate git
// subprocesses. Fix: set the timestamp BEFORE the await.

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/pipeline.js", () => ({
  readPipelineState: vi.fn(() => null),
  runPipeline: vi.fn(),
  resumePipeline: vi.fn(),
}));
vi.mock("../src/orchestrator.js", () => ({
  runSkill: vi.fn(),
  resumeSkill: vi.fn(),
}));

describe("commit count cache timestamp ordering", () => {
  it("sets lastCommitCountRefresh before async call to prevent duplicate requests", async () => {
    // Read the actual source to verify the fix
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(import.meta.dirname, "..", "src", "daemon.ts"), "utf-8");

    // Find the cache refresh block
    const cacheBlock = source.match(
      /if \(worktreePath && Date\.now\(\)[\s\S]*?getWorktreeCommitCount[\s\S]*?\}/,
    );
    expect(cacheBlock).not.toBeNull();

    const block = cacheBlock![0];
    const timestampPos = block.indexOf("lastCommitCountRefresh = Date.now()");
    const awaitPos = block.indexOf("await getWorktreeCommitCount");

    // The timestamp assignment MUST come before the await
    expect(timestampPos).toBeLessThan(awaitPos);
    expect(timestampPos).toBeGreaterThan(-1);
    expect(awaitPos).toBeGreaterThan(-1);
  });

  it("getWorktreeCommitCount returns 0 on missing worktreePath", async () => {
    const { getWorktreeCommitCount } = await import("../src/daemon.js");
    const result = await getWorktreeCommitCount(undefined, "/tmp");
    expect(result).toBe(0);
  });

  it("getWorktreeCommitCount returns 0 on invalid path", async () => {
    const { getWorktreeCommitCount } = await import("../src/daemon.js");
    const result = await getWorktreeCommitCount("/nonexistent/path", "/tmp");
    expect(result).toBe(0);
  });
});
