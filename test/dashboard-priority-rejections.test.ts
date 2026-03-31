/**
 * Dashboard priority pick rejection stats tests.
 */

import { describe, it, expect } from "vitest";
import { aggregateJobStats, formatDashboard } from "../src/dashboard.js";
import type { Job, DashboardData } from "../src/types.js";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    triggeredBy: "manual",
    triggerDetail: "test",
    skills: ["prioritize", "implement", "qa"],
    projectDir: "/tmp",
    status: "complete",
    enqueuedAt: "2026-03-31T10:00:00.000Z",
    costUsd: 0.5,
    ...overrides,
  };
}

describe("aggregateJobStats with priorityPickRejections", () => {
  it("counts jobs where priorityPickRejected is true", () => {
    const jobs: Job[] = [
      makeJob({ id: "j1", priorityPickRejected: true }),
      makeJob({ id: "j2", priorityPickRejected: true }),
      makeJob({ id: "j3" }),
    ];

    const stats = aggregateJobStats(jobs, "2026-03-31");
    expect(stats.priorityPickRejections).toBe(2);
  });

  it("returns 0 when no picks were rejected", () => {
    const jobs: Job[] = [
      makeJob({ id: "j1" }),
      makeJob({ id: "j2" }),
    ];

    const stats = aggregateJobStats(jobs, "2026-03-31");
    expect(stats.priorityPickRejections).toBe(0);
  });

  it("does not count priorityPickRejected: false", () => {
    const jobs: Job[] = [
      makeJob({ id: "j1", priorityPickRejected: false }),
      makeJob({ id: "j2", priorityPickRejected: true }),
    ];

    const stats = aggregateJobStats(jobs, "2026-03-31");
    expect(stats.priorityPickRejections).toBe(1);
  });

  it("only counts today's jobs", () => {
    const jobs: Job[] = [
      makeJob({ id: "j1", enqueuedAt: "2026-03-31T10:00:00.000Z", priorityPickRejected: true }),
      makeJob({ id: "j2", enqueuedAt: "2026-03-30T10:00:00.000Z", priorityPickRejected: true }),
    ];

    const stats = aggregateJobStats(jobs, "2026-03-31");
    expect(stats.priorityPickRejections).toBe(1);
  });
});

describe("formatDashboard with priority pick rejections", () => {
  function makeMinimalDashboard(rejections: number): DashboardData {
    return {
      generatedAt: "2026-03-31T12:00:00.000Z",
      healthScore: 80,
      topConcern: null,
      jobs: {
        total: 5,
        complete: 3,
        failed: 0,
        queued: 1,
        running: 0,
        rateLimited: 0,
        successRate: 60,
        totalCostUsd: 2.5,
        avgCostPerJob: 0.5,
        avgDurationSec: 120,
        failureBreakdown: {},
        crashRecoveries: 0,
        crashRecoverySavedUsd: 0,
        priorityPickRejections: rejections,
      },
      oracle: { totalDecisions: 0, accuracyPercent: 100, confidenceAvg: 0, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 100, dailySpentUsd: 2.5, dailyRemaining: 97.5, jobCount: 5, maxJobsPerDay: 50, byInstance: {} },
      adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
      bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
      mergeHealth: { totalAttempts: 0, merged: 0, blocked: 0, successRate: 100, avgTestDurationMs: 0, testFailures: 0, rebaseConflicts: 0 },
      instances: [],
    };
  }

  it("shows pick rejections row when count > 0", () => {
    const md = formatDashboard(makeMinimalDashboard(3));
    expect(md).toContain("Pick Rejections");
    expect(md).toContain("3 (completed-item gate)");
  });

  it("omits pick rejections row when count is 0", () => {
    const md = formatDashboard(makeMinimalDashboard(0));
    expect(md).not.toContain("Pick Rejections");
  });
});
