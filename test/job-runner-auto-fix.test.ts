/**
 * Job Runner auto-fix integration tests — enqueue after revert, cost accumulation,
 * skipComposition, post-merge-revert triggeredBy.
 *
 * All synthetic data — mocks worktree, child_process, dashboard, and daemon-registry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { handlePostMergeVerification } from "../src/job-runner.js";
import type { PostMergeVerificationContext } from "../src/job-runner.js";
import type { DaemonConfig, Job } from "../src/types.js";

// ── Mocks ──────────────────────────────────────────────────────

// Mock worktree module
vi.mock("../src/worktree.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/worktree.js")>();
  return {
    ...orig,
    mergeWorktreeBranch: vi.fn().mockReturnValue({ merged: true, commitCount: 2 }),
    resolveBaseBranch: vi.fn().mockReturnValue("main"),
    verifyPostMerge: vi.fn().mockReturnValue({
      verified: false,
      reverted: true,
      mergeSha: "abc123def456",
      revertSha: "rev789aaa",
      testOutput: "FAIL: test/foo.test.ts > bar > should pass",
      testDurationMs: 5000,
      reason: "Post-merge tests failed",
    }),
    appendMergeRevert: vi.fn(),
    branchName: vi.fn((name: string) => `garyclaw/${name}`),
    appendMergeAudit: vi.fn(),
  };
});

// Mock child_process
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    execFileSync: vi.fn((...args: unknown[]) => {
      if (args[0] === "git" && Array.isArray(args[1]) && args[1].includes("rev-parse") && args[1].includes("HEAD")) {
        return "abc123def456\n";
      }
      return (orig.execFileSync as Function)(...args);
    }),
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

// Mock auto-fix module to track calls
const mockMaybeEnqueue = vi.fn().mockReturnValue({ enqueued: true, reason: "enqueued" });
const mockUpdateCost = vi.fn();
vi.mock("../src/auto-fix.js", () => ({
  maybeEnqueueAutoFix: (...args: unknown[]) => mockMaybeEnqueue(...args),
  updateAutoFixCost: (...args: unknown[]) => mockUpdateCost(...args),
}));

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-jr-autofix-test");

function makeConfig(overrides: Partial<DaemonConfig["merge"]> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: TMP,
    triggers: [],
    budget: { dailyCostLimitUsd: 50, perJobCostLimitUsd: 10, maxJobsPerDay: 20 },
    notifications: { enabled: false, onComplete: false, onError: false, onEscalation: false },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 30000 },
    logging: { level: "info", retainDays: 7 },
    merge: {
      forcePostMergeVerification: true,
      autoFixOnRevert: true,
      ...overrides,
    },
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-001",
    triggeredBy: "continuous",
    triggerDetail: "test",
    skills: ["implement", "qa"],
    projectDir: TMP,
    status: "complete",
    enqueuedAt: new Date().toISOString(),
    costUsd: 4.0,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PostMergeVerificationContext> = {}): PostMergeVerificationContext {
  const config = makeConfig();
  return {
    projectDir: TMP,
    instanceName: "worker-1",
    jobId: "job-001",
    skills: ["implement", "qa"],
    checkpointDir: TMP,
    mergeConfig: config.merge,
    testsPassed: undefined, // force verification (not pre-merge passed)
    commitCount: 3,
    log: vi.fn(),
    notifyMergeReverted: vi.fn(),
    job: makeJob(),
    config,
    enqueue: vi.fn().mockReturnValue("job-fix-001"),
    ...overrides,
  };
}

describe("job-runner auto-fix integration", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    writeFileSync(join(TMP, "TODOS.md"), "# TODOs\n");
    mockMaybeEnqueue.mockClear();
    mockUpdateCost.mockClear();
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("calls maybeEnqueueAutoFix after revert when enqueue is provided", () => {
    const ctx = makeCtx();
    handlePostMergeVerification(ctx);

    expect(mockMaybeEnqueue).toHaveBeenCalledTimes(1);
    const callArg = mockMaybeEnqueue.mock.calls[0][0];
    expect(callArg.mergeSha).toBe("abc123def456");
    expect(callArg.jobCost).toBe(4.0);
    expect(callArg.config.autoFixOnRevert).toBe(true);
  });

  it("does not call maybeEnqueueAutoFix when enqueue is not provided", () => {
    const ctx = makeCtx({ enqueue: undefined });
    handlePostMergeVerification(ctx);

    expect(mockMaybeEnqueue).not.toHaveBeenCalled();
  });

  it("passes testOutput to maybeEnqueueAutoFix", () => {
    const ctx = makeCtx();
    handlePostMergeVerification(ctx);

    const callArg = mockMaybeEnqueue.mock.calls[0][0];
    expect(callArg.testOutput).toContain("FAIL");
  });

  it("passes revertSha to maybeEnqueueAutoFix", () => {
    const ctx = makeCtx();
    handlePostMergeVerification(ctx);

    const callArg = mockMaybeEnqueue.mock.calls[0][0];
    expect(callArg.revertSha).toBe("rev789aaa");
  });

  it("logs info when auto-fix is enqueued", () => {
    const ctx = makeCtx();
    handlePostMergeVerification(ctx);

    expect(ctx.log).toHaveBeenCalledWith("info", expect.stringContaining("Auto-fix loop activated"));
  });

  it("does not log activation when auto-fix is not enqueued", () => {
    mockMaybeEnqueue.mockReturnValueOnce({ enqueued: false, reason: "autoFixOnRevert disabled" });
    const ctx = makeCtx();
    handlePostMergeVerification(ctx);

    // Should not have the activation log
    const logCalls = (ctx.log as ReturnType<typeof vi.fn>).mock.calls;
    const activationLogs = logCalls.filter(([, msg]: [string, string]) =>
      typeof msg === "string" && msg.includes("Auto-fix loop activated"));
    expect(activationLogs).toHaveLength(0);
  });

  it("swallows errors from maybeEnqueueAutoFix", () => {
    mockMaybeEnqueue.mockImplementationOnce(() => { throw new Error("boom"); });
    const ctx = makeCtx();

    // Should not throw
    expect(() => handlePostMergeVerification(ctx)).not.toThrow();
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("Auto-fix enqueue failed"));
  });

  it("passes autoFixOnRevert: false when merge config lacks it", () => {
    const config = makeConfig();
    delete config.merge!.autoFixOnRevert;
    const ctx = makeCtx({ mergeConfig: config.merge, config });
    handlePostMergeVerification(ctx);

    const callArg = mockMaybeEnqueue.mock.calls[0][0];
    expect(callArg.config.autoFixOnRevert).toBe(false);
  });

  // ── triggeredBy === "post-merge-revert" type check ──────────────

  it("post-merge-revert is a valid triggeredBy value", () => {
    const job: Pick<Job, "triggeredBy"> = { triggeredBy: "post-merge-revert" };
    expect(job.triggeredBy).toBe("post-merge-revert");
  });

  it("auto-fix jobs skip composition via triggeredBy check", () => {
    // This test verifies the type — the actual composition skip is tested
    // in the job-runner-skip-composition tests.
    const job = makeJob({ triggeredBy: "post-merge-revert" });
    // The composition skip check in processNext is:
    // nextJob.skipComposition || nextJob.triggeredBy === "post-merge-revert"
    expect(job.triggeredBy === "post-merge-revert").toBe(true);
  });
});
