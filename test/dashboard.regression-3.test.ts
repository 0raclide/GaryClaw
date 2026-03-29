/**
 * Regression: ISSUE-003 — formatDashboard crash recovery row format untested
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * The aggregation was tested but the markdown output format for crash recovery
 * ("Crash Recoveries | N ($X.XX saved)") had no format test. If someone changed
 * the template string, no test would catch it.
 */

import { describe, it, expect } from "vitest";
import { formatDashboard } from "../src/dashboard.js";
import type { DashboardData } from "../src/types.js";

function makeDashboardData(jobOverrides: Partial<DashboardData["jobs"]> = {}): DashboardData {
  return {
    generatedAt: "2026-03-29T11:00:00Z",
    healthScore: 90,
    topConcern: null,
    jobs: {
      total: 10,
      complete: 8,
      failed: 2,
      queued: 0,
      running: 0,
      successRate: 80,
      totalCostUsd: 20.0,
      avgCostPerJob: 2.0,
      avgDurationSec: 300,
      failureBreakdown: { "auth-issue": 1, "infra-issue": 1 },
      crashRecoveries: 0,
      crashRecoverySavedUsd: 0,
      ...jobOverrides,
    },
    oracle: { totalDecisions: 50, accuracyPercent: 100, confidenceAvg: 9.5, circuitBreakerTripped: false },
    budget: { dailyLimitUsd: 25, dailySpentUsd: 20, dailyRemaining: 5, jobCount: 10, maxJobsPerDay: 20, byInstance: {} },
    adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
    bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
    instances: ["default"],
  };
}

describe("ISSUE-003: formatDashboard crash recovery row format", () => {
  it("renders crash recovery row with count and saved cost", () => {
    const data = makeDashboardData({ crashRecoveries: 3, crashRecoverySavedUsd: 4.50 });
    const md = formatDashboard(data);

    expect(md).toContain("Crash Recoveries");
    expect(md).toContain("3");
    expect(md).toContain("$4.50 saved");
  });

  it("renders exact format: '| Crash Recoveries | N ($X.XX saved) |'", () => {
    const data = makeDashboardData({ crashRecoveries: 1, crashRecoverySavedUsd: 2.35 });
    const md = formatDashboard(data);

    // Match the exact table row format
    expect(md).toContain("| Crash Recoveries | 1 ($2.35 saved) |");
  });

  it("omits crash recovery row when no recoveries", () => {
    const data = makeDashboardData({ crashRecoveries: 0, crashRecoverySavedUsd: 0 });
    const md = formatDashboard(data);

    expect(md).not.toContain("Crash Recoveries");
  });

  it("formats saved cost to 2 decimal places", () => {
    const data = makeDashboardData({ crashRecoveries: 5, crashRecoverySavedUsd: 12.1 });
    const md = formatDashboard(data);

    // Should render as $12.10, not $12.1
    expect(md).toContain("$12.10 saved");
  });
});
