/**
 * Regression tests for dashboard.ts edge cases.
 *
 * ISSUE-001 — aggregateJobStats: partial timestamps, missing failureCategory
 * ISSUE-002 — formatDuration: seconds that round to 60
 * ISSUE-003 — formatDashboard: dailyLimitUsd=0, topConcern=null with failures
 *
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 */

import { describe, it, expect } from "vitest";
import {
  aggregateJobStats,
  formatDuration,
  formatDashboard,
  computeHealthScore,
} from "../src/dashboard.js";
import type { Job, DashboardData } from "../src/types.js";

// ── aggregateJobStats edge cases ───────────────────────────────

describe("aggregateJobStats edge cases", () => {
  const today = "2026-03-27";

  function makeJob(overrides: Partial<Job>): Job {
    return {
      id: "job-1",
      skills: ["qa"],
      status: "complete",
      enqueuedAt: `${today}T10:00:00Z`,
      costUsd: 0.05,
      ...overrides,
    } as Job;
  }

  it("ignores failed jobs with no failureCategory in breakdown (but counts them)", () => {
    const jobs: Job[] = [
      makeJob({ id: "j1", status: "failed", failureCategory: undefined }),
      makeJob({ id: "j2", status: "failed", failureCategory: "timeout" }),
    ];
    const result = aggregateJobStats(jobs, today);
    expect(result.failed).toBe(2);
    // Only the one with a category appears in breakdown
    expect(result.failureBreakdown).toEqual({ timeout: 1 });
  });

  it("computes avgDurationSec=0 when failed jobs lack startedAt", () => {
    const jobs: Job[] = [
      makeJob({
        id: "j1",
        status: "failed",
        startedAt: undefined,
        completedAt: "2026-03-27T10:05:00Z",
      }),
    ];
    const result = aggregateJobStats(jobs, today);
    // No jobs have BOTH timestamps → avgDurationSec is 0
    expect(result.avgDurationSec).toBe(0);
  });

  it("computes avgDurationSec=0 when jobs have startedAt but no completedAt", () => {
    const jobs: Job[] = [
      makeJob({
        id: "j1",
        status: "running",
        startedAt: "2026-03-27T10:00:00Z",
        completedAt: undefined,
      }),
    ];
    const result = aggregateJobStats(jobs, today);
    expect(result.avgDurationSec).toBe(0);
  });

  it("computes avgDurationSec only from finished jobs with both timestamps", () => {
    const jobs: Job[] = [
      makeJob({
        id: "j1",
        status: "complete",
        startedAt: "2026-03-27T10:00:00Z",
        completedAt: "2026-03-27T10:01:00Z",
      }),
      makeJob({
        id: "j2",
        status: "failed",
        startedAt: undefined,
        completedAt: "2026-03-27T10:05:00Z",
      }),
    ];
    const result = aggregateJobStats(jobs, today);
    // Only j1 qualifies — 60 seconds
    expect(result.avgDurationSec).toBe(60);
  });

  it("handles empty job list", () => {
    const result = aggregateJobStats([], today);
    expect(result.total).toBe(0);
    expect(result.successRate).toBe(100); // No failures = 100%
    expect(result.avgCostPerJob).toBe(0);
    expect(result.avgDurationSec).toBe(0);
    expect(result.failureBreakdown).toEqual({});
  });
});

// ── formatDuration edge cases ──────────────────────────────────

describe("formatDuration edge cases", () => {
  it("renders 59.6 seconds as '1m 0s' (rounds total then decomposes)", () => {
    // Before fix: Math.round(59.6 % 60) = 60 → displayed "60s"
    // After fix: Math.round(59.6) = 60 → m=1, s=0 → "1m 0s"
    expect(formatDuration(59.6)).toBe("1m 0s");
  });

  it("renders exactly 60 seconds as '1m 0s'", () => {
    expect(formatDuration(60)).toBe("1m 0s");
  });

  it("renders 0.4 seconds as '0s' (rounds to 0, but input > 0)", () => {
    // Math.round(0.4) = 0, m=0, s=0 → "0s"
    expect(formatDuration(0.4)).toBe("0s");
  });

  it("renders 119.5 seconds as '2m 0s' (no '1m 60s' quirk)", () => {
    // Before fix: m=1, s=Math.round(59.5)=60 → "1m 60s"
    // After fix: Math.round(119.5)=120, m=2, s=0 → "2m 0s"
    expect(formatDuration(119.5)).toBe("2m 0s");
  });
});

// ── computeHealthScore edge cases ──────────────────────────────

describe("computeHealthScore edge cases", () => {
  it("handles dailyLimitUsd=0 (budget unlimited)", () => {
    const data = {
      jobs: {
        total: 5, complete: 5, failed: 0, queued: 0, running: 0,
        successRate: 100, totalCostUsd: 1.0, avgCostPerJob: 0.2,
        avgDurationSec: 60, failureBreakdown: {},
      },
      oracle: {
        totalDecisions: 0, accuracyPercent: 0, confidenceAvg: 0,
        circuitBreakerTripped: false,
      },
      budget: {
        dailyLimitUsd: 0, dailySpentUsd: 0, dailyRemaining: 0,
        jobCount: 5, maxJobsPerDay: 100, byInstance: {},
      },
      adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
      bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
      instances: [],
    };
    const { score } = computeHealthScore(data);
    // Budget headroom should be 100 when limit is 0 (unlimited)
    // 100*0.4 + 100*0.25 + 100*0.2 + 100*0.15 = 100
    expect(score).toBe(100);
  });

  it("returns topConcern=null when failures exist but success rate >= 80%", () => {
    const data = {
      jobs: {
        total: 10, complete: 9, failed: 1, queued: 0, running: 0,
        successRate: 90, totalCostUsd: 5.0, avgCostPerJob: 0.5,
        avgDurationSec: 60, failureBreakdown: { timeout: 1 },
      },
      oracle: {
        totalDecisions: 5, accuracyPercent: 80, confidenceAvg: 7,
        circuitBreakerTripped: false,
      },
      budget: {
        dailyLimitUsd: 10, dailySpentUsd: 5, dailyRemaining: 5,
        jobCount: 10, maxJobsPerDay: 100, byInstance: {},
      },
      adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
      bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
      instances: [],
    };
    const { topConcern } = computeHealthScore(data);
    // 90% success, no circuit breaker, budget at 50%, no garyclaw-bug → null
    expect(topConcern).toBeNull();
  });
});

// ── formatDashboard edge cases ─────────────────────────────────

describe("formatDashboard edge cases", () => {
  it("renders 'None — all systems nominal.' when topConcern is null", () => {
    const data: DashboardData = {
      generatedAt: "2026-03-27T10:00:00Z",
      healthScore: 100,
      topConcern: null,
      jobs: {
        total: 5, complete: 5, failed: 0, queued: 0, running: 0,
        successRate: 100, totalCostUsd: 1.0, avgCostPerJob: 0.2,
        avgDurationSec: 60, failureBreakdown: {},
      },
      oracle: {
        totalDecisions: 0, accuracyPercent: 0, confidenceAvg: 0,
        circuitBreakerTripped: false,
      },
      budget: {
        dailyLimitUsd: 10, dailySpentUsd: 1, dailyRemaining: 9,
        jobCount: 5, maxJobsPerDay: 100, byInstance: {},
      },
      adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
      bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
      instances: [],
    };
    const result = formatDashboard(data);
    expect(result).toContain("None — all systems nominal.");
  });

  it("renders 100.0% remaining when dailyLimitUsd=0", () => {
    const data: DashboardData = {
      generatedAt: "2026-03-27T10:00:00Z",
      healthScore: 100,
      topConcern: null,
      jobs: {
        total: 0, complete: 0, failed: 0, queued: 0, running: 0,
        successRate: 100, totalCostUsd: 0, avgCostPerJob: 0,
        avgDurationSec: 0, failureBreakdown: {},
      },
      oracle: {
        totalDecisions: 0, accuracyPercent: 0, confidenceAvg: 0,
        circuitBreakerTripped: false,
      },
      budget: {
        dailyLimitUsd: 0, dailySpentUsd: 0, dailyRemaining: 0,
        jobCount: 0, maxJobsPerDay: 100, byInstance: {},
      },
      adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
      bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
      instances: [],
    };
    const result = formatDashboard(data);
    // When dailyLimitUsd=0, the ternary falls through to "100.0"
    expect(result).toContain("100.0%");
    expect(result).not.toContain("NaN");
    expect(result).not.toContain("Infinity");
  });
});
