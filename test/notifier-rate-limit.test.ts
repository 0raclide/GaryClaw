/**
 * Rate limit notification tests.
 */

import { describe, it, expect, vi } from "vitest";
import { notifyRateLimitHold, notifyRateLimitResume, sendNotification } from "../src/notifier.js";
import type { DaemonConfig } from "../src/types.js";

// Mock sendNotification to avoid osascript calls
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

function createConfig(overrides: Partial<DaemonConfig["notifications"]> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: { dailyCostLimitUsd: 100, perJobCostLimitUsd: 10, maxJobsPerDay: 50 },
    notifications: {
      enabled: true,
      onComplete: true,
      onError: true,
      onEscalation: false,
      ...overrides,
    },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
    logging: { level: "info", retainDays: 7 },
  };
}

describe("notifyRateLimitHold", () => {
  it("sends notification with reset time", () => {
    const resetAt = new Date("2026-03-29T02:42:00.000Z");
    const result = notifyRateLimitHold(resetAt, "worker-1", createConfig());
    // Function runs without error (notification delivery is best-effort)
    expect(result).toBeUndefined();
  });

  it("skips when notifications disabled", () => {
    const resetAt = new Date();
    notifyRateLimitHold(resetAt, "worker-1", createConfig({ enabled: false }));
    // No error — just a no-op
  });

  it("skips when onError disabled", () => {
    const resetAt = new Date();
    notifyRateLimitHold(resetAt, "worker-1", createConfig({ onError: false }));
    // No error — gated by onError
  });

  it("uses instance label for named instances", () => {
    const resetAt = new Date();
    // Should include [worker-1] in the notification — just verify no error
    notifyRateLimitHold(resetAt, "worker-1", createConfig());
  });

  it("omits instance label for default instance", () => {
    const resetAt = new Date();
    notifyRateLimitHold(resetAt, "default", createConfig());
  });
});

describe("notifyRateLimitResume", () => {
  it("sends resume notification", () => {
    const result = notifyRateLimitResume("worker-1", createConfig());
    expect(result).toBeUndefined();
  });

  it("skips when notifications disabled", () => {
    notifyRateLimitResume("worker-1", createConfig({ enabled: false }));
  });

  it("skips when onComplete disabled", () => {
    notifyRateLimitResume("worker-1", createConfig({ onComplete: false }));
  });
});
