/**
 * Job Runner post-merge verification tests — verify+revert flow, smart skip
 * when pre-merge passed, skip config, audit+todo+notification, error handling.
 *
 * All synthetic data — mocks worktree, child_process, and file I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig, DaemonState } from "../src/types.js";
import type { MergeResult, PostMergeVerifyResult } from "../src/worktree.js";

// Mock worktree module
vi.mock("../src/worktree.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/worktree.js")>();
  return {
    ...orig,
    mergeWorktreeBranch: vi.fn().mockReturnValue({ merged: true, commitCount: 2 }),
    resolveBaseBranch: vi.fn().mockReturnValue("main"),
    verifyPostMerge: vi.fn().mockReturnValue({ verified: true, reverted: false, mergeSha: "abc123" }),
    appendMergeRevert: vi.fn(),
    branchName: vi.fn((name: string) => `garyclaw/${name}`),
  };
});

// Mock child_process — only the execFileSync used for git rev-parse HEAD
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    execFileSync: vi.fn((...args: unknown[]) => {
      // Intercept git rev-parse HEAD calls (used to read merge SHA)
      if (args[0] === "git" && Array.isArray(args[1]) && args[1].includes("rev-parse") && args[1].includes("HEAD")) {
        return "abc123def456\n";
      }
      // Delegate everything else to the real implementation
      return (orig.execFileSync as Function)(...args);
    }),
  };
});

// Mock dashboard to prevent file I/O
vi.mock("../src/dashboard.js", () => ({
  generateDashboard: vi.fn(),
}));

// Mock daemon-registry to prevent file I/O
vi.mock("../src/daemon-registry.js", () => ({
  readGlobalBudget: vi.fn().mockReturnValue({ date: "2026-03-30", totalUsd: 0, jobCount: 0, byInstance: {} }),
  updateGlobalBudget: vi.fn(),
  isSkillSetActive: vi.fn().mockReturnValue(false),
  getClaimedTodoTitles: vi.fn().mockReturnValue([]),
  getCompletedTodoTitles: vi.fn().mockReturnValue([]),
  getClaimedFiles: vi.fn().mockReturnValue([]),
  setGlobalRateLimitHold: vi.fn(),
  clearGlobalRateLimitHold: vi.fn(),
}));

import { mergeWorktreeBranch, verifyPostMerge, appendMergeRevert } from "../src/worktree.js";

const TEST_DIR = join(process.cwd(), ".test-jobrunner-postmerge-tmp");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: {
      dailyCostLimitUsd: 50,
      perJobCostLimitUsd: 10,
      maxJobsPerDay: 20,
    },
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: false },
    orchestrator: {
      maxTurnsPerSegment: 15,
      relayThresholdRatio: 0.85,
      maxRelaySessions: 10,
      askTimeoutMs: 300000,
    },
    logging: { level: "info", retainDays: 7 },
    ...overrides,
  };
}

function createMockDeps() {
  return {
    runPipeline: vi.fn().mockResolvedValue(undefined),
    resumePipeline: vi.fn().mockResolvedValue(undefined),
    runSkill: vi.fn().mockResolvedValue(undefined),
    buildSdkEnv: vi.fn().mockReturnValue({ HOME: "/home" }),
    notifyJobComplete: vi.fn(),
    notifyJobError: vi.fn(),
    notifyJobResumed: vi.fn(),
    notifyMergeBlocked: vi.fn(),
    notifyMergeReverted: vi.fn(),
    writeSummary: vi.fn(),
    log: vi.fn(),
  };
}

describe("Job Runner post-merge verification", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    vi.clearAllMocks();
    // Default: merge succeeds with 2 commits, no pre-merge tests
    (mergeWorktreeBranch as ReturnType<typeof vi.fn>).mockReturnValue({ merged: true, commitCount: 2 });
    (verifyPostMerge as ReturnType<typeof vi.fn>).mockReturnValue({ verified: true, reverted: false, mergeSha: "abc123" });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("calls verifyPostMerge after successful merge with commits", async () => {
    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(verifyPostMerge).toHaveBeenCalledWith(
      "/tmp/project",
      expect.any(String),
      expect.objectContaining({}),
    );
  });

  it("skips verification when merge has 0 commits", async () => {
    (mergeWorktreeBranch as ReturnType<typeof vi.fn>).mockReturnValue({ merged: true, commitCount: 0, reason: "Already up to date" });

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(verifyPostMerge).not.toHaveBeenCalled();
  });

  it("smart skip: skips verification when pre-merge tests passed", async () => {
    (mergeWorktreeBranch as ReturnType<typeof vi.fn>).mockReturnValue({
      merged: true,
      commitCount: 3,
      testsPassed: true,
      testDurationMs: 30000,
    });

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { testCommand: "npm test" },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(verifyPostMerge).not.toHaveBeenCalled();
  });

  it("forcePostMergeVerification overrides smart skip", async () => {
    (mergeWorktreeBranch as ReturnType<typeof vi.fn>).mockReturnValue({
      merged: true,
      commitCount: 3,
      testsPassed: true,
      testDurationMs: 30000,
    });

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { testCommand: "npm test", forcePostMergeVerification: true },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(verifyPostMerge).toHaveBeenCalled();
  });

  it("skipPostMergeVerification config disables verification", async () => {
    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { skipPostMergeVerification: true },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(verifyPostMerge).not.toHaveBeenCalled();
  });

  it("logs success when verification passes", async () => {
    (verifyPostMerge as ReturnType<typeof vi.fn>).mockReturnValue({
      verified: true,
      reverted: false,
      mergeSha: "abc123",
      testDurationMs: 15000,
    });

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const logCalls = deps.log.mock.calls.map((c: string[]) => c.join(" "));
    const postMergeLog = logCalls.find((c: string) => c.includes("Post-merge verified"));
    expect(postMergeLog).toBeDefined();
    expect(postMergeLog).toContain("15s");
  });

  it("on revert: logs warning, appends audit, calls notifyMergeReverted", async () => {
    const revertResult: PostMergeVerifyResult = {
      verified: false,
      reverted: true,
      revertSha: "def456",
      mergeSha: "abc123",
      testOutput: "FAIL: something broke",
      testDurationMs: 5000,
      reason: "Post-merge tests failed",
    };
    (verifyPostMerge as ReturnType<typeof vi.fn>).mockReturnValue(revertResult);

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    // Check warning logged
    const logCalls = deps.log.mock.calls.map((c: string[]) => c.join(" "));
    const revertLog = logCalls.find((c: string) => c.includes("POST-MERGE REVERT"));
    expect(revertLog).toBeDefined();

    // Check audit appended
    expect(appendMergeRevert).toHaveBeenCalledWith(
      "/tmp/project",
      expect.objectContaining({
        instanceName: "builder",
        autoReverted: true,
        reason: "Post-merge tests failed",
      }),
    );

    // Check notification sent
    expect(deps.notifyMergeReverted).toHaveBeenCalledWith(
      expect.objectContaining({ skills: ["qa"] }),
      revertResult,
      expect.any(Object),
    );
  });

  it("on failed revert (HEAD moved): logs warning and audits with autoReverted=false", async () => {
    const skipResult: PostMergeVerifyResult = {
      verified: false,
      reverted: false,
      mergeSha: "abc123",
      testOutput: "FAIL: broke",
      testDurationMs: 5000,
      reason: "HEAD moved past merge SHA — manual revert needed",
    };
    (verifyPostMerge as ReturnType<typeof vi.fn>).mockReturnValue(skipResult);

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    // Check warning
    const logCalls = deps.log.mock.calls.map((c: string[]) => c.join(" "));
    const skipLog = logCalls.find((c: string) => c.includes("revert skipped"));
    expect(skipLog).toBeDefined();

    // Check audit with autoReverted=false
    expect(appendMergeRevert).toHaveBeenCalledWith(
      "/tmp/project",
      expect.objectContaining({
        autoReverted: false,
      }),
    );

    // No notification for skipped revert
    expect(deps.notifyMergeReverted).not.toHaveBeenCalled();
  });

  it("does not run for default instance (no worktreePath)", async () => {
    const config = createTestConfig();
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "default");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(verifyPostMerge).not.toHaveBeenCalled();
  });

  it("swallows verification errors gracefully", async () => {
    (verifyPostMerge as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Unexpected failure in verification");
    });

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    // Should not throw
    await runner.processNext();

    const logCalls = deps.log.mock.calls.map((c: string[]) => c.join(" "));
    const errLog = logCalls.find((c: string) => c.includes("Post-merge verification error"));
    expect(errLog).toBeDefined();
  });

  it("passes testCommand and testTimeout from merge config", async () => {
    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { testCommand: "npm run ci-test", testTimeout: 90000 },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(verifyPostMerge).toHaveBeenCalledWith(
      "/tmp/project",
      expect.any(String),
      expect.objectContaining({
        testCommand: "npm run ci-test",
        testTimeout: 90000,
      }),
    );
  });

  it("does not merge or verify when merge fails", async () => {
    (mergeWorktreeBranch as ReturnType<typeof vi.fn>).mockReturnValue({
      merged: false,
      reason: "Rebase conflict",
      commitCount: 2,
    });

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(verifyPostMerge).not.toHaveBeenCalled();
  });
});
