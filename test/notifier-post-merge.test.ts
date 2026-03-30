/**
 * notifyMergeReverted tests — formatting, gating, instance labels.
 *
 * All synthetic data — mocks sendNotification.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { notifyMergeReverted } from "../src/notifier.js";
import type { Job, DaemonConfig } from "../src/types.js";
import type { PostMergeVerifyResult } from "../src/worktree.js";
import { execFileSync } from "node:child_process";

const mockExec = vi.mocked(execFileSync);

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-001",
    triggeredBy: "manual",
    triggerDetail: "test",
    skills: ["implement", "qa"],
    projectDir: "/tmp/project",
    status: "complete",
    enqueuedAt: "2026-03-30T10:00:00.000Z",
    costUsd: 1.5,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: { dailyCostLimitUsd: 50, perJobCostLimitUsd: 10, maxJobsPerDay: 20 },
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: false },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
    logging: { level: "info", retainDays: 7 },
    ...overrides,
  };
}

function makeVerifyResult(overrides: Partial<PostMergeVerifyResult> = {}): PostMergeVerifyResult {
  return {
    verified: false,
    reverted: true,
    revertSha: "def456789",
    mergeSha: "abc123456",
    testOutput: "FAIL: something broke",
    testDurationMs: 5000,
    reason: "Post-merge tests failed",
    ...overrides,
  };
}

beforeEach(() => {
  mockExec.mockReset();
});

describe("notifyMergeReverted", () => {
  it("sends notification with correct title and message", () => {
    const job = makeJob();
    const config = makeConfig();
    const verifyResult = makeVerifyResult();

    notifyMergeReverted(job, verifyResult, config);

    expect(mockExec).toHaveBeenCalledOnce();
    const args = mockExec.mock.calls[0];
    expect(args[0]).toBe("osascript");
    const script = args[1]![1] as string;
    expect(script).toContain("MERGE REVERTED");
    expect(script).toContain("abc12345"); // truncated SHA
    expect(script).toContain("Bug TODO created");
    expect(script).toContain("/implement → /qa");
  });

  it("includes instance label when config.name is set", () => {
    const job = makeJob();
    const config = makeConfig({ name: "worker-1" });
    const verifyResult = makeVerifyResult();

    notifyMergeReverted(job, verifyResult, config);

    expect(mockExec).toHaveBeenCalledOnce();
    const script = mockExec.mock.calls[0][1]![1] as string;
    expect(script).toContain("[worker-1]");
  });

  it("no instance label when config.name is undefined", () => {
    const job = makeJob();
    const config = makeConfig();
    const verifyResult = makeVerifyResult();

    notifyMergeReverted(job, verifyResult, config);

    const script = mockExec.mock.calls[0][1]![1] as string;
    expect(script).not.toContain("[");
  });

  it("gated by notifications.enabled", () => {
    const job = makeJob();
    const config = makeConfig({ notifications: { enabled: false, onComplete: true, onError: true, onEscalation: false } });

    notifyMergeReverted(job, makeVerifyResult(), config);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("gated by notifications.onError", () => {
    const job = makeJob();
    const config = makeConfig({ notifications: { enabled: true, onComplete: true, onError: false, onEscalation: false } });

    notifyMergeReverted(job, makeVerifyResult(), config);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("handles single-skill job", () => {
    const job = makeJob({ skills: ["qa"] });
    const config = makeConfig();

    notifyMergeReverted(job, makeVerifyResult(), config);

    const script = mockExec.mock.calls[0][1]![1] as string;
    expect(script).toContain("/qa");
    expect(script).not.toContain("→");
  });

  it("handles long merge SHA (slices to 8 chars)", () => {
    const job = makeJob();
    const config = makeConfig();
    const verifyResult = makeVerifyResult({ mergeSha: "abcdef0123456789abcdef0123456789abcdef01" });

    notifyMergeReverted(job, verifyResult, config);

    const script = mockExec.mock.calls[0][1]![1] as string;
    expect(script).toContain("abcdef01");
    expect(script).not.toContain("abcdef0123456789");
  });

  it("does not throw when osascript fails", () => {
    mockExec.mockImplementation(() => {
      throw new Error("osascript not found");
    });

    expect(() => {
      notifyMergeReverted(makeJob(), makeVerifyResult(), makeConfig());
    }).not.toThrow();
  });
});
