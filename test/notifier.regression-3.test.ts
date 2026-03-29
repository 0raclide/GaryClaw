/**
 * Regression: ISSUE-002 — notifyRateLimitHold/Resume were defined on interface but never implemented.
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * Rate limit notifications silently no-oped because the functions didn't exist in notifier.ts
 * and weren't wired into defaultDeps.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DaemonConfig } from "../src/types.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { notifyRateLimitHold, notifyRateLimitResume } from "../src/notifier.js";

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

describe("notifyRateLimitHold", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
  });

  it("sends notification with reset time", () => {
    const config = createTestConfig();
    const resetAt = new Date("2026-03-29T15:42:00Z");
    notifyRateLimitHold(resetAt, "default", config);

    expect(execFileSync).toHaveBeenCalledOnce();
    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];
    expect(script).toContain("Rate Limited");
    expect(script).toContain("Holding all jobs until");
  });

  it("includes instance label for named instances", () => {
    const config = createTestConfig();
    notifyRateLimitHold(new Date(), "worker-1", config);

    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];
    expect(script).toContain("[worker-1]");
  });

  it("omits instance label for default instance", () => {
    const config = createTestConfig();
    notifyRateLimitHold(new Date(), "default", config);

    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];
    expect(script).not.toContain("[default]");
  });

  it("skips when notifications disabled", () => {
    const config = createTestConfig({ enabled: false });
    notifyRateLimitHold(new Date(), "default", config);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("skips when onError disabled (rate limit is an error condition)", () => {
    const config = createTestConfig({ onError: false });
    notifyRateLimitHold(new Date(), "default", config);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe("notifyRateLimitResume", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
  });

  it("sends resume notification", () => {
    const config = createTestConfig();
    notifyRateLimitResume("default", config);

    expect(execFileSync).toHaveBeenCalledOnce();
    const args = vi.mocked(execFileSync).mock.calls[0][1] as string[];
    const script = args[1];
    expect(script).toContain("Resumed");
    expect(script).toContain("jobs resuming");
  });

  it("skips when onComplete disabled (resume is a positive event)", () => {
    const config = createTestConfig({ onComplete: false });
    notifyRateLimitResume("default", config);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
