/**
 * Dashboard merge health tests — aggregation, health score reweighting,
 * formatting, test failure vs rebase conflict breakdown.
 *
 * All synthetic data — no file I/O.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateMergeStats,
  computeHealthScore,
  formatDashboard,
} from "../src/dashboard.js";
import type { MergeAuditEntry } from "../src/worktree.js";
import type { DashboardData } from "../src/types.js";

const TODAY = "2026-03-29";

function makeEntry(overrides: Partial<MergeAuditEntry> = {}): MergeAuditEntry {
  return {
    timestamp: `${TODAY}T10:00:00Z`,
    instanceName: "builder",
    branch: "garyclaw/builder",
    baseBranch: "main",
    commitCount: 2,
    merged: true,
    ...overrides,
  };
}

function makeDefaultMergeHealth(): DashboardData["mergeHealth"] {
  return { totalAttempts: 0, merged: 0, blocked: 0, successRate: 100, avgTestDurationMs: 0, testFailures: 0, rebaseConflicts: 0 };
}

function makeDashboardInput(mergeHealth?: DashboardData["mergeHealth"]) {
  return {
    jobs: { total: 5, complete: 5, failed: 0, queued: 0, running: 0, successRate: 100, totalCostUsd: 10, avgCostPerJob: 2, avgDurationSec: 300, failureBreakdown: {}, crashRecoveries: 0, crashRecoverySavedUsd: 0 },
    oracle: { totalDecisions: 50, accuracyPercent: 100, confidenceAvg: 9, circuitBreakerTripped: false },
    budget: { dailyLimitUsd: 25, dailySpentUsd: 0, dailyRemaining: 25, jobCount: 5, maxJobsPerDay: 20, byInstance: {} },
    adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
    bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
    mergeHealth: mergeHealth ?? makeDefaultMergeHealth(),
    instances: [],
  };
}

// ── aggregateMergeStats ──────────────────────────────────────────

describe("aggregateMergeStats", () => {
  it("returns defaults for empty entries", () => {
    const stats = aggregateMergeStats([], TODAY);
    expect(stats.totalAttempts).toBe(0);
    expect(stats.merged).toBe(0);
    expect(stats.blocked).toBe(0);
    expect(stats.successRate).toBe(100);
    expect(stats.avgTestDurationMs).toBe(0);
  });

  it("counts merged and blocked correctly", () => {
    const entries = [
      makeEntry({ merged: true }),
      makeEntry({ merged: true }),
      makeEntry({ merged: false, reason: "Pre-merge tests failed", testsPassed: false }),
    ];
    const stats = aggregateMergeStats(entries, TODAY);
    expect(stats.totalAttempts).toBe(3);
    expect(stats.merged).toBe(2);
    expect(stats.blocked).toBe(1);
    expect(stats.successRate).toBeCloseTo(66.67, 1);
  });

  it("filters to today's entries only", () => {
    const entries = [
      makeEntry({ timestamp: `${TODAY}T10:00:00Z`, merged: true }),
      makeEntry({ timestamp: "2026-03-28T10:00:00Z", merged: false }), // yesterday
    ];
    const stats = aggregateMergeStats(entries, TODAY);
    expect(stats.totalAttempts).toBe(1);
    expect(stats.merged).toBe(1);
  });

  it("computes average test duration", () => {
    const entries = [
      makeEntry({ testDurationMs: 30000 }),
      makeEntry({ testDurationMs: 50000 }),
      makeEntry({}), // no testDurationMs
    ];
    const stats = aggregateMergeStats(entries, TODAY);
    expect(stats.avgTestDurationMs).toBe(40000);
  });

  it("distinguishes test failures from rebase conflicts", () => {
    const entries = [
      makeEntry({ merged: false, reason: "Pre-merge tests failed", testsPassed: false }),
      makeEntry({ merged: false, reason: "Rebase of garyclaw/builder onto main had conflicts — needs manual resolution" }),
      makeEntry({ merged: false, reason: "Could not acquire merge lock" }),
    ];
    const stats = aggregateMergeStats(entries, TODAY);
    expect(stats.testFailures).toBe(1);
    expect(stats.rebaseConflicts).toBe(1);
    expect(stats.blocked).toBe(3);
  });

  it("handles all-successful merges", () => {
    const entries = [
      makeEntry({ merged: true, testsPassed: true, testDurationMs: 45000 }),
      makeEntry({ merged: true, testsPassed: true, testDurationMs: 35000 }),
    ];
    const stats = aggregateMergeStats(entries, TODAY);
    expect(stats.successRate).toBe(100);
    expect(stats.blocked).toBe(0);
    expect(stats.testFailures).toBe(0);
    expect(stats.avgTestDurationMs).toBe(40000);
  });
});

// ── computeHealthScore with merge health ─────────────────────────

describe("computeHealthScore merge health", () => {
  it("zero merges = 100% merge score (no penalty)", () => {
    const { score } = computeHealthScore(makeDashboardInput());
    expect(score).toBe(100);
  });

  it("all merges passing = 100% merge score", () => {
    const { score } = computeHealthScore(makeDashboardInput({
      totalAttempts: 10, merged: 10, blocked: 0, successRate: 100,
      avgTestDurationMs: 30000, testFailures: 0, rebaseConflicts: 0,
    }));
    expect(score).toBe(100);
  });

  it("50% merge success rate reduces health score", () => {
    const perfect = computeHealthScore(makeDashboardInput());
    const halfMerges = computeHealthScore(makeDashboardInput({
      totalAttempts: 10, merged: 5, blocked: 5, successRate: 50,
      avgTestDurationMs: 30000, testFailures: 5, rebaseConflicts: 0,
    }));
    expect(halfMerges.score).toBeLessThan(perfect.score);
  });

  it("0% merge success rate triggers merge concern", () => {
    const { topConcern } = computeHealthScore(makeDashboardInput({
      totalAttempts: 5, merged: 0, blocked: 5, successRate: 0,
      avgTestDurationMs: 30000, testFailures: 5, rebaseConflicts: 0,
    }));
    expect(topConcern).toBe("More merges failing than succeeding — check merge audit log");
  });

  it("merge concern only fires when successRate < 50", () => {
    const { topConcern } = computeHealthScore(makeDashboardInput({
      totalAttempts: 10, merged: 6, blocked: 4, successRate: 60,
      avgTestDurationMs: 30000, testFailures: 4, rebaseConflicts: 0,
    }));
    // 60% merge rate doesn't trigger merge concern
    expect(topConcern).not.toBe("More merges failing than succeeding — check merge audit log");
  });

  it("job failure concern takes priority over merge concern", () => {
    const input = makeDashboardInput({
      totalAttempts: 5, merged: 0, blocked: 5, successRate: 0,
      avgTestDurationMs: 0, testFailures: 5, rebaseConflicts: 0,
    });
    input.jobs = { ...input.jobs, successRate: 20, failed: 4, complete: 1, total: 5 };
    const { topConcern } = computeHealthScore(input);
    expect(topConcern).toBe("More jobs failing than succeeding — check failure breakdown");
  });
});

// ── formatDashboard merge health section ─────────────────────────

describe("formatDashboard merge health", () => {
  function makeFullData(mergeHealth?: DashboardData["mergeHealth"]): DashboardData {
    return {
      generatedAt: "2026-03-29T11:00:00Z",
      healthScore: 92,
      topConcern: null,
      jobs: { total: 5, complete: 5, failed: 0, queued: 0, running: 0, successRate: 100, totalCostUsd: 10, avgCostPerJob: 2, avgDurationSec: 300, failureBreakdown: {}, crashRecoveries: 0, crashRecoverySavedUsd: 0 },
      oracle: { totalDecisions: 50, accuracyPercent: 100, confidenceAvg: 9.0, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 10, dailyRemaining: 15, jobCount: 5, maxJobsPerDay: 20, byInstance: {} },
      adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
      bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
      mergeHealth: mergeHealth ?? makeDefaultMergeHealth(),
      instances: [],
    };
  }

  it("omits merge health section when no merges attempted", () => {
    const md = formatDashboard(makeFullData());
    expect(md).not.toContain("## Merge Health");
  });

  it("renders merge health section when merges attempted", () => {
    const md = formatDashboard(makeFullData({
      totalAttempts: 14, merged: 12, blocked: 2, successRate: 85.7,
      avgTestDurationMs: 34000, testFailures: 1, rebaseConflicts: 1,
    }));
    expect(md).toContain("## Merge Health");
    expect(md).toContain("| Attempts | 14 |");
    expect(md).toContain("| Merged | 12 (85.7%) |");
    expect(md).toContain("| Avg test time | 34s |");
  });

  it("shows test failure and rebase conflict breakdown", () => {
    const md = formatDashboard(makeFullData({
      totalAttempts: 10, merged: 6, blocked: 4, successRate: 60,
      avgTestDurationMs: 30000, testFailures: 3, rebaseConflicts: 1,
    }));
    expect(md).toContain("3 test failures");
    expect(md).toContain("1 rebase conflict");
  });

  it("shows only test failures when no rebase conflicts", () => {
    const md = formatDashboard(makeFullData({
      totalAttempts: 5, merged: 3, blocked: 2, successRate: 60,
      avgTestDurationMs: 30000, testFailures: 2, rebaseConflicts: 0,
    }));
    expect(md).toContain("2 test failures");
    expect(md).not.toContain("rebase conflict");
  });

  it("shows only rebase conflicts when no test failures", () => {
    const md = formatDashboard(makeFullData({
      totalAttempts: 5, merged: 4, blocked: 1, successRate: 80,
      avgTestDurationMs: 0, testFailures: 0, rebaseConflicts: 1,
    }));
    expect(md).not.toContain("test failure");
    expect(md).toContain("1 rebase conflict");
  });

  it("singular 'test failure' when count is 1", () => {
    const md = formatDashboard(makeFullData({
      totalAttempts: 5, merged: 4, blocked: 1, successRate: 80,
      avgTestDurationMs: 30000, testFailures: 1, rebaseConflicts: 0,
    }));
    expect(md).toContain("1 test failure)");
    expect(md).not.toContain("failures");
  });
});
