/**
 * Dashboard rate limit display tests.
 */

import { describe, it, expect } from "vitest";
import { aggregateJobStats, formatDashboard } from "../src/dashboard.js";
import type { Job, DashboardData } from "../src/types.js";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    triggeredBy: "manual",
    triggerDetail: "test",
    skills: ["qa"],
    projectDir: "/tmp",
    status: "complete",
    enqueuedAt: "2026-03-29T10:00:00.000Z",
    costUsd: 0.5,
    ...overrides,
  };
}

describe("aggregateJobStats with rate_limited", () => {
  it("counts rate_limited jobs", () => {
    const jobs: Job[] = [
      makeJob({ id: "j1", status: "complete" }),
      makeJob({ id: "j2", status: "rate_limited" }),
      makeJob({ id: "j3", status: "rate_limited" }),
      makeJob({ id: "j4", status: "queued" }),
    ];

    const stats = aggregateJobStats(jobs, "2026-03-29");
    expect(stats.rateLimited).toBe(2);
    expect(stats.complete).toBe(1);
    expect(stats.queued).toBe(1);
    expect(stats.total).toBe(4);
  });

  it("returns 0 rate_limited when none exist", () => {
    const jobs: Job[] = [
      makeJob({ id: "j1", status: "complete" }),
      makeJob({ id: "j2", status: "failed" }),
    ];

    const stats = aggregateJobStats(jobs, "2026-03-29");
    expect(stats.rateLimited).toBe(0);
  });

  it("rate_limited jobs do not affect success rate calculation", () => {
    // 1 complete + 1 rate_limited out of 2 total
    const jobs: Job[] = [
      makeJob({ id: "j1", status: "complete" }),
      makeJob({ id: "j2", status: "rate_limited" }),
    ];

    const stats = aggregateJobStats(jobs, "2026-03-29");
    // successRate = complete / total * 100 = 1/2 * 100 = 50
    expect(stats.successRate).toBe(50);
  });
});

describe("formatDashboard with rate_limited", () => {
  function makeMinimalDashboard(rateLimited: number): DashboardData {
    return {
      generatedAt: "2026-03-29T12:00:00.000Z",
      healthScore: 80,
      topConcern: null,
      jobs: {
        total: 5,
        complete: 3,
        failed: 0,
        queued: 1,
        running: 0,
        rateLimited,
        successRate: 60,
        totalCostUsd: 2.5,
        avgCostPerJob: 0.5,
        avgDurationSec: 120,
        failureBreakdown: {},
        crashRecoveries: 0,
        crashRecoverySavedUsd: 0,
      },
      oracle: { totalDecisions: 0, accuracyPercent: 100, confidenceAvg: 0, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 100, dailySpentUsd: 2.5, dailyRemaining: 97.5, jobCount: 5, maxJobsPerDay: 50, byInstance: {} },
      adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
      bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
      mergeHealth: { totalAttempts: 0, merged: 0, blocked: 0, successRate: 100, avgTestDurationMs: 0, testFailures: 0, rebaseConflicts: 0 },
      instances: [],
    };
  }

  it("shows rate limited row when count > 0", () => {
    const md = formatDashboard(makeMinimalDashboard(2));
    expect(md).toContain("Rate Limited");
    expect(md).toContain("2 (held)");
  });

  it("omits rate limited row when count is 0", () => {
    const md = formatDashboard(makeMinimalDashboard(0));
    expect(md).not.toContain("Rate Limited");
  });
});
