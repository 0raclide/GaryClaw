/**
 * Regression test: bug TODO branch name must use branchName() sanitization.
 *
 * Before fix: handlePostMergeVerification hardcoded `garyclaw/${instanceName}`
 * in the TODO body, but the audit log correctly used branchName() which runs
 * sanitizeBranchComponent(). Instance names with special characters (spaces,
 * dots, control chars) would produce a wrong branch reference in the TODO.
 *
 * Found by /qa on 2026-03-30
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Mock worktree module — branchName must sanitize
vi.mock("../src/worktree.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/worktree.js")>();
  return {
    ...orig,
    verifyPostMerge: vi.fn().mockReturnValue({ verified: false, reverted: true, revertSha: "rev1", mergeSha: "abc", reason: "tests failed", testOutput: "FAIL" }),
    appendMergeRevert: vi.fn(),
    // Real sanitization: spaces → dashes, dots collapsed, etc.
    branchName: vi.fn((name: string) => `garyclaw/${name.replace(/[\s.]+/g, "-").replace(/-{2,}/g, "-")}`),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return { ...orig, execFileSync: vi.fn(() => "abc123\n") };
});

vi.mock("../src/failure-taxonomy.js", () => ({
  classifyError: vi.fn().mockReturnValue("unknown"),
  buildFailureRecord: vi.fn().mockReturnValue({ category: "test-failure", jobId: "j1", skills: ["qa"], timestamp: new Date().toISOString() }),
  appendFailureRecord: vi.fn(),
}));

import { handlePostMergeVerification } from "../src/job-runner.js";
import { verifyPostMerge } from "../src/worktree.js";
import type { DaemonConfig, Job } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-postmerge-branch-regression-tmp");

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-001", skills: ["implement", "qa"], status: "running",
    triggeredBy: "manual", triggerDetail: "test", createdAt: new Date().toISOString(), costUsd: 0,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1, projectDir: TEST_DIR, triggers: [],
    budget: { dailyCostLimitUsd: 50, perJobCostLimitUsd: 10, maxJobsPerDay: 20 },
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: false },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
    logging: { level: "info", retainDays: 7 },
    ...overrides,
  };
}

describe("Bug TODO branch name sanitization", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "TODOS.md"), "# TODOs\n");
    vi.clearAllMocks();
    (verifyPostMerge as ReturnType<typeof vi.fn>).mockReturnValue({
      verified: false, reverted: true, revertSha: "rev1", mergeSha: "abc",
      reason: "tests failed", testOutput: "FAIL",
    });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("uses branchName() in TODO body for instance names with spaces", () => {
    handlePostMergeVerification({
      projectDir: TEST_DIR, instanceName: "worker one",
      jobId: "j1", skills: ["qa"], checkpointDir: TEST_DIR,
      commitCount: 1, log: vi.fn(), job: makeJob(), config: makeConfig(),
    });

    const content = readFileSync(join(TEST_DIR, "TODOS.md"), "utf-8");
    // Should be sanitized: "worker one" → "worker-one"
    expect(content).toContain("`garyclaw/worker-one`");
    // Must NOT contain the raw unsanitized name in the branch field
    expect(content).not.toContain("`garyclaw/worker one`");
  });

  it("uses branchName() in TODO body for instance names with dots", () => {
    handlePostMergeVerification({
      projectDir: TEST_DIR, instanceName: "worker..2",
      jobId: "j2", skills: ["qa"], checkpointDir: TEST_DIR,
      commitCount: 1, log: vi.fn(), job: makeJob(), config: makeConfig(),
    });

    const content = readFileSync(join(TEST_DIR, "TODOS.md"), "utf-8");
    // Dots collapsed: "worker..2" → "worker-2"
    expect(content).toContain("`garyclaw/worker-2`");
    expect(content).not.toContain("`garyclaw/worker..2`");
  });

  it("simple instance names pass through unchanged", () => {
    handlePostMergeVerification({
      projectDir: TEST_DIR, instanceName: "worker-1",
      jobId: "j3", skills: ["qa"], checkpointDir: TEST_DIR,
      commitCount: 1, log: vi.fn(), job: makeJob(), config: makeConfig(),
    });

    const content = readFileSync(join(TEST_DIR, "TODOS.md"), "utf-8");
    expect(content).toContain("`garyclaw/worker-1`");
  });
});
