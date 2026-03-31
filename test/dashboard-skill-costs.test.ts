/**
 * Dashboard skill cost attribution tests — aggregateSkillCostStats, computeSkillCostTrends,
 * formatDashboard skill cost sections, buildDashboard wiring, and health score integration.
 * All synthetic data — no SDK calls.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateSkillCostStats,
  computeSkillCostTrends,
  computeHealthScore,
  formatDashboard,
  buildDashboard,
  TREND_THRESHOLD_PERCENT,
  TREND_WINDOW_SIZE,
} from "../src/dashboard.js";
import type { Job, DashboardData, DaemonState, DaemonConfig, OracleMetrics, GlobalBudget } from "../src/types.js";

const TODAY = "2026-03-31";

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

function makeMinimalHealthData(
  overrides?: Partial<Omit<DashboardData, "healthScore" | "topConcern" | "generatedAt">>,
): Omit<DashboardData, "healthScore" | "topConcern" | "generatedAt"> {
  return {
    jobs: {
      total: 5, complete: 4, failed: 1, queued: 0, running: 0, rateLimited: 0,
      successRate: 80, totalCostUsd: 1.5, avgCostPerJob: 0.3, avgDurationSec: 120,
      failureBreakdown: {}, crashRecoveries: 0, crashRecoverySavedUsd: 0,
    },
    oracle: {
      totalDecisions: 10, accuracyPercent: 90, confidenceAvg: 8.5,
      circuitBreakerTripped: false,
    },
    budget: {
      dailyLimitUsd: 20, dailySpentUsd: 5, dailyRemaining: 15,
      jobCount: 5, maxJobsPerDay: 20, byInstance: {},
    },
    adaptiveTurns: {
      totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0,
      heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0,
    },
    bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
    mergeHealth: {
      totalAttempts: 0, merged: 0, blocked: 0, successRate: 100,
      avgTestDurationMs: 0, testFailures: 0, rebaseConflicts: 0,
      postMergeReverts: 0, revertRate: 0, prsCreated: 0, prsAutoMergeEnabled: 0,
      autoFixAttempts: 0, autoFixSuccesses: 0, autoFixCostUsd: 0,
    },
    composition: { composedJobs: 0, avgSkillsBefore: 0, avgSkillsAfter: 0, estimatedSavingsUsd: 0 },
    compositionIntelligence: {
      oracleActive: false, oracleAdjustedJobs: 0, oracleFailureRate: 0,
      staticFailureRate: 0, skipRiskScores: {}, circuitBreaker: "ok",
    },
    skillCosts: { skills: [], trends: [] },
    instances: [],
    ...overrides,
  };
}

// ── aggregateSkillCostStats ──────────────────────────────────

describe("aggregateSkillCostStats", () => {
  it("with no jobs returns empty array", () => {
    expect(aggregateSkillCostStats([], TODAY)).toEqual([]);
  });

  it("with jobs missing skillCosts returns empty array", () => {
    const jobs = [makeJob(), makeJob({ id: "j2" })];
    expect(aggregateSkillCostStats(jobs, TODAY)).toEqual([]);
  });

  it("correctly aggregates across multiple jobs", () => {
    const jobs = [
      makeJob({ id: "j1", skillCosts: { implement: 1.5, qa: 0.8 } }),
      makeJob({ id: "j2", skillCosts: { implement: 2.5, qa: 1.2 } }),
    ];
    const result = aggregateSkillCostStats(jobs, TODAY);
    const impl = result.find(s => s.skillName === "implement")!;
    const qa = result.find(s => s.skillName === "qa")!;

    expect(impl.totalCostUsd).toBe(4.0);
    expect(impl.runCount).toBe(2);
    expect(impl.avgCostUsd).toBe(2.0);
    expect(qa.totalCostUsd).toBe(2.0);
    expect(qa.runCount).toBe(2);
    expect(qa.avgCostUsd).toBe(1.0);
  });

  it("filters to today's jobs only", () => {
    const jobs = [
      makeJob({ id: "j1", enqueuedAt: "2026-03-30T10:00:00Z", skillCosts: { implement: 5.0 } }),
      makeJob({ id: "j2", skillCosts: { implement: 1.0 } }),
    ];
    const result = aggregateSkillCostStats(jobs, TODAY);
    expect(result.length).toBe(1);
    expect(result[0].totalCostUsd).toBe(1.0);
  });

  it("filters to complete jobs only", () => {
    const jobs = [
      makeJob({ id: "j1", status: "failed", skillCosts: { implement: 5.0 } }),
      makeJob({ id: "j2", status: "queued", skillCosts: { implement: 3.0 } }),
      makeJob({ id: "j3", status: "complete", skillCosts: { implement: 1.0 } }),
    ];
    const result = aggregateSkillCostStats(jobs, TODAY);
    expect(result.length).toBe(1);
    expect(result[0].totalCostUsd).toBe(1.0);
  });

  it("sorts by totalCostUsd descending", () => {
    const jobs = [
      makeJob({ id: "j1", skillCosts: { qa: 0.5, implement: 2.0, prioritize: 1.0 } }),
    ];
    const result = aggregateSkillCostStats(jobs, TODAY);
    expect(result.map(s => s.skillName)).toEqual(["implement", "prioritize", "qa"]);
  });

  it("computes min/max correctly with varying costs", () => {
    const jobs = [
      makeJob({ id: "j1", skillCosts: { implement: 1.0 } }),
      makeJob({ id: "j2", skillCosts: { implement: 3.0 } }),
      makeJob({ id: "j3", skillCosts: { implement: 2.0 } }),
    ];
    const result = aggregateSkillCostStats(jobs, TODAY);
    expect(result[0].minCostUsd).toBe(1.0);
    expect(result[0].maxCostUsd).toBe(3.0);
  });

  it("handles single-entry skillCosts", () => {
    const jobs = [makeJob({ skillCosts: { qa: 0.75 } })];
    const result = aggregateSkillCostStats(jobs, TODAY);
    expect(result.length).toBe(1);
    expect(result[0].skillName).toBe("qa");
    expect(result[0].totalCostUsd).toBe(0.75);
    expect(result[0].minCostUsd).toBe(0.75);
    expect(result[0].maxCostUsd).toBe(0.75);
  });

  it("handles single job with multiple skills", () => {
    const jobs = [makeJob({ skillCosts: { prioritize: 0.3, implement: 1.5, qa: 0.8 } })];
    const result = aggregateSkillCostStats(jobs, TODAY);
    expect(result.length).toBe(3);
    expect(result[0].skillName).toBe("implement");
  });
});

// ── computeSkillCostTrends ───────────────────────────────────

describe("computeSkillCostTrends", () => {
  it("returns empty when fewer than TREND_WINDOW_SIZE+1 eligible jobs", () => {
    // Need at least 1 job in previous window (index >= TREND_WINDOW_SIZE)
    const jobs = Array.from({ length: TREND_WINDOW_SIZE }, (_, i) =>
      makeJob({
        id: `j${i}`,
        completedAt: `2026-03-${String(20 + i).padStart(2, "0")}T10:00:00Z`,
        skillCosts: { implement: 1.0 },
      }),
    );
    expect(computeSkillCostTrends(jobs)).toEqual([]);
  });

  it("computes trends across two full windows", () => {
    const jobs: Job[] = [];
    // Recent 10: implement costs $2.00 each
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `recent-${i}`,
        completedAt: `2026-03-31T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 2.0 },
      }));
    }
    // Previous 10: implement costs $1.00 each
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `prev-${i}`,
        completedAt: `2026-03-20T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 1.0 },
      }));
    }
    const trends = computeSkillCostTrends(jobs);
    expect(trends.length).toBe(1);
    expect(trends[0].skillName).toBe("implement");
    expect(trends[0].recentAvgCostUsd).toBe(2.0);
    expect(trends[0].previousAvgCostUsd).toBe(1.0);
    expect(trends[0].changePercent).toBe(100); // ((2-1)/1)*100
  });

  it("flags skills exceeding TREND_THRESHOLD_PERCENT", () => {
    const jobs: Job[] = [];
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `recent-${i}`,
        completedAt: `2026-03-31T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 1.5 },
      }));
    }
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `prev-${i}`,
        completedAt: `2026-03-20T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 1.0 },
      }));
    }
    const trends = computeSkillCostTrends(jobs);
    // 50% > 15%
    expect(trends[0].flagged).toBe(true);
    expect(trends[0].changePercent).toBe(50);
  });

  it("does not flag skills below threshold", () => {
    const jobs: Job[] = [];
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `recent-${i}`,
        completedAt: `2026-03-31T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 1.10 },
      }));
    }
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `prev-${i}`,
        completedAt: `2026-03-20T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 1.0 },
      }));
    }
    const trends = computeSkillCostTrends(jobs);
    // 10% < 15%
    expect(trends[0].flagged).toBe(false);
    expect(trends[0].changePercent).toBeCloseTo(10, 5);
  });

  it("handles skills appearing in only one window", () => {
    const jobs: Job[] = [];
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `recent-${i}`,
        completedAt: `2026-03-31T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 2.0 }, // only in recent
      }));
    }
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `prev-${i}`,
        completedAt: `2026-03-20T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { qa: 1.0 }, // only in previous
      }));
    }
    const trends = computeSkillCostTrends(jobs);
    // Neither skill appears in both windows
    expect(trends).toEqual([]);
  });

  it("sorts by changePercent descending", () => {
    const jobs: Job[] = [];
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `recent-${i}`,
        completedAt: `2026-03-31T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 3.0, qa: 1.5, prioritize: 1.0 },
      }));
    }
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `prev-${i}`,
        completedAt: `2026-03-20T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 1.0, qa: 1.0, prioritize: 0.9 },
      }));
    }
    const trends = computeSkillCostTrends(jobs);
    expect(trends.length).toBe(3);
    // implement: +200%, qa: +50%, prioritize: ~+11%
    expect(trends[0].skillName).toBe("implement");
    expect(trends[1].skillName).toBe("qa");
    expect(trends[2].skillName).toBe("prioritize");
  });

  it("handles zero previous avg without division error", () => {
    const jobs: Job[] = [];
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `recent-${i}`,
        completedAt: `2026-03-31T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 1.0 },
      }));
    }
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `prev-${i}`,
        completedAt: `2026-03-20T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 0 },
      }));
    }
    const trends = computeSkillCostTrends(jobs);
    expect(trends.length).toBe(1);
    expect(trends[0].changePercent).toBe(0);
    expect(trends[0].flagged).toBe(false);
    expect(Number.isFinite(trends[0].changePercent)).toBe(true);
  });

  it("handles negative changePercent (cost decrease) without flagging", () => {
    const jobs: Job[] = [];
    // Recent 10: implement costs $1.00 each (decreased)
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `recent-${i}`,
        completedAt: `2026-03-31T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 1.0, qa: 3.0 },
      }));
    }
    // Previous 10: implement costs $2.00 each
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `prev-${i}`,
        completedAt: `2026-03-20T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 2.0, qa: 1.0 },
      }));
    }
    const trends = computeSkillCostTrends(jobs);
    // qa increased +200%, implement decreased -50%
    const impl = trends.find(t => t.skillName === "implement")!;
    const qa = trends.find(t => t.skillName === "qa")!;

    expect(impl.changePercent).toBe(-50);
    expect(impl.flagged).toBe(false); // negative is below threshold
    expect(qa.changePercent).toBe(200);
    expect(qa.flagged).toBe(true);

    // Sort: decreasing costs should be at the bottom (sorted desc by changePercent)
    expect(trends[0].skillName).toBe("qa");       // +200%
    expect(trends[1].skillName).toBe("implement"); // -50%
  });

  it("uses completedAt for sort order, falls back to enqueuedAt", () => {
    const jobs: Job[] = [];
    // Recent: have completedAt
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `recent-${i}`,
        completedAt: `2026-03-31T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 2.0 },
      }));
    }
    // Previous: no completedAt, use enqueuedAt
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `prev-${i}`,
        completedAt: undefined as any,
        enqueuedAt: `2026-03-20T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 1.0 },
      }));
    }
    const trends = computeSkillCostTrends(jobs);
    expect(trends.length).toBe(1);
    expect(trends[0].recentAvgCostUsd).toBe(2.0);
    expect(trends[0].previousAvgCostUsd).toBe(1.0);
  });
});

// ── formatDashboard + wiring ─────────────────────────────────

describe("formatDashboard skill costs", () => {
  it("includes skill cost table when data exists", () => {
    const data: DashboardData = {
      ...makeMinimalHealthData(),
      healthScore: 85,
      topConcern: null,
      generatedAt: "2026-03-31T12:00:00Z",
      skillCosts: {
        skills: [
          { skillName: "implement", totalCostUsd: 4.0, runCount: 2, avgCostUsd: 2.0, minCostUsd: 1.5, maxCostUsd: 2.5 },
        ],
        trends: [],
      },
    };
    const output = formatDashboard(data);
    expect(output).toContain("## Skill Cost Breakdown (today)");
    expect(output).toContain("| implement |");
  });

  it("omits skill cost table when no data", () => {
    const data: DashboardData = {
      ...makeMinimalHealthData(),
      healthScore: 85,
      topConcern: null,
      generatedAt: "2026-03-31T12:00:00Z",
      skillCosts: { skills: [], trends: [] },
    };
    const output = formatDashboard(data);
    expect(output).not.toContain("## Skill Cost Breakdown");
  });

  it("formats positive changePercent with + prefix on flagged trends", () => {
    const data: DashboardData = {
      ...makeMinimalHealthData(),
      healthScore: 85,
      topConcern: null,
      generatedAt: "2026-03-31T12:00:00Z",
      skillCosts: {
        skills: [
          { skillName: "implement", totalCostUsd: 4.0, runCount: 2, avgCostUsd: 2.0, minCostUsd: 1.5, maxCostUsd: 2.5 },
        ],
        trends: [
          {
            skillName: "implement",
            recentAvgCostUsd: 2.0,
            previousAvgCostUsd: 1.0,
            changePercent: 100,
            flagged: true,
            recentRunCount: 10,
            previousRunCount: 10,
          },
        ],
      },
    };
    const output = formatDashboard(data);
    // Positive trends should show "+" prefix
    expect(output).toContain("+100.0%");
  });

  it("shows flagged trends section", () => {
    const data: DashboardData = {
      ...makeMinimalHealthData(),
      healthScore: 85,
      topConcern: null,
      generatedAt: "2026-03-31T12:00:00Z",
      skillCosts: {
        skills: [
          { skillName: "implement", totalCostUsd: 4.0, runCount: 2, avgCostUsd: 2.0, minCostUsd: 1.5, maxCostUsd: 2.5 },
        ],
        trends: [
          {
            skillName: "implement",
            recentAvgCostUsd: 2.0,
            previousAvgCostUsd: 1.0,
            changePercent: 100,
            flagged: true,
            recentRunCount: 10,
            previousRunCount: 10,
          },
        ],
      },
    };
    const output = formatDashboard(data);
    expect(output).toContain("### Cost Trends (flagged >15% increase)");
    expect(output).toContain("| implement | $2.00 | $1.00 | +100.0% | 10/10 |");
  });
});

describe("buildDashboard skill cost wiring", () => {
  it("populates skillCosts.trends in DashboardData", () => {
    // Create 20+ jobs with skillCosts across two time windows
    const jobs: Job[] = [];
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `recent-${i}`,
        completedAt: `2026-03-31T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 3.0 },
      }));
    }
    for (let i = 0; i < TREND_WINDOW_SIZE; i++) {
      jobs.push(makeJob({
        id: `prev-${i}`,
        completedAt: `2026-03-20T${String(10 + i).padStart(2, "0")}:00:00Z`,
        skillCosts: { implement: 1.0 },
      }));
    }
    const state: DaemonState = {
      version: 1,
      jobs,
      dailyCost: { date: TODAY, totalUsd: 30.0, jobCount: 20 },
    };
    const metrics: OracleMetrics = {
      totalDecisions: 10, accurateDecisions: 9, neutralDecisions: 1, failedDecisions: 0,
      accuracyPercent: 90, confidenceTrend: [8, 9], lastReflectionTimestamp: null,
      circuitBreakerTripped: false,
    };
    const globalBudget: GlobalBudget = { date: TODAY, totalUsd: 30.0, jobCount: 20, byInstance: {} };
    const config: DaemonConfig = {
      projectDir: mkdtempSync(join(tmpdir(), "gc-test-")),
      budget: { dailyCostLimitUsd: 100, perJobCostLimitUsd: 10, maxJobsPerDay: 50 },
      triggers: [],
    };

    const data = buildDashboard(state, metrics, globalBudget, config, TODAY);
    expect(data.skillCosts.trends.length).toBeGreaterThan(0);
    expect(data.skillCosts.trends[0].skillName).toBe("implement");
    expect(data.skillCosts.trends[0].changePercent).toBe(200);
  });
});

describe("computeHealthScore with skill cost trends", () => {
  it("deducts for severely flagged trends (>30% increase)", () => {
    const base = makeMinimalHealthData();
    const withoutTrends = computeHealthScore(base);

    const withTrends = computeHealthScore({
      ...base,
      skillCosts: {
        skills: [],
        trends: [
          {
            skillName: "implement",
            recentAvgCostUsd: 2.0,
            previousAvgCostUsd: 1.0,
            changePercent: 50, // >30%
            flagged: true,
            recentRunCount: 10,
            previousRunCount: 10,
          },
          {
            skillName: "qa",
            recentAvgCostUsd: 1.5,
            previousAvgCostUsd: 1.0,
            changePercent: 50, // >30%
            flagged: true,
            recentRunCount: 10,
            previousRunCount: 10,
          },
        ],
      },
    });

    // 2 flagged skills * 2 points each = 4 point deduction
    expect(withoutTrends.score - withTrends.score).toBe(4);
  });

  it("surfaces cost trend concern as topConcern when no higher-priority concerns", () => {
    const base = makeMinimalHealthData();
    const { topConcern } = computeHealthScore({
      ...base,
      skillCosts: {
        skills: [],
        trends: [
          {
            skillName: "implement",
            recentAvgCostUsd: 2.0,
            previousAvgCostUsd: 1.0,
            changePercent: 50,
            flagged: true,
            recentRunCount: 10,
            previousRunCount: 10,
          },
        ],
      },
    });
    expect(topConcern).toContain("skill(s) with >30% cost increase");
  });
});
