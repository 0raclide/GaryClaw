/**
 * Regression tests for post-merge verification gaps identified by eng review:
 *
 * 1. verifyPostMerge when git rev-parse HEAD fails at entry (corrupted repo)
 * 2. verifyPostMerge when HEAD re-read fails after test failure
 * 3. Bug TODO content format consumed by prioritize skill
 *
 * Found by /qa on 2026-03-30
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { handlePostMergeVerification } from "../src/job-runner.js";
import type { PostMergeVerifyResult } from "../src/worktree.js";
import type { DaemonConfig, Job } from "../src/types.js";

// Mock worktree module
vi.mock("../src/worktree.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/worktree.js")>();
  return {
    ...orig,
    verifyPostMerge: vi.fn().mockReturnValue({ verified: true, reverted: false, mergeSha: "abc123" }),
    appendMergeRevert: vi.fn(),
    branchName: vi.fn((name: string) => `garyclaw/${name}`),
  };
});

// Mock child_process
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    execFileSync: vi.fn(() => "abc123def456\n"),
  };
});

// Mock failure-taxonomy
vi.mock("../src/failure-taxonomy.js", () => ({
  classifyError: vi.fn().mockReturnValue("unknown"),
  buildFailureRecord: vi.fn().mockReturnValue({ category: "test-failure", jobId: "j1", skills: ["qa"], timestamp: new Date().toISOString() }),
  appendFailureRecord: vi.fn(),
}));

import { verifyPostMerge, appendMergeRevert } from "../src/worktree.js";
import { execFileSync } from "node:child_process";
import { buildFailureRecord, appendFailureRecord } from "../src/failure-taxonomy.js";

const TEST_DIR = join(process.cwd(), ".test-postmerge-regression-1-tmp");

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-001",
    skills: ["implement", "qa"],
    status: "running",
    triggeredBy: "manual",
    triggerDetail: "test",
    createdAt: new Date().toISOString(),
    costUsd: 0,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: TEST_DIR,
    triggers: [],
    budget: { dailyCostLimitUsd: 50, perJobCostLimitUsd: 10, maxJobsPerDay: 20 },
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: false },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
    logging: { level: "info", retainDays: 7 },
    ...overrides,
  };
}

describe("Post-merge verification regression tests", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    vi.clearAllMocks();
    // Default: HEAD read succeeds
    (execFileSync as ReturnType<typeof vi.fn>).mockReturnValue("abc123def456\n");
    (verifyPostMerge as ReturnType<typeof vi.fn>).mockReturnValue({ verified: true, reverted: false, mergeSha: "abc123" });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // Gap 1: verifyPostMerge returns clean error when git rev-parse HEAD fails at entry
  it("handles git rev-parse HEAD failure at entry gracefully", () => {
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("fatal: not a git repository");
    });

    const log = vi.fn();
    // Should not throw — the outer try/catch in handlePostMergeVerification catches it
    handlePostMergeVerification({
      projectDir: TEST_DIR,
      instanceName: "worker-1",
      jobId: "job-001",
      skills: ["qa"],
      checkpointDir: TEST_DIR,
      commitCount: 3,
      log,
      job: makeJob(),
      config: makeConfig(),
    });

    // Should log a warning about verification error
    const warnCalls = log.mock.calls.filter((c: string[]) => c[0] === "warn");
    const errorLog = warnCalls.find((c: string[]) => c[1].includes("Post-merge verification error"));
    expect(errorLog).toBeDefined();

    // verifyPostMerge should NOT have been called (failed before reaching it)
    expect(verifyPostMerge).not.toHaveBeenCalled();
  });

  // Gap 2: verifyPostMerge returns clean error when HEAD re-read fails after test failure
  // This tests the verifyPostMerge interface contract — when it returns reason about HEAD read failure
  it("handles verifyPostMerge returning HEAD-read failure result", () => {
    const failResult: PostMergeVerifyResult = {
      verified: false,
      reverted: false,
      mergeSha: "abc123",
      testOutput: "FAIL: tests broke",
      testDurationMs: 5000,
      reason: "Tests failed and cannot read HEAD for revert check",
    };
    (verifyPostMerge as ReturnType<typeof vi.fn>).mockReturnValue(failResult);

    const log = vi.fn();
    handlePostMergeVerification({
      projectDir: TEST_DIR,
      instanceName: "worker-1",
      jobId: "job-001",
      skills: ["qa"],
      checkpointDir: TEST_DIR,
      commitCount: 3,
      log,
      job: makeJob(),
      config: makeConfig(),
    });

    // Should take the "revert skipped" path (verified=false, reverted=false)
    const warnCalls = log.mock.calls.filter((c: string[]) => c[0] === "warn");
    const skipLog = warnCalls.find((c: string[]) => c[1].includes("revert skipped"));
    expect(skipLog).toBeDefined();

    // Should still audit the event
    expect(appendMergeRevert).toHaveBeenCalledWith(
      TEST_DIR,
      expect.objectContaining({
        autoReverted: false,
        reason: "Tests failed and cannot read HEAD for revert check",
      }),
    );
  });

  // Gap 3: Bug TODO content format validation
  // The TODO format is consumed by parseTodoItems in prioritize.ts.
  // It must have a ## heading with the title, and structured **Key:** Value fields.
  it("bug TODO content has correct markdown format for prioritize parsing", () => {
    const revertResult: PostMergeVerifyResult = {
      verified: false,
      reverted: true,
      revertSha: "def456",
      mergeSha: "abc123",
      testOutput: "FAIL: component broke\nExpected true, got false",
      testDurationMs: 5000,
      reason: "Post-merge tests failed",
    };
    (verifyPostMerge as ReturnType<typeof vi.fn>).mockReturnValue(revertResult);

    // Create TODOS.md so the bug TODO gets appended
    writeFileSync(join(TEST_DIR, "TODOS.md"), "# TODOs\n\n## P1: Existing item\n\nSome content.\n");

    const log = vi.fn();
    handlePostMergeVerification({
      projectDir: TEST_DIR,
      instanceName: "worker-1",
      jobId: "job-001",
      skills: ["implement", "qa"],
      checkpointDir: TEST_DIR,
      commitCount: 2,
      log,
      job: makeJob(),
      config: makeConfig(),
    });

    // Read the appended content
    const content = readFileSync(join(TEST_DIR, "TODOS.md"), "utf-8");

    // Must have ## heading (parseTodoItems looks for ## headings)
    expect(content).toMatch(/## P2: Fix post-merge regression from worker-1 \(job job-001\)/);

    // Must have **What:** field
    expect(content).toContain("**What:** Post-merge test verification failed");

    // Must have **Priority:** field with P2
    expect(content).toContain("**Priority:** P2 (auto-generated safety item)");

    // Must have **Effort:** field
    expect(content).toContain("**Effort:** S");

    // Must have test output in a code block
    expect(content).toContain("```");
    expect(content).toContain("FAIL: component broke");

    // Must have **Branch:** field with the instance branch name
    expect(content).toContain("**Branch:** `garyclaw/worker-1`");

    // Must have **Added by:** field with date
    expect(content).toMatch(/\*\*Added by:\*\* Post-merge safety net on \d{4}-\d{2}-\d{2}/);

    // Confirm the log says it created the TODO
    const infoCalls = log.mock.calls.filter((c: string[]) => c[0] === "info");
    const todoLog = infoCalls.find((c: string[]) => c[1].includes("Created P2 bug TODO"));
    expect(todoLog).toBeDefined();
  });
});
