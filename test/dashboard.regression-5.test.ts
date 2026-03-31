/**
 * Regression: idle job status — topConcern surfaces when >50% of jobs are idle
 * Found by /qa on 2026-03-31
 *
 * Without an idle-rate concern, a daemon can spin 15/20 idle jobs and the dashboard
 * reports 100% success rate with no topConcern — hiding that the backlog is exhausted.
 */

import { describe, it, expect } from "vitest";
import { computeHealthScore } from "../src/dashboard.js";

function makeMinimalData(jobOverrides?: Record<string, unknown>) {
  return {
    jobs: {
      total: 10,
      complete: 5,
      completed: 5,
      failed: 0,
      queued: 0,
      running: 0,
      idle: 0,
      successRate: 100,
      totalCostUsd: 5.0,
      avgCostPerJob: 0.5,
      avgDurationSec: 120,
      failureBreakdown: {},
      rateLimited: 0,
      crashRecoveries: 0,
      crashRecoverySavedUsd: 0,
      ...jobOverrides,
    },
    oracle: {
      totalDecisions: 10,
      accuracyPercent: 100,
      confidenceAvg: 9.0,
      circuitBreakerTripped: false,
    },
    budget: {
      dailyLimitUsd: 100,
      dailySpentUsd: 5,
      dailyRemaining: 95,
      jobCount: 10,
      maxJobsPerDay: 50,
      byInstance: {},
    },
    adaptiveTurns: {
      totalSegments: 0,
      adaptiveSegments: 0,
      fallbackSegments: 0,
      clampedSegments: 0,
      heavyToolActivations: 0,
      avgTurns: 0,
      minTurns: 0,
      maxTurns: 0,
      adaptiveRate: 0,
    },
    bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
    instances: [],
  } as any;
}

describe("idle topConcern", () => {
  it("surfaces concern when >50% of jobs are idle", () => {
    const data = makeMinimalData({ total: 10, complete: 3, idle: 7, successRate: 100 });
    const { topConcern } = computeHealthScore(data);
    expect(topConcern).toContain("idle");
    expect(topConcern).toContain("7/10");
    expect(topConcern).toContain("backlog");
  });

  it("does not surface idle concern when <=50% idle", () => {
    const data = makeMinimalData({ total: 10, complete: 5, idle: 5, successRate: 100 });
    const { topConcern } = computeHealthScore(data);
    // 5/10 = 50%, not >50%
    expect(topConcern).toBeNull();
  });

  it("does not surface idle concern when zero idle jobs", () => {
    const data = makeMinimalData({ total: 10, complete: 10, idle: 0, successRate: 100 });
    const { topConcern } = computeHealthScore(data);
    expect(topConcern).toBeNull();
  });

  it("idle concern ranks below merge reverts and circuit breaker", () => {
    const data = makeMinimalData({ total: 10, complete: 2, idle: 8, successRate: 100 });
    // Add a merge revert — should take priority over idle concern
    data.mergeHealth = {
      totalAttempts: 5,
      merged: 4,
      blocked: 0,
      successRate: 80,
      testFailures: 0,
      rebaseConflicts: 0,
      avgTestDurationMs: 100,
      postMergeReverts: 1,
    };
    const { topConcern } = computeHealthScore(data);
    expect(topConcern).toContain("reverted");
    expect(topConcern).not.toContain("idle");
  });
});
