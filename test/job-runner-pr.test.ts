/**
 * Job Runner PR strategy tests — strategy routing, PR creation, TODO state
 * advancement to "pr-created", fallback to direct merge, and notification.
 *
 * All synthetic data — mocks worktree, dashboard, daemon-registry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig } from "../src/types.js";

// Mock child_process for PR strategy pre-merge tests
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    execFileSync: vi.fn().mockReturnValue(""),
  };
});

// Mock worktree module
vi.mock("../src/worktree.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/worktree.js")>();
  return {
    ...orig,
    mergeWorktreeBranch: vi.fn().mockReturnValue({ merged: true, commitCount: 2 }),
    resolveBaseBranch: vi.fn().mockReturnValue("main"),
    createPullRequest: vi.fn().mockReturnValue({
      created: true,
      prNumber: 42,
      prUrl: "https://github.com/test/repo/pull/42",
      autoMergeEnabled: true,
    }),
    buildPrBody: vi.fn().mockReturnValue("## PR Body"),
    appendMergeAudit: vi.fn(),
    branchName: vi.fn((name: string) => `garyclaw/${name}`),
    isGhAvailable: vi.fn().mockReturnValue(true),
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

// Mock todo-state to track writes
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

// Mock failure-taxonomy
vi.mock("../src/failure-taxonomy.js", () => ({
  classifyError: vi.fn().mockReturnValue("unknown"),
  buildFailureRecord: vi.fn().mockReturnValue({ category: "unknown" }),
  appendFailureRecord: vi.fn(),
}));

import { mergeWorktreeBranch, createPullRequest } from "../src/worktree.js";
import { writeTodoState } from "../src/todo-state.js";
import { execFileSync } from "node:child_process";

const TEST_DIR = join(process.cwd(), ".test-jobrunner-pr-tmp");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    worktreePath: "/tmp/project/.garyclaw/worktrees/worker-1",
    name: "worker-1",
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
    notifyPrCreated: vi.fn(),
    notifyRateLimitHold: vi.fn(),
    notifyRateLimitResume: vi.fn(),
    writeSummary: vi.fn(),
    log: vi.fn(),
  };
}

describe("Job Runner PR strategy routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('strategy "pr" calls createPullRequest instead of mergeWorktreeBranch', async () => {
    const config = createTestConfig({ merge: { strategy: "pr" } });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(createPullRequest).toHaveBeenCalled();
    expect(mergeWorktreeBranch).not.toHaveBeenCalled();
  });

  it('strategy "direct" calls mergeWorktreeBranch (existing behavior)', async () => {
    const config = createTestConfig({ merge: { strategy: "direct" } });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(mergeWorktreeBranch).toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("undefined strategy defaults to direct merge", async () => {
    const config = createTestConfig({ merge: {} });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(mergeWorktreeBranch).toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("PR strategy passes config options to createPullRequest", async () => {
    const config = createTestConfig({
      merge: {
        strategy: "pr",
        prAutoMerge: false,
        prMergeMethod: "rebase",
        prLabels: ["bot"],
        prReviewers: ["alice"],
        prDraft: true,
      },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const callArgs = (createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = callArgs[2]; // third arg is PullRequestOptions
    expect(options.autoMerge).toBe(false);
    expect(options.mergeMethod).toBe("rebase");
    expect(options.labels).toEqual(["bot"]);
    expect(options.reviewers).toEqual(["alice"]);
    expect(options.draft).toBe(true);
  });

  it('advances TODO state to "pr-created" after successful PR', async () => {
    const config = createTestConfig({ merge: { strategy: "pr" } });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    // Enqueue with a todo title (simulate post-prioritize claiming)
    const jobId = runner.enqueue(["qa"], "manual", "test");
    // Manually set claimedTodoTitle on the job
    const state = runner.getState();
    const job = state.jobs.find((j) => j.id === jobId);
    if (job) job.claimedTodoTitle = "P3: Test Feature";

    await runner.processNext();

    expect(writeTodoState).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ state: "pr-created" }),
    );
  });

  it("notifies on PR creation", async () => {
    const config = createTestConfig({ merge: { strategy: "pr" } });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(deps.notifyPrCreated).toHaveBeenCalled();
  });

  it("falls back to direct merge when PR creation fails", async () => {
    (createPullRequest as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      created: false,
      reason: "gh CLI not available",
    });

    const config = createTestConfig({ merge: { strategy: "pr" } });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(mergeWorktreeBranch).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("warn", expect.stringContaining("falling back to direct merge"));
  });

  it("PR title includes TODO title when available", async () => {
    const config = createTestConfig({ merge: { strategy: "pr" } });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    const jobId = runner.enqueue(["implement", "qa"], "manual", "test");
    const state = runner.getState();
    const job = state.jobs.find((j) => j.id === jobId);
    if (job) job.claimedTodoTitle = "P3: GitHub PR Workflow";

    await runner.processNext();

    const callArgs = (createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[2].title).toContain("GitHub PR Workflow");
  });

  // Regression: ISSUE-004 — PR title truncation at 256 chars
  // Found by /qa on 2026-03-30
  // Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
  it("truncates PR title to 256 characters for GitHub limit", async () => {
    const config = createTestConfig({ merge: { strategy: "pr" } });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    const jobId = runner.enqueue(["qa"], "manual", "test");
    const state = runner.getState();
    const job = state.jobs.find((j) => j.id === jobId);
    // Create a title that exceeds 256 chars when prefixed with "GaryClaw: "
    if (job) job.claimedTodoTitle = "P1: " + "A".repeat(300);

    await runner.processNext();

    const callArgs = (createPullRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[2].title.length).toBeLessThanOrEqual(256);
    expect(callArgs[2].title).toMatch(/^GaryClaw: P1: A+$/);
  });

  it("skips PR creation when pre-merge tests fail", async () => {
    // Make execFileSync throw for the test command (sh -c "npm test")
    (execFileSync as ReturnType<typeof vi.fn>).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "sh") throw new Error("tests failed");
      return "";
    });

    const config = createTestConfig({
      merge: { strategy: "pr", testCommand: "npm test" },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "worker-1");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(createPullRequest).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("warn", expect.stringContaining("Pre-merge tests failed"));
  });
});
