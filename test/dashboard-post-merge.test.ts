/**
 * Dashboard post-merge revert stats tests — aggregation, revert rate,
 * merge health table extension, top concern priority.
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
import type { MergeRevertEntry } from "../src/worktree.js";
import type { DashboardData } from "../src/types.js";

const TODAY = "2026-03-30";

function makeMergeEntry(overrides: Partial<MergeAuditEntry> = {}): MergeAuditEntry {
  return {
    timestamp: `${TODAY}T10:00:00.000Z`,
    instanceName: "worker-1",
    branch: "garyclaw/worker-1",
    baseBranch: "main",
    commitCount: 3,
    merged: true,
    ...overrides,
  };
}

function makeRevertEntry(overrides: Partial<MergeRevertEntry> = {}): MergeRevertEntry {
  return {
    timestamp: `${TODAY}T10:05:00.000Z`,
    instanceName: "worker-1",
    mergeSha: "abc123",
    revertSha: "def456",
    branch: "garyclaw/worker-1",
    reason: "Post-merge tests failed",
    autoReverted: true,
    ...overrides,
  };
}

describe("aggregateMergeStats with reverts", () => {
  it("counts zero reverts when no revert entries", () => {
    const entries = [makeMergeEntry(), makeMergeEntry()];
    const stats = aggregateMergeStats(entries, TODAY);
    expect(stats.postMergeReverts).toBe(0);
    expect(stats.revertRate).toBe(0);
  });

  it("counts auto-reverted entries", () => {
    const mergeEntries = [makeMergeEntry(), makeMergeEntry(), makeMergeEntry()];
    const revertEntries = [makeRevertEntry(), makeRevertEntry({ autoReverted: false })];

    const stats = aggregateMergeStats(mergeEntries, TODAY, revertEntries);
    expect(stats.postMergeReverts).toBe(1); // only autoReverted=true
    expect(stats.revertRate).toBeCloseTo(33.3, 0);
  });

  it("filters reverts to today only", () => {
    const mergeEntries = [makeMergeEntry()];
    const revertEntries = [
      makeRevertEntry({ timestamp: "2026-03-29T10:00:00.000Z" }), // yesterday
      makeRevertEntry({ timestamp: `${TODAY}T10:00:00.000Z` }), // today
    ];

    const stats = aggregateMergeStats(mergeEntries, TODAY, revertEntries);
    expect(stats.postMergeReverts).toBe(1);
  });

  it("revert rate is 0 when no merges succeeded", () => {
    const mergeEntries = [makeMergeEntry({ merged: false, reason: "conflict" })];
    const revertEntries = [makeRevertEntry()];

    const stats = aggregateMergeStats(mergeEntries, TODAY, revertEntries);
    expect(stats.postMergeReverts).toBe(1);
    expect(stats.revertRate).toBe(0); // 0 merged → revert rate 0
  });

  it("handles undefined revert entries (backward compat)", () => {
    const mergeEntries = [makeMergeEntry()];
    const stats = aggregateMergeStats(mergeEntries, TODAY, undefined);
    expect(stats.postMergeReverts).toBe(0);
    expect(stats.revertRate).toBe(0);
  });
});

describe("computeHealthScore with reverts", () => {
  function makeBaseData(): Omit<DashboardData, "healthScore" | "topConcern" | "generatedAt"> {
    return {
      jobs: {
        total: 10,
        complete: 10,
        failed: 0,
        queued: 0,
        running: 0,
        successRate: 100,
        totalCostUsd: 10,
        avgCostPerJob: 1,
        avgDurationSec: 60,
        failureBreakdown: {},
        rateLimited: 0,
        crashRecoveries: 0,
        crashRecoverySavedUsd: 0,
      },
      oracle: { totalDecisions: 10, accuracyPercent: 100, confidenceAvg: 9, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 100, dailySpentUsd: 10, dailyRemaining: 90, jobCount: 10, maxJobsPerDay: 50, byInstance: {} },
      adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
      bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
      mergeHealth: {
        totalAttempts: 5,
        merged: 5,
        blocked: 0,
        successRate: 100,
        avgTestDurationMs: 5000,
        testFailures: 0,
        rebaseConflicts: 0,
        postMergeReverts: 0,
        revertRate: 0,
      },
      composition: { composedJobs: 0, avgSkillsBefore: 0, avgSkillsAfter: 0, estimatedSavingsUsd: 0 },
      compositionIntelligence: { oracleActive: false, oracleAdjustedJobs: 0, oracleFailureRate: 0, staticFailureRate: 0, skipRiskScores: {}, circuitBreaker: "ok" },
      instances: [],
    };
  }

  it("post-merge reverts become top concern when > 0", () => {
    const data = makeBaseData();
    data.mergeHealth!.postMergeReverts = 2;
    const { topConcern } = computeHealthScore(data);
    expect(topConcern).toContain("2 merge(s) auto-reverted");
    expect(topConcern).toContain("merge-reverts.jsonl");
  });

  it("reverts take priority over oracle circuit breaker", () => {
    const data = makeBaseData();
    data.mergeHealth!.postMergeReverts = 1;
    data.oracle.circuitBreakerTripped = true;
    const { topConcern } = computeHealthScore(data);
    expect(topConcern).toContain("auto-reverted");
    expect(topConcern).not.toContain("Oracle");
  });

  it("no revert concern when postMergeReverts is 0", () => {
    const data = makeBaseData();
    data.mergeHealth!.postMergeReverts = 0;
    const { topConcern } = computeHealthScore(data);
    expect(topConcern).toBeNull();
  });
});

describe("formatDashboard merge health reverts row", () => {
  function makeFullData(postMergeReverts: number, revertRate: number): DashboardData {
    return {
      generatedAt: "2026-03-30T10:00:00.000Z",
      healthScore: 90,
      topConcern: null,
      jobs: {
        total: 5, complete: 5, failed: 0, queued: 0, running: 0,
        successRate: 100, totalCostUsd: 5, avgCostPerJob: 1, avgDurationSec: 60,
        failureBreakdown: {}, rateLimited: 0, crashRecoveries: 0, crashRecoverySavedUsd: 0,
      },
      oracle: { totalDecisions: 0, accuracyPercent: 100, confidenceAvg: 0, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 100, dailySpentUsd: 5, dailyRemaining: 95, jobCount: 5, maxJobsPerDay: 50, byInstance: {} },
      adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
      bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
      mergeHealth: {
        totalAttempts: 10, merged: 10, blocked: 0, successRate: 100,
        avgTestDurationMs: 5000, testFailures: 0, rebaseConflicts: 0,
        postMergeReverts, revertRate,
      },
      composition: { composedJobs: 0, avgSkillsBefore: 0, avgSkillsAfter: 0, estimatedSavingsUsd: 0 },
      compositionIntelligence: { oracleActive: false, oracleAdjustedJobs: 0, oracleFailureRate: 0, staticFailureRate: 0, skipRiskScores: {}, circuitBreaker: "ok" },
      instances: [],
    };
  }

  it("includes Reverts row when postMergeReverts > 0", () => {
    const data = makeFullData(2, 20);
    const md = formatDashboard(data);
    expect(md).toContain("| Reverts | 2 (20.0% revert rate) |");
  });

  it("omits Reverts row when postMergeReverts is 0", () => {
    const data = makeFullData(0, 0);
    const md = formatDashboard(data);
    expect(md).not.toContain("Reverts");
  });

  it("formats fractional revert rate", () => {
    const data = makeFullData(1, 7.14);
    const md = formatDashboard(data);
    expect(md).toContain("7.1% revert rate");
  });
});
