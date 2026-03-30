/**
 * Regression: ISSUE-001 — PR fallback path must call handlePostMergeVerification
 * Regression: ISSUE-003 — Rebase conflicts in PR path must write FailureRecord
 *
 * Found by /qa on 2026-03-30
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig } from "../src/types.js";

// Mock child_process — controls rebase and test behavior
const mockExecFileSync = vi.fn().mockReturnValue("");
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

// Mock worktree — track verifyPostMerge calls
const mockVerifyPostMerge = vi.fn().mockReturnValue({ verified: true, reverted: false, mergeSha: "abc123" });
const mockMergeWorktreeBranch = vi.fn().mockReturnValue({ merged: true, commitCount: 2 });
const mockCreatePullRequest = vi.fn().mockReturnValue({
  created: true,
  prNumber: 42,
  prUrl: "https://github.com/test/repo/pull/42",
  autoMergeEnabled: true,
});
vi.mock("../src/worktree.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/worktree.js")>();
  return {
    ...orig,
    mergeWorktreeBranch: (...args: unknown[]) => mockMergeWorktreeBranch(...args),
    resolveBaseBranch: vi.fn().mockReturnValue("main"),
    verifyPostMerge: (...args: unknown[]) => mockVerifyPostMerge(...args),
    createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
    buildPrBody: vi.fn().mockReturnValue("## PR Body"),
    appendMergeAudit: vi.fn(),
    appendMergeRevert: vi.fn(),
    branchName: vi.fn((name: string) => `garyclaw/${name}`),
  };
});

// Mock dashboard
vi.mock("../src/dashboard.js", () => ({
  generateDashboard: vi.fn(),
}));

// Mock daemon-registry
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

// Mock todo-state
vi.mock("../src/todo-state.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/todo-state.js")>();
  return {
    ...orig,
    writeTodoState: vi.fn(),
    findTodoState: vi.fn().mockReturnValue(null),
    readTodoState: vi.fn().mockReturnValue(null),
    markTodoCompleteInFile: vi.fn().mockReturnValue(false),
  };
});

// Mock pipeline-compose
vi.mock("../src/pipeline-compose.js", () => ({
  composePipeline: vi.fn((_e, _p, _d, skills) => skills),
}));

// Mock pipeline-history
vi.mock("../src/pipeline-history.js", () => ({
  readPipelineOutcomes: vi.fn().mockReturnValue([]),
  appendPipelineOutcome: vi.fn(),
  computeSkipRiskScores: vi.fn().mockReturnValue({}),
  shouldUseOracleComposition: vi.fn().mockReturnValue(false),
}));

// Mock failure-taxonomy — track appendFailureRecord calls
const mockAppendFailureRecord = vi.fn();
const mockBuildFailureRecord = vi.fn().mockImplementation((err: Error) => ({
  category: "unknown",
  errorName: err.name,
  errorMessage: err.message,
}));
vi.mock("../src/failure-taxonomy.js", () => ({
  classifyError: vi.fn().mockReturnValue("unknown"),
  buildFailureRecord: (...args: unknown[]) => mockBuildFailureRecord(...args),
  appendFailureRecord: (...args: unknown[]) => mockAppendFailureRecord(...args),
}));

const TEST_DIR = join(process.cwd(), ".test-jobrunner-pr-regression-tmp");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    worktreePath: "/tmp/project/.garyclaw/worktrees/worker-1",
    name: "worker-1",
    triggers: [],
    budget: { dailyCostLimitUsd: 50, perJobCostLimitUsd: 10, maxJobsPerDay: 20 },
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: false },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
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
    notifyPrCreated: vi.fn(),
    notifyRateLimitHold: vi.fn(),
    notifyRateLimitResume: vi.fn(),
    writeSummary: vi.fn(),
    log: vi.fn(),
  };
}

describe("ISSUE-001: PR fallback path post-merge verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("calls handlePostMergeVerification after fallback direct merge succeeds", async () => {
    // PR creation fails → fallback to direct merge → merge succeeds
    mockCreatePullRequest.mockReturnValueOnce({ created: false, reason: "gh not available" });
    mockMergeWorktreeBranch.mockReturnValueOnce({ merged: true, commitCount: 3, testsPassed: true });

    const config = createTestConfig({ merge: { strategy: "pr" } });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    // Verify fallback merge happened
    expect(mockMergeWorktreeBranch).toHaveBeenCalled();
    // Verify post-merge verification was called (the fix)
    expect(mockVerifyPostMerge).toHaveBeenCalled();
  });

  it("does NOT call verifyPostMerge when fallback merge is blocked", async () => {
    mockCreatePullRequest.mockReturnValueOnce({ created: false, reason: "gh not available" });
    mockMergeWorktreeBranch.mockReturnValueOnce({ merged: false, reason: "diverged" });

    const config = createTestConfig({ merge: { strategy: "pr" } });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(mockVerifyPostMerge).not.toHaveBeenCalled();
    expect(deps.notifyMergeBlocked).toHaveBeenCalled();
  });
});

describe("ISSUE-003: Rebase conflict failure record", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("writes FailureRecord when rebase has conflicts", async () => {
    // execFileSync: pass for test command (sh -c ...), fail for rebase
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && Array.isArray(args) && args[0] === "rebase") {
        throw new Error("CONFLICT (content): Merge conflict in file.ts");
      }
      // rebase --abort should succeed silently
      return "";
    });

    const config = createTestConfig({ merge: { strategy: "pr" } });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    // PR should NOT have been created (rebase failed)
    expect(mockCreatePullRequest).not.toHaveBeenCalled();

    // FailureRecord should have been written with RebaseConflictError
    expect(mockBuildFailureRecord).toHaveBeenCalledWith(
      expect.objectContaining({ name: "RebaseConflictError" }),
      expect.any(String), // jobId
      expect.any(Array),  // skills
      "worker-1",
    );
    expect(mockAppendFailureRecord).toHaveBeenCalled();
  });

  it("does NOT write FailureRecord when rebase succeeds", async () => {
    // All execFileSync calls succeed (default mock returns "")
    const config = createTestConfig({ merge: { strategy: "pr" } });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    // PR should have been created
    expect(mockCreatePullRequest).toHaveBeenCalled();

    // No RebaseConflictError failure record
    const rebaseCalls = mockBuildFailureRecord.mock.calls.filter(
      (call: unknown[]) => (call[0] as Error)?.name === "RebaseConflictError",
    );
    expect(rebaseCalls).toHaveLength(0);
  });
});
