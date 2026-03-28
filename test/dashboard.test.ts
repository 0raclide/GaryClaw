/**
 * Dashboard tests — aggregation, health score, formatting. All synthetic data.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateJobStats,
  aggregateOracleStats,
  aggregateBudgetStats,
  computeHealthScore,
  formatDashboard,
  buildDashboard,
  formatDuration,
} from "../src/dashboard.js";
import type {
  Job,
  OracleMetrics,
  GlobalBudget,
  BudgetConfig,
  DaemonState,
  DaemonConfig,
  DashboardData,
} from "../src/types.js";

// ── Helpers ─────────────────────────────────────────────────────

const TODAY = "2026-03-27";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    triggeredBy: "manual",
    triggerDetail: "CLI",
    skills: ["qa"],
    projectDir: "/tmp/project",
    status: "complete",
    enqueuedAt: `${TODAY}T10:00:00Z`,
    startedAt: `${TODAY}T10:00:00Z`,
    completedAt: `${TODAY}T10:08:32Z`,
    costUsd: 2.36,
    ...overrides,
  };
}

function makeMetrics(overrides: Partial<OracleMetrics> = {}): OracleMetrics {
  return {
    totalDecisions: 122,
    accurateDecisions: 120,
    neutralDecisions: 0,
    failedDecisions: 2,
    accuracyPercent: 98.4,
    confidenceTrend: [9, 8, 9, 10, 9, 8, 9, 9, 10, 9],
    lastReflectionTimestamp: "2026-03-27T10:00:00Z",
    circuitBreakerTripped: false,
    ...overrides,
  };
}

function makeGlobalBudget(overrides: Partial<GlobalBudget> = {}): GlobalBudget {
  return {
    date: TODAY,
    totalUsd: 16.53,
    jobCount: 7,
    byInstance: {
      default: { totalUsd: 13.0, jobCount: 6 },
      reviewer: { totalUsd: 3.53, jobCount: 1 },
    },
    ...overrides,
  };
}

function makeBudgetConfig(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    dailyCostLimitUsd: 25,
    perJobCostLimitUsd: 5,
    maxJobsPerDay: 20,
    ...overrides,
  };
}

function makeDaemonConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: makeBudgetConfig(),
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: false },
    orchestrator: {
      maxTurnsPerSegment: 15,
      relayThresholdRatio: 0.85,
      maxRelaySessions: 10,
      askTimeoutMs: 300000,
    },
    logging: { level: "info", retainDays: 7 },
    ...overrides,
  };
}

// ── aggregateJobStats ──────────────────────────────────────────

describe("aggregateJobStats", () => {
  it("returns zeros for empty jobs array", () => {
    const stats = aggregateJobStats([], TODAY);
    expect(stats.total).toBe(0);
    expect(stats.complete).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.successRate).toBe(100); // no jobs = healthy
    expect(stats.totalCostUsd).toBe(0);
    expect(stats.avgCostPerJob).toBe(0);
    expect(stats.avgDurationSec).toBe(0);
  });

  it("counts all-complete jobs correctly", () => {
    const jobs = [
      makeJob({ id: "j1", costUsd: 2.0 }),
      makeJob({ id: "j2", costUsd: 3.0 }),
    ];
    const stats = aggregateJobStats(jobs, TODAY);
    expect(stats.total).toBe(2);
    expect(stats.complete).toBe(2);
    expect(stats.failed).toBe(0);
    expect(stats.successRate).toBe(100);
    expect(stats.totalCostUsd).toBe(5.0);
    expect(stats.avgCostPerJob).toBe(2.5);
  });

  it("handles mixed statuses", () => {
    const jobs = [
      makeJob({ id: "j1", status: "complete" }),
      makeJob({ id: "j2", status: "failed", failureCategory: "auth-issue" }),
      makeJob({ id: "j3", status: "queued", startedAt: undefined, completedAt: undefined }),
      makeJob({ id: "j4", status: "running", completedAt: undefined }),
    ];
    const stats = aggregateJobStats(jobs, TODAY);
    expect(stats.total).toBe(4);
    expect(stats.complete).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.queued).toBe(1);
    expect(stats.running).toBe(1);
    expect(stats.successRate).toBe(25); // 1/4
  });

  it("builds failure breakdown by category", () => {
    const jobs = [
      makeJob({ id: "j1", status: "failed", failureCategory: "auth-issue" }),
      makeJob({ id: "j2", status: "failed", failureCategory: "auth-issue" }),
      makeJob({ id: "j3", status: "failed", failureCategory: "garyclaw-bug" }),
    ];
    const stats = aggregateJobStats(jobs, TODAY);
    expect(stats.failureBreakdown).toEqual({
      "auth-issue": 2,
      "garyclaw-bug": 1,
    });
  });

  it("computes avg duration from finished jobs", () => {
    const jobs = [
      makeJob({
        id: "j1",
        startedAt: `${TODAY}T10:00:00Z`,
        completedAt: `${TODAY}T10:10:00Z`, // 600s
      }),
      makeJob({
        id: "j2",
        startedAt: `${TODAY}T11:00:00Z`,
        completedAt: `${TODAY}T11:05:00Z`, // 300s
      }),
    ];
    const stats = aggregateJobStats(jobs, TODAY);
    expect(stats.avgDurationSec).toBe(450); // (600 + 300) / 2
  });

  it("includes failed jobs with timestamps in avg duration", () => {
    const jobs = [
      makeJob({
        id: "j1",
        status: "complete",
        startedAt: `${TODAY}T10:00:00Z`,
        completedAt: `${TODAY}T10:10:00Z`, // 600s
      }),
      makeJob({
        id: "j2",
        status: "failed",
        startedAt: `${TODAY}T11:00:00Z`,
        completedAt: `${TODAY}T11:02:00Z`, // 120s
      }),
    ];
    const stats = aggregateJobStats(jobs, TODAY);
    expect(stats.avgDurationSec).toBe(360); // (600 + 120) / 2
  });

  it("filters to today-only jobs", () => {
    const jobs = [
      makeJob({ id: "j1", enqueuedAt: `${TODAY}T10:00:00Z` }),
      makeJob({ id: "j2", enqueuedAt: "2026-03-26T10:00:00Z" }), // yesterday
    ];
    const stats = aggregateJobStats(jobs, TODAY);
    expect(stats.total).toBe(1);
  });
});

// ── aggregateOracleStats ──────────────────────────────────────

describe("aggregateOracleStats", () => {
  it("aggregates normal metrics", () => {
    const stats = aggregateOracleStats(makeMetrics());
    expect(stats.totalDecisions).toBe(122);
    expect(stats.accuracyPercent).toBe(98.4);
    expect(stats.confidenceAvg).toBeCloseTo(9.0);
    expect(stats.circuitBreakerTripped).toBe(false);
  });

  it("handles empty confidence trend", () => {
    const stats = aggregateOracleStats(makeMetrics({ confidenceTrend: [] }));
    expect(stats.confidenceAvg).toBe(0);
  });

  it("handles zero decisions", () => {
    const stats = aggregateOracleStats(
      makeMetrics({ totalDecisions: 0, accuracyPercent: 100, confidenceTrend: [] }),
    );
    expect(stats.totalDecisions).toBe(0);
    expect(stats.accuracyPercent).toBe(100);
  });

  it("detects circuit breaker", () => {
    const stats = aggregateOracleStats(makeMetrics({ circuitBreakerTripped: true }));
    expect(stats.circuitBreakerTripped).toBe(true);
  });
});

// ── aggregateBudgetStats ──────────────────────────────────────

describe("aggregateBudgetStats", () => {
  it("aggregates normal budget", () => {
    const stats = aggregateBudgetStats(makeGlobalBudget(), makeBudgetConfig());
    expect(stats.dailyLimitUsd).toBe(25);
    expect(stats.dailySpentUsd).toBe(16.53);
    expect(stats.dailyRemaining).toBeCloseTo(8.47);
    expect(stats.jobCount).toBe(7);
    expect(stats.maxJobsPerDay).toBe(20);
  });

  it("handles zero spent", () => {
    const stats = aggregateBudgetStats(
      makeGlobalBudget({ totalUsd: 0, jobCount: 0 }),
      makeBudgetConfig(),
    );
    expect(stats.dailySpentUsd).toBe(0);
    expect(stats.dailyRemaining).toBe(25);
  });

  it("handles multi-instance breakdown", () => {
    const stats = aggregateBudgetStats(makeGlobalBudget(), makeBudgetConfig());
    expect(Object.keys(stats.byInstance)).toHaveLength(2);
    expect(stats.byInstance["default"].totalUsd).toBe(13.0);
    expect(stats.byInstance["reviewer"].jobCount).toBe(1);
  });

  it("clamps dailyRemaining to zero when over-budget", () => {
    const stats = aggregateBudgetStats(
      makeGlobalBudget({ totalUsd: 30 }), // spent > limit
      makeBudgetConfig({ dailyCostLimitUsd: 25 }),
    );
    expect(stats.dailyRemaining).toBe(0); // clamped, not -5
  });

  it("handles missing byInstance", () => {
    const budget = makeGlobalBudget({ byInstance: undefined as unknown as Record<string, { totalUsd: number; jobCount: number }> });
    const stats = aggregateBudgetStats(budget, makeBudgetConfig());
    expect(stats.byInstance).toEqual({});
  });
});

// ── computeHealthScore ──────────────────────────────────────────

describe("computeHealthScore", () => {
  it("returns 100 for perfect state", () => {
    const { score, topConcern } = computeHealthScore({
      jobs: { total: 5, complete: 5, failed: 0, queued: 0, running: 0, successRate: 100, totalCostUsd: 10, avgCostPerJob: 2, avgDurationSec: 300, failureBreakdown: {} },
      oracle: { totalDecisions: 50, accuracyPercent: 100, confidenceAvg: 9, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 0, dailyRemaining: 25, jobCount: 5, maxJobsPerDay: 20, byInstance: {} },
      instances: [],
    });
    expect(score).toBe(100);
    expect(topConcern).toBeNull();
  });

  it("returns low score when all jobs fail", () => {
    const { score, topConcern } = computeHealthScore({
      jobs: { total: 5, complete: 0, failed: 5, queued: 0, running: 0, successRate: 0, totalCostUsd: 10, avgCostPerJob: 2, avgDurationSec: 300, failureBreakdown: { "unknown": 5 } },
      oracle: { totalDecisions: 50, accuracyPercent: 100, confidenceAvg: 9, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 10, dailyRemaining: 15, jobCount: 5, maxJobsPerDay: 20, byInstance: {} },
      instances: [],
    });
    expect(score).toBeLessThan(70);
    expect(topConcern).toBe("More jobs failing than succeeding — check failure breakdown");
  });

  it("penalizes circuit breaker", () => {
    const { score } = computeHealthScore({
      jobs: { total: 5, complete: 5, failed: 0, queued: 0, running: 0, successRate: 100, totalCostUsd: 10, avgCostPerJob: 2, avgDurationSec: 300, failureBreakdown: {} },
      oracle: { totalDecisions: 50, accuracyPercent: 50, confidenceAvg: 5, circuitBreakerTripped: true },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 10, dailyRemaining: 15, jobCount: 5, maxJobsPerDay: 20, byInstance: {} },
      instances: [],
    });
    // Circuit breaker: 0 * 0.15 = -15, plus low accuracy
    expect(score).toBeLessThan(85);
  });

  it("penalizes exhausted budget", () => {
    const { score, topConcern } = computeHealthScore({
      jobs: { total: 5, complete: 5, failed: 0, queued: 0, running: 0, successRate: 100, totalCostUsd: 24.5, avgCostPerJob: 4.9, avgDurationSec: 300, failureBreakdown: {} },
      oracle: { totalDecisions: 50, accuracyPercent: 100, confidenceAvg: 9, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 24.5, dailyRemaining: 0.5, jobCount: 5, maxJobsPerDay: 20, byInstance: {} },
      instances: [],
    });
    expect(score).toBeLessThan(100);
    expect(topConcern).toBe("Daily budget nearly exhausted ($0.50 remaining)");
  });

  it("handles zero jobs (healthy)", () => {
    const { score, topConcern } = computeHealthScore({
      jobs: { total: 0, complete: 0, failed: 0, queued: 0, running: 0, successRate: 100, totalCostUsd: 0, avgCostPerJob: 0, avgDurationSec: 0, failureBreakdown: {} },
      oracle: { totalDecisions: 0, accuracyPercent: 100, confidenceAvg: 0, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 0, dailyRemaining: 25, jobCount: 0, maxJobsPerDay: 20, byInstance: {} },
      instances: [],
    });
    expect(score).toBe(100);
    expect(topConcern).toBeNull();
  });

  it("circuit breaker concern takes priority over success rate", () => {
    const { topConcern } = computeHealthScore({
      jobs: { total: 5, complete: 1, failed: 4, queued: 0, running: 0, successRate: 20, totalCostUsd: 10, avgCostPerJob: 2, avgDurationSec: 300, failureBreakdown: {} },
      oracle: { totalDecisions: 50, accuracyPercent: 55, confidenceAvg: 5, circuitBreakerTripped: true },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 10, dailyRemaining: 15, jobCount: 5, maxJobsPerDay: 20, byInstance: {} },
      instances: [],
    });
    expect(topConcern).toBe("Oracle memory disabled — accuracy below 60%");
  });

  it("garyclaw-bug concern triggers when success rate is 50-80%", () => {
    const { topConcern } = computeHealthScore({
      jobs: { total: 10, complete: 7, failed: 3, queued: 0, running: 0, successRate: 70, totalCostUsd: 10, avgCostPerJob: 1, avgDurationSec: 300, failureBreakdown: { "garyclaw-bug": 2, "auth-issue": 1 } },
      oracle: { totalDecisions: 50, accuracyPercent: 100, confidenceAvg: 9, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 10, dailyRemaining: 15, jobCount: 10, maxJobsPerDay: 20, byInstance: {} },
      instances: [],
    });
    expect(topConcern).toBe("GaryClaw bug detected in 2 job(s) — check logs");
  });

  it("moderate failure rate concern when no garyclaw-bug", () => {
    const { topConcern } = computeHealthScore({
      jobs: { total: 10, complete: 7, failed: 3, queued: 0, running: 0, successRate: 70, totalCostUsd: 10, avgCostPerJob: 1, avgDurationSec: 300, failureBreakdown: { "auth-issue": 3 } },
      oracle: { totalDecisions: 50, accuracyPercent: 100, confidenceAvg: 9, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 10, dailyRemaining: 15, jobCount: 10, maxJobsPerDay: 20, byInstance: {} },
      instances: [],
    });
    expect(topConcern).toBe("3 job(s) failed today — review failure categories");
  });

  it("returns 100 when dailyLimitUsd is zero (no budget configured)", () => {
    const { score } = computeHealthScore({
      jobs: { total: 5, complete: 5, failed: 0, queued: 0, running: 0, successRate: 100, totalCostUsd: 10, avgCostPerJob: 2, avgDurationSec: 300, failureBreakdown: {} },
      oracle: { totalDecisions: 0, accuracyPercent: 100, confidenceAvg: 0, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 0, dailySpentUsd: 0, dailyRemaining: 0, jobCount: 5, maxJobsPerDay: 20, byInstance: {} },
      instances: [],
    });
    expect(score).toBe(100); // budgetHeadroom defaults to 100 when limit is 0
  });
});

// ── formatDashboard ────────────────────────────────────────────

describe("formatDashboard", () => {
  function makeFullDashboardData(): DashboardData {
    return {
      generatedAt: "2026-03-27T11:00:00Z",
      healthScore: 92,
      topConcern: null,
      jobs: { total: 7, complete: 6, failed: 1, queued: 0, running: 0, successRate: 85.7, totalCostUsd: 16.53, avgCostPerJob: 2.36, avgDurationSec: 512, failureBreakdown: { "auth-issue": 1 } },
      oracle: { totalDecisions: 122, accuracyPercent: 100, confidenceAvg: 9.0, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 16.53, dailyRemaining: 8.47, jobCount: 7, maxJobsPerDay: 20, byInstance: { default: { totalUsd: 13.0, jobCount: 6 }, reviewer: { totalUsd: 3.53, jobCount: 1 } } },
      instances: ["default", "reviewer"],
    };
  }

  it("produces valid markdown with all sections", () => {
    const md = formatDashboard(makeFullDashboardData());
    expect(md).toContain("# GaryClaw Dogfood Dashboard");
    expect(md).toContain("**Health Score:** 92/100");
    expect(md).toContain("**Status:** HEALTHY");
    expect(md).toContain("## Jobs Today");
    expect(md).toContain("## Oracle");
    expect(md).toContain("## Budget");
    expect(md).toContain("### By Instance");
    expect(md).toContain("### Failure Breakdown");
    expect(md).toContain("auth-issue");
    expect(md).toContain("*Generated by GaryClaw Daemon*");
  });

  it("omits failure breakdown when no failures", () => {
    const data = makeFullDashboardData();
    data.jobs.failureBreakdown = {};
    const md = formatDashboard(data);
    expect(md).not.toContain("### Failure Breakdown");
  });

  it("omits instance table when no instances", () => {
    const data = makeFullDashboardData();
    data.budget.byInstance = {};
    const md = formatDashboard(data);
    expect(md).not.toContain("### By Instance");
  });

  it("shows DEGRADED status when health score is 50-79", () => {
    const data = makeFullDashboardData();
    data.healthScore = 65;
    const md = formatDashboard(data);
    expect(md).toContain("**Status:** DEGRADED");
  });

  it("shows UNHEALTHY status when health score is below 50", () => {
    const data = makeFullDashboardData();
    data.healthScore = 30;
    const md = formatDashboard(data);
    expect(md).toContain("**Status:** UNHEALTHY");
  });

  it("shows zero jobs correctly", () => {
    const data: DashboardData = {
      generatedAt: "2026-03-27T11:00:00Z",
      healthScore: 100,
      topConcern: null,
      jobs: { total: 0, complete: 0, failed: 0, queued: 0, running: 0, successRate: 100, totalCostUsd: 0, avgCostPerJob: 0, avgDurationSec: 0, failureBreakdown: {} },
      oracle: { totalDecisions: 0, accuracyPercent: 100, confidenceAvg: 0, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 0, dailyRemaining: 25, jobCount: 0, maxJobsPerDay: 20, byInstance: {} },
      instances: [],
    };
    const md = formatDashboard(data);
    expect(md).toContain("| Total | 0 |");
    expect(md).toContain("**Status:** HEALTHY");
    expect(md).toContain("None — all systems nominal.");
  });
});

// ── buildDashboard ────────────────────────────────────────────

describe("buildDashboard", () => {
  it("builds complete dashboard from raw data", () => {
    const state: DaemonState = {
      version: 1,
      jobs: [
        makeJob({ id: "j1", status: "complete", costUsd: 3.0 }),
        makeJob({ id: "j2", status: "complete", costUsd: 2.0 }),
      ],
      dailyCost: { date: TODAY, totalUsd: 5.0, jobCount: 2 },
    };
    const data = buildDashboard(state, makeMetrics(), makeGlobalBudget(), makeDaemonConfig(), TODAY);

    expect(data.healthScore).toBeGreaterThan(0);
    expect(data.jobs.total).toBe(2);
    expect(data.oracle.totalDecisions).toBe(122);
    expect(data.budget.dailyLimitUsd).toBe(25);
    expect(data.generatedAt).toBeTruthy();
  });

  it("handles empty state gracefully", () => {
    const state: DaemonState = {
      version: 1,
      jobs: [],
      dailyCost: { date: TODAY, totalUsd: 0, jobCount: 0 },
    };
    const emptyMetrics: OracleMetrics = {
      totalDecisions: 0,
      accurateDecisions: 0,
      neutralDecisions: 0,
      failedDecisions: 0,
      accuracyPercent: 100,
      confidenceTrend: [],
      lastReflectionTimestamp: null,
      circuitBreakerTripped: false,
    };
    const emptyBudget: GlobalBudget = { date: TODAY, totalUsd: 0, jobCount: 0, byInstance: {} };

    const data = buildDashboard(state, emptyMetrics, emptyBudget, makeDaemonConfig(), TODAY);
    expect(data.healthScore).toBe(100);
    expect(data.topConcern).toBeNull();
    expect(data.jobs.total).toBe(0);
  });

  it("populates instances from global budget", () => {
    const state: DaemonState = {
      version: 1,
      jobs: [makeJob()],
      dailyCost: { date: TODAY, totalUsd: 5.0, jobCount: 1 },
    };
    const data = buildDashboard(state, makeMetrics(), makeGlobalBudget(), makeDaemonConfig(), TODAY);
    expect(data.instances).toContain("default");
    expect(data.instances).toContain("reviewer");
  });
});

// ── formatDuration ────────────────────────────────────────────

describe("formatDuration", () => {
  it("formats zero seconds", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("formats seconds only", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(512)).toBe("8m 32s");
  });

  it("handles negative", () => {
    expect(formatDuration(-5)).toBe("0s");
  });

  it("handles NaN", () => {
    expect(formatDuration(NaN)).toBe("0s");
  });

  it("handles Infinity", () => {
    expect(formatDuration(Infinity)).toBe("0s");
  });
});
