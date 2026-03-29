/**
 * Regression: ISSUE-002 — notifyJobResumed message format untested with notifications enabled
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * The existing test only checked the disabled path. This test verifies the
 * message format matches the contract: "Resuming /skill1 → /skill2 from
 * skill N/M (attempt X/2)"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job, DaemonConfig } from "../src/types.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { notifyJobResumed } from "../src/notifier.js";

function createTestJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-001",
    triggeredBy: "cron",
    triggerDetail: "0 */2 * * *",
    skills: ["prioritize", "implement", "qa"],
    projectDir: "/tmp/project",
    status: "running",
    enqueuedAt: "2026-03-29T10:00:00.000Z",
    startedAt: "2026-03-29T10:00:01.000Z",
    costUsd: 0,
    retryCount: 1,
    ...overrides,
  };
}

function createTestConfig(overrides: Partial<DaemonConfig["notifications"]> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: { dailyCostLimitUsd: 5, perJobCostLimitUsd: 1, maxJobsPerDay: 10 },
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: false, ...overrides },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
    logging: { level: "info", retainDays: 7 },
  };
}

describe("ISSUE-002: notifyJobResumed message format with notifications enabled", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
  });

  it("sends notification with correct resume message format", () => {
    const job = createTestJob({ retryCount: 1 });
    const config = createTestConfig();
    notifyJobResumed(job, 1, config); // 1 completed skill (prioritize)

    expect(execFileSync).toHaveBeenCalledOnce();
    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];

    // Title includes "Job Recovered"
    expect(script).toContain("Job Recovered");

    // Message format: "Resuming /prioritize → /implement → /qa from skill 2/3 (attempt 1/2)"
    expect(script).toContain("Resuming");
    expect(script).toContain("/prioritize");
    expect(script).toContain("/implement");
    expect(script).toContain("/qa");
    expect(script).toContain("from skill 2/3");
    expect(script).toContain("attempt 1/2");
  });

  it("includes instance name in title when config.name is set", () => {
    const job = createTestJob({ retryCount: 1 });
    const config = createTestConfig();
    config.name = "worker-1";
    notifyJobResumed(job, 1, config);

    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];
    expect(script).toContain("[worker-1]");
    expect(script).toContain("Job Recovered");
  });

  it("formats correctly for second retry attempt", () => {
    const job = createTestJob({ retryCount: 2 });
    const config = createTestConfig();
    notifyJobResumed(job, 0, config); // 0 completed skills (crashed on first)

    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];
    expect(script).toContain("from skill 1/3");
    expect(script).toContain("attempt 2/2");
  });

  it("skips when onComplete disabled (resume uses onComplete gate)", () => {
    const job = createTestJob({ retryCount: 1 });
    const config = createTestConfig({ onComplete: false });
    notifyJobResumed(job, 1, config);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("skips when notifications globally disabled", () => {
    const job = createTestJob({ retryCount: 1 });
    const config = createTestConfig({ enabled: false });
    notifyJobResumed(job, 1, config);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
