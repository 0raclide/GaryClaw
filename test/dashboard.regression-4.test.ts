/**
 * Regression: ISSUE-001 — computeHealthScore and formatDashboard crash on undefined mergeHealth
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * data.mergeHealth was accessed without null guard, crashing when DashboardData
 * objects omit the field (e.g., older persisted state, test fixtures).
 */

import { describe, it, expect } from "vitest";
import { computeHealthScore, formatDashboard } from "../src/dashboard.js";
import type { DashboardData } from "../src/types.js";

function makeMinimalData(
  overrides?: Partial<DashboardData>,
): Omit<DashboardData, "healthScore" | "topConcern" | "generatedAt"> {
  return {
    jobs: {
      total: 5,
      complete: 4,
      completed: 4,
      failed: 1,
      queued: 0,
      running: 0,
      successRate: 80,
      totalCostUsd: 1.5,
      avgCostPerJob: 0.3,
      avgDurationSec: 120,
      failureBreakdown: {},
      crashRecoveries: 0,
      crashRecoverySavedUsd: 0,
    },
    oracle: {
      totalDecisions: 10,
      accuracyPercent: 90,
      confidenceAvg: 8.5,
      circuitBreakerTripped: false,
    },
    budget: {
      dailyLimitUsd: 20,
      dailySpentUsd: 5,
      dailyRemaining: 15,
      jobCount: 5,
      maxJobsPerDay: 20,
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
    bootstrapEnrichment: {
      triggered: 0,
      avgScoreImprovement: 0,
    },
    instances: [],
    ...overrides,
  } as any;
}

describe("ISSUE-001: mergeHealth undefined guard", () => {
  it("computeHealthScore does not crash when mergeHealth is undefined", () => {
    const data = makeMinimalData();
    // mergeHealth is intentionally omitted
    expect(() => computeHealthScore(data)).not.toThrow();
  });

  it("computeHealthScore treats missing mergeHealth as 100 (healthy)", () => {
    const withoutMerge = computeHealthScore(makeMinimalData());
    const withEmptyMerge = computeHealthScore(
      makeMinimalData({
        mergeHealth: {
          totalAttempts: 0,
          merged: 0,
          blocked: 0,
          successRate: 0,
          testFailures: 0,
          rebaseConflicts: 0,
          avgTestDurationMs: 0,
        },
      } as any),
    );
    // Both should produce the same score — missing is equivalent to zero attempts
    expect(withoutMerge.score).toBe(withEmptyMerge.score);
  });

  it("formatDashboard does not crash when mergeHealth is undefined", () => {
    const data: DashboardData = {
      ...makeMinimalData(),
      healthScore: 85,
      topConcern: null,
      generatedAt: "2026-03-29T12:00:00Z",
    } as any;
    expect(() => formatDashboard(data)).not.toThrow();
  });

  it("formatDashboard omits merge health section when mergeHealth is undefined", () => {
    const data: DashboardData = {
      ...makeMinimalData(),
      healthScore: 85,
      topConcern: null,
      generatedAt: "2026-03-29T12:00:00Z",
    } as any;
    const output = formatDashboard(data);
    expect(output).not.toContain("## Merge Health");
  });
});
