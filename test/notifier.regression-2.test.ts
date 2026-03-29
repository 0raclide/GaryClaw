/**
 * Regression: ISSUE-003a — notifyMergeBlocked formatting, gating, instance labels.
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * The notifyMergeBlocked function had no dedicated tests despite every other
 * notification function being tested in notifier.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job, DaemonConfig, MergeResult } from "../src/types.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { notifyMergeBlocked } from "../src/notifier.js";

function createTestJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-001",
    triggeredBy: "manual",
    triggerDetail: "CLI trigger",
    skills: ["qa"],
    projectDir: "/tmp/project",
    status: "complete",
    enqueuedAt: "2026-03-25T10:00:00.000Z",
    startedAt: "2026-03-25T10:00:01.000Z",
    completedAt: "2026-03-25T10:30:00.000Z",
    costUsd: 0.125,
    ...overrides,
  };
}

function createTestConfig(overrides: Partial<DaemonConfig["notifications"]> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: { dailyCostLimitUsd: 5, perJobCostLimitUsd: 1, maxJobsPerDay: 10 },
    notifications: {
      enabled: true,
      onComplete: true,
      onError: true,
      onEscalation: true,
      ...overrides,
    },
    orchestrator: {
      maxTurnsPerSegment: 15,
      relayThresholdRatio: 0.85,
      maxRelaySessions: 10,
      askTimeoutMs: 300000,
    },
    logging: { level: "info", retainDays: 7 },
  };
}

describe("notifyMergeBlocked", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
  });

  it("sends notification when pre-merge tests fail", () => {
    const job = createTestJob({ skills: ["implement", "qa"] });
    const config = createTestConfig();
    const result: MergeResult = {
      merged: false,
      reason: "Pre-merge tests failed",
      testsPassed: false,
      testOutput: "FAIL src/foo.test.ts",
    };
    notifyMergeBlocked(job, result, config);

    expect(execFileSync).toHaveBeenCalledOnce();
    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];
    expect(script).toContain("Merge Blocked");
    expect(script).toContain("pre-merge tests failed");
  });

  it("sends notification with rebase conflict reason", () => {
    const job = createTestJob();
    const config = createTestConfig();
    const result: MergeResult = {
      merged: false,
      reason: "Rebase of garyclaw/worker onto main had conflicts",
    };
    notifyMergeBlocked(job, result, config);

    expect(execFileSync).toHaveBeenCalledOnce();
    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];
    expect(script).toContain("Rebase of garyclaw/worker onto main had conflicts");
  });

  it("includes instance label when config.name is set", () => {
    const job = createTestJob();
    const config = createTestConfig();
    config.name = "review-bot";
    const result: MergeResult = { merged: false, reason: "conflict", testsPassed: false };
    notifyMergeBlocked(job, result, config);

    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];
    expect(script).toContain("[review-bot]");
    expect(script).toContain("Merge Blocked");
  });

  it("skips when notifications disabled", () => {
    const job = createTestJob();
    const config = createTestConfig({ enabled: false });
    const result: MergeResult = { merged: false, reason: "conflict" };
    notifyMergeBlocked(job, result, config);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("skips when onError disabled (merge block gated by onError)", () => {
    const job = createTestJob();
    const config = createTestConfig({ onError: false });
    const result: MergeResult = { merged: false, reason: "conflict" };
    notifyMergeBlocked(job, result, config);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("formats multi-skill pipeline in message body", () => {
    const job = createTestJob({ skills: ["prioritize", "implement", "qa"] });
    const config = createTestConfig();
    const result: MergeResult = { merged: false, reason: "conflict", testsPassed: false };
    notifyMergeBlocked(job, result, config);

    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];
    expect(script).toContain("/prioritize");
    expect(script).toContain("/implement");
    expect(script).toContain("/qa");
  });

  it("uses 'unknown reason' fallback when reason is undefined and testsPassed is not false", () => {
    const job = createTestJob();
    const config = createTestConfig();
    const result: MergeResult = { merged: false };
    notifyMergeBlocked(job, result, config);

    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];
    expect(script).toContain("unknown reason");
  });
});
