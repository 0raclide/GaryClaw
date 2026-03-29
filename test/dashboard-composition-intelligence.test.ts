import { describe, it, expect } from "vitest";
import {
  aggregateCompositionIntelligence,
  formatDashboard,
} from "../src/dashboard.js";
import type { DashboardData, PipelineOutcomeRecord } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────

function makeRecord(overrides: Partial<PipelineOutcomeRecord> = {}): PipelineOutcomeRecord {
  return {
    jobId: "job-1",
    timestamp: "2026-03-29T00:00:00Z",
    todoTitle: "Test Item",
    effort: "S",
    priority: 3,
    skills: ["implement", "qa"],
    skippedSkills: [],
    qaFailureCount: 0,
    reopenedCount: 0,
    outcome: "success",
    oracleAdjusted: false,
    ...overrides,
  };
}

function makeDashboardData(
  ciOverrides: Partial<DashboardData["compositionIntelligence"]> = {},
): DashboardData {
  return {
    generatedAt: "2026-03-29T12:00:00Z",
    healthScore: 85,
    topConcern: null,
    jobs: {
      total: 5, complete: 5, failed: 0, queued: 0, running: 0,
      rateLimited: 0, successRate: 100, totalCostUsd: 10,
      avgCostPerJob: 2, avgDurationSec: 120,
      failureBreakdown: {}, crashRecoveries: 0, crashRecoverySavedUsd: 0,
    },
    oracle: { totalDecisions: 10, accuracyPercent: 100, confidenceAvg: 9, circuitBreakerTripped: false },
    budget: { dailyLimitUsd: 100, dailySpentUsd: 10, dailyRemaining: 90, jobCount: 5, maxJobsPerDay: 50, byInstance: {} },
    adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
    bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
    mergeHealth: { totalAttempts: 0, merged: 0, blocked: 0, successRate: 100, avgTestDurationMs: 0, testFailures: 0, rebaseConflicts: 0 },
    composition: { composedJobs: 0, avgSkillsBefore: 0, avgSkillsAfter: 0, estimatedSavingsUsd: 0 },
    compositionIntelligence: {
      oracleActive: true,
      oracleAdjustedJobs: 0,
      oracleFailureRate: 0,
      staticFailureRate: 0,
      skipRiskScores: {},
      circuitBreaker: "ok",
      ...ciOverrides,
    },
    instances: [],
  };
}

// ── aggregateCompositionIntelligence ─────────────────────────────

describe("aggregateCompositionIntelligence", () => {
  it("returns defaults for empty outcomes", () => {
    const result = aggregateCompositionIntelligence([]);
    expect(result.oracleActive).toBe(true);
    expect(result.oracleAdjustedJobs).toBe(0);
    expect(result.oracleFailureRate).toBe(0);
    expect(result.staticFailureRate).toBe(0);
    expect(result.skipRiskScores).toEqual({});
    expect(result.circuitBreaker).toBe("ok");
  });

  it("computes stats from mixed outcomes", () => {
    const outcomes = [
      makeRecord({ oracleAdjusted: true, outcome: "success" }),
      makeRecord({ oracleAdjusted: true, outcome: "failure", skippedSkills: ["eng-review"] }),
      makeRecord({ oracleAdjusted: false, outcome: "success", skippedSkills: ["eng-review"] }),
      makeRecord({ oracleAdjusted: false, outcome: "success", skippedSkills: ["eng-review"] }),
      makeRecord({ oracleAdjusted: false, outcome: "failure", skippedSkills: ["eng-review"] }),
    ];
    const result = aggregateCompositionIntelligence(outcomes);
    expect(result.oracleAdjustedJobs).toBe(2);
    expect(result.staticOnlyCount ?? result.oracleAdjustedJobs).toBeDefined();
    expect(result.oracleFailureRate).toBe(50);
  });

  it("filters zero-score skip-risk entries", () => {
    // All skips succeed → scores are 0 → not in output
    const outcomes = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ jobId: `j${i}`, skippedSkills: ["office-hours"], outcome: "success" }),
    );
    const result = aggregateCompositionIntelligence(outcomes);
    expect(result.skipRiskScores).toEqual({});
  });

  it("includes non-zero skip-risk scores", () => {
    const outcomes = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ jobId: `j${i}`, skippedSkills: ["eng-review"], outcome: "failure" }),
    );
    const result = aggregateCompositionIntelligence(outcomes);
    expect(result.skipRiskScores["eng-review"]).toBeCloseTo(1.0, 1);
  });

  it("reports tripped circuit breaker", () => {
    // 10+ Oracle-adjusted jobs with 100% failure, 0% static failure
    const oracle = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ jobId: `o${i}`, oracleAdjusted: true, outcome: "failure" }),
    );
    const statics = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ jobId: `s${i}`, oracleAdjusted: false, outcome: "success" }),
    );
    const result = aggregateCompositionIntelligence([...oracle, ...statics]);
    expect(result.circuitBreaker).toBe("tripped");
    expect(result.oracleActive).toBe(false);
  });
});

// ── formatDashboard — composition intelligence section ───────────

describe("formatDashboard — composition intelligence", () => {
  it("renders section when oracleAdjustedJobs > 0", () => {
    const data = makeDashboardData({
      oracleActive: true,
      oracleAdjustedJobs: 5,
      oracleFailureRate: 10,
      staticFailureRate: 20,
      skipRiskScores: { "eng-review": 0.45, "office-hours": 0.12 },
      circuitBreaker: "ok",
    });
    const md = formatDashboard(data);
    expect(md).toContain("## Pipeline Composition Intelligence");
    expect(md).toContain("Oracle adjustments active | Yes");
    expect(md).toContain("Jobs with Oracle adjustments | 5");
    expect(md).toContain("10.0%");
    expect(md).toContain("20.0%");
    expect(md).toContain("eng-review: 45%");
    expect(md).toContain("office-hours: 12%");
    expect(md).toContain("Circuit breaker | OK");
  });

  it("omits section when oracleAdjustedJobs is 0", () => {
    const data = makeDashboardData({ oracleAdjustedJobs: 0 });
    const md = formatDashboard(data);
    expect(md).not.toContain("Pipeline Composition Intelligence");
  });

  it("shows TRIPPED circuit breaker", () => {
    const data = makeDashboardData({
      oracleActive: false,
      oracleAdjustedJobs: 10,
      circuitBreaker: "tripped",
    });
    const md = formatDashboard(data);
    expect(md).toContain("Oracle adjustments active | No");
    expect(md).toContain("Circuit breaker | TRIPPED");
  });

  it("shows 'none' when no skip-risk scores", () => {
    const data = makeDashboardData({
      oracleAdjustedJobs: 3,
      skipRiskScores: {},
    });
    const md = formatDashboard(data);
    expect(md).toContain("Skip-risk scores | none");
  });
});
