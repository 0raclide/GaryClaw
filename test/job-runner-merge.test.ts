/**
 * Job Runner merge integration tests — auto-merge with validation config,
 * merge blocked notification, test duration logging, config passthrough.
 *
 * All synthetic data — mocks mergeWorktreeBranch and resolveBaseBranch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig, DaemonState } from "../src/types.js";
import type { MergeResult } from "../src/worktree.js";

// Mock worktree module
vi.mock("../src/worktree.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/worktree.js")>();
  return {
    ...orig,
    mergeWorktreeBranch: vi.fn().mockReturnValue({ merged: true, commitCount: 2 }),
    resolveBaseBranch: vi.fn().mockReturnValue("main"),
  };
});

// Mock dashboard to prevent file I/O
vi.mock("../src/dashboard.js", () => ({
  generateDashboard: vi.fn(),
}));

// Mock daemon-registry to prevent file I/O
vi.mock("../src/daemon-registry.js", () => ({
  readGlobalBudget: vi.fn().mockReturnValue({ date: "2026-03-29", totalUsd: 0, jobCount: 0, byInstance: {} }),
  updateGlobalBudget: vi.fn(),
  isSkillSetActive: vi.fn().mockReturnValue(false),
  getClaimedTodoTitles: vi.fn().mockReturnValue([]),
}));

import { mergeWorktreeBranch, resolveBaseBranch } from "../src/worktree.js";

const TEST_DIR = join(process.cwd(), ".test-jobrunner-merge-tmp");

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
    writeSummary: vi.fn(),
    log: vi.fn(),
  };
}

describe("Job Runner auto-merge with validation", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("passes validation config from DaemonConfig.merge to mergeWorktreeBranch", async () => {
    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { testCommand: "npm run ci-test", testTimeout: 90000 },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(mergeWorktreeBranch).toHaveBeenCalledWith(
      "/tmp/project",
      "builder",
      "main",
      expect.objectContaining({
        validation: {
          testCommand: "npm run ci-test",
          testTimeout: 90000,
        },
        jobId: expect.stringMatching(/^job-/),
      }),
    );
  });

  it("passes skipValidation when merge.skipValidation is true", async () => {
    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { skipValidation: true },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(mergeWorktreeBranch).toHaveBeenCalledWith(
      "/tmp/project",
      "builder",
      "main",
      expect.objectContaining({
        validation: { skipValidation: true },
      }),
    );
  });

  it("no merge config → no validation (backward compat, no tests)", async () => {
    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      // no merge field
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(mergeWorktreeBranch).toHaveBeenCalledWith(
      "/tmp/project",
      "builder",
      "main",
      expect.objectContaining({
        validation: undefined,
      }),
    );
  });

  it("logs test duration on successful merge with tests", async () => {
    const mockMerge = mergeWorktreeBranch as ReturnType<typeof vi.fn>;
    mockMerge.mockReturnValue({ merged: true, commitCount: 3, testsPassed: true, testDurationMs: 45000 });

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { testCommand: "npm test" },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const logCalls = deps.log.mock.calls.map((c: string[]) => c.join(" "));
    const mergeLog = logCalls.find((c: string) => c.includes("Auto-merge: merged"));
    expect(mergeLog).toContain("tests: 45s");
  });

  it("calls notifyMergeBlocked when merge is blocked", async () => {
    const mockMerge = mergeWorktreeBranch as ReturnType<typeof vi.fn>;
    const blockedResult: MergeResult = {
      merged: false,
      reason: "Pre-merge tests failed",
      testsPassed: false,
      testOutput: "FAIL: 3 tests failed",
      testDurationMs: 32000,
      commitCount: 2,
    };
    mockMerge.mockReturnValue(blockedResult);

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { testCommand: "npm test" },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(deps.notifyMergeBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ skills: ["qa"] }),
      blockedResult,
      config,
    );
  });

  it("job stays complete even when merge is blocked", async () => {
    const mockMerge = mergeWorktreeBranch as ReturnType<typeof vi.fn>;
    mockMerge.mockReturnValue({ merged: false, reason: "Pre-merge tests failed", testsPassed: false });

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { testCommand: "npm test" },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    const job = state.jobs[0];
    expect(job.status).toBe("complete"); // NOT "failed"
  });

  it("appends failure record for test failures (merge-failed category)", async () => {
    const mockMerge = mergeWorktreeBranch as ReturnType<typeof vi.fn>;
    mockMerge.mockReturnValue({ merged: false, reason: "Pre-merge tests failed", testsPassed: false });

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { testCommand: "npm test" },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const failuresPath = join(TEST_DIR, "failures.jsonl");
    expect(existsSync(failuresPath)).toBe(true);
    const lines = readFileSync(failuresPath, "utf-8").trim().split("\n");
    const record = JSON.parse(lines[lines.length - 1]);
    expect(record.errorName).toBe("MergeValidationError");
    expect(record.errorMessage).toBe("Pre-merge tests failed");
  });

  it("does not append failure record for rebase conflicts (no testsPassed=false)", async () => {
    const mockMerge = mergeWorktreeBranch as ReturnType<typeof vi.fn>;
    mockMerge.mockReturnValue({ merged: false, reason: "Rebase had conflicts" });

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { testCommand: "npm test" },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const failuresPath = join(TEST_DIR, "failures.jsonl");
    // Might not exist or be empty — no merge failure record should be written
    if (existsSync(failuresPath)) {
      const content = readFileSync(failuresPath, "utf-8").trim();
      if (content) {
        const records = content.split("\n").map(l => JSON.parse(l));
        const mergeRecords = records.filter((r: any) => r.errorName === "MergeValidationError");
        expect(mergeRecords).toHaveLength(0);
      }
    }
  });

  it("does not attempt merge for default instance", async () => {
    const config = createTestConfig({
      // No worktreePath — default instance
      merge: { testCommand: "npm test" },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "default");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(mergeWorktreeBranch).not.toHaveBeenCalled();
  });

  it("logs truncated test output in warn on merge blocked", async () => {
    const mockMerge = mergeWorktreeBranch as ReturnType<typeof vi.fn>;
    mockMerge.mockReturnValue({
      merged: false,
      reason: "Pre-merge tests failed",
      testsPassed: false,
      testOutput: "Error line 1\nError line 2\nError line 3",
    });

    const config = createTestConfig({
      worktreePath: "/tmp/project/.garyclaw/worktrees/builder",
      merge: { testCommand: "npm test" },
    });
    const deps = createMockDeps();
    const runner = createJobRunner(config, TEST_DIR, deps, "builder");

    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const warnCalls = deps.log.mock.calls
      .filter((c: string[]) => c[0] === "warn")
      .map((c: string[]) => c[1]);
    const mergeWarn = warnCalls.find((msg: string) => msg.includes("Auto-merge blocked"));
    expect(mergeWarn).toContain("Error line 1");
  });
});
