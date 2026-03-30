/**
 * Dashboard PR stats tests — aggregation and formatting of PR-created merge audit entries.
 */

import { describe, it, expect } from "vitest";
import { aggregateMergeStats, formatDashboard } from "../src/dashboard.js";
import type { MergeAuditEntry } from "../src/worktree.js";
import type { DashboardData } from "../src/types.js";

const TODAY = "2026-03-30";

function makeEntry(overrides: Partial<MergeAuditEntry> = {}): MergeAuditEntry {
  return {
    timestamp: `${TODAY}T12:00:00.000Z`,
    instanceName: "worker-1",
    branch: "garyclaw/worker-1",
    baseBranch: "main",
    commitCount: 3,
    merged: true,
    ...overrides,
  };
}

describe("aggregateMergeStats PR fields", () => {
  it("counts PR-created entries", () => {
    const entries: MergeAuditEntry[] = [
      makeEntry({ reason: "PR #42 created", merged: false }),
      makeEntry({ reason: "PR #43 created", merged: false }),
      makeEntry({ merged: true }),  // direct merge, not a PR
    ];
    const stats = aggregateMergeStats(entries, TODAY);
    expect(stats.prsCreated).toBe(2);
  });

  it("returns 0 when no PR entries", () => {
    const entries: MergeAuditEntry[] = [
      makeEntry({ merged: true }),
    ];
    const stats = aggregateMergeStats(entries, TODAY);
    expect(stats.prsCreated).toBe(0);
  });

  it("filters PR entries by today's date", () => {
    const entries: MergeAuditEntry[] = [
      makeEntry({ reason: "PR #42 created", timestamp: "2026-03-29T12:00:00.000Z" }),  // yesterday
      makeEntry({ reason: "PR #43 created" }),  // today
    ];
    const stats = aggregateMergeStats(entries, TODAY);
    expect(stats.prsCreated).toBe(1);
  });

  it("prsAutoMergeEnabled matches prsCreated", () => {
    const entries: MergeAuditEntry[] = [
      makeEntry({ reason: "PR #42 created", merged: false }),
    ];
    const stats = aggregateMergeStats(entries, TODAY);
    expect(stats.prsAutoMergeEnabled).toBe(stats.prsCreated);
  });

  it("returns 0 for empty entries", () => {
    const stats = aggregateMergeStats([], TODAY);
    expect(stats.prsCreated).toBe(0);
    expect(stats.prsAutoMergeEnabled).toBe(0);
  });
});

describe("formatDashboard PR stats row", () => {
  function makeMinimalDashboard(prsCreated: number): DashboardData {
    return {
      generatedAt: "2026-03-30T12:00:00.000Z",
      healthScore: 85,
      topConcern: null,
      jobs: { total: 5, complete: 5, failed: 0, queued: 0, running: 0, successRate: 100, totalCostUsd: 2.5, avgCostPerJob: 0.5, avgDurationSec: 60, failureBreakdown: {}, rateLimited: 0, crashRecoveries: 0, crashRecoverySavedUsd: 0 },
      oracle: { totalDecisions: 10, accuracyPercent: 100, confidenceAvg: 9, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 50, dailySpentUsd: 2.5, dailyRemaining: 47.5, jobCount: 5, maxJobsPerDay: 20, byInstance: {} },
      adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
      bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
      mergeHealth: { totalAttempts: 3, merged: 1, blocked: 0, successRate: 100, avgTestDurationMs: 5000, testFailures: 0, rebaseConflicts: 0, postMergeReverts: 0, revertRate: 0, prsCreated, prsAutoMergeEnabled: prsCreated },
      composition: { composedJobs: 0, avgSkillsBefore: 0, avgSkillsAfter: 0, estimatedSavingsUsd: 0 },
      compositionIntelligence: { oracleActive: false, oracleAdjustedJobs: 0, oracleFailureRate: 0, staticFailureRate: 0, skipRiskScores: {}, circuitBreaker: "ok" },
      instances: [],
    };
  }

  it("includes PRs Created row when prsCreated > 0", () => {
    const md = formatDashboard(makeMinimalDashboard(2));
    expect(md).toContain("| PRs Created | 2 |");
  });

  it("omits PRs Created row when prsCreated is 0", () => {
    const md = formatDashboard(makeMinimalDashboard(0));
    expect(md).not.toContain("PRs Created");
  });
});
