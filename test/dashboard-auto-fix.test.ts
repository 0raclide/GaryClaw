/**
 * Dashboard auto-fix stats tests — aggregation and formatting of
 * auto-fix (post-merge-revert) job statistics.
 *
 * All synthetic data — no file I/O.
 */

import { describe, it, expect } from "vitest";
import { aggregateMergeStats, formatDashboard } from "../src/dashboard.js";
import type { DashboardData, Job } from "../src/types.js";
import type { MergeAuditEntry } from "../src/worktree.js";

const TODAY = "2026-03-30";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-001",
    triggeredBy: "continuous",
    triggerDetail: "test",
    skills: ["implement", "qa"],
    projectDir: "/tmp/test",
    status: "complete",
    enqueuedAt: `${TODAY}T10:00:00.000Z`,
    costUsd: 2.0,
    ...overrides,
  };
}

function makeAuditEntry(overrides: Partial<MergeAuditEntry> = {}): MergeAuditEntry {
  return {
    timestamp: `${TODAY}T10:00:00.000Z`,
    instanceName: "worker-1",
    branch: "garyclaw/worker-1",
    baseBranch: "main",
    merged: true,
    commitCount: 3,
    ...overrides,
  };
}

describe("dashboard auto-fix stats", () => {
  describe("aggregateMergeStats auto-fix fields", () => {
    it("returns zero auto-fix stats when no post-merge-revert jobs", () => {
      const result = aggregateMergeStats(
        [makeAuditEntry()],
        TODAY,
        [],
        [makeJob()],
      );
      expect(result.autoFixAttempts).toBe(0);
      expect(result.autoFixSuccesses).toBe(0);
      expect(result.autoFixCostUsd).toBe(0);
    });

    it("counts post-merge-revert jobs as auto-fix attempts", () => {
      const jobs = [
        makeJob({ id: "job-001", triggeredBy: "post-merge-revert", status: "complete", costUsd: 3.0 }),
        makeJob({ id: "job-002", triggeredBy: "post-merge-revert", status: "failed", costUsd: 1.5 }),
        makeJob({ id: "job-003", triggeredBy: "continuous", status: "complete", costUsd: 2.0 }),
      ];
      const result = aggregateMergeStats([makeAuditEntry()], TODAY, [], jobs);
      expect(result.autoFixAttempts).toBe(2);
      expect(result.autoFixSuccesses).toBe(1);
      expect(result.autoFixCostUsd).toBe(4.5);
    });

    it("filters to today only", () => {
      const jobs = [
        makeJob({ id: "job-001", triggeredBy: "post-merge-revert", enqueuedAt: "2026-03-29T10:00:00.000Z" }),
        makeJob({ id: "job-002", triggeredBy: "post-merge-revert", enqueuedAt: `${TODAY}T10:00:00.000Z` }),
      ];
      const result = aggregateMergeStats([], TODAY, [], jobs);
      expect(result.autoFixAttempts).toBe(1);
    });

    it("handles empty jobs array", () => {
      const result = aggregateMergeStats([], TODAY, [], []);
      expect(result.autoFixAttempts).toBe(0);
    });

    it("handles undefined jobs parameter", () => {
      const result = aggregateMergeStats([], TODAY, []);
      expect(result.autoFixAttempts).toBe(0);
    });
  });

  describe("formatDashboard auto-fix section", () => {
    function makeFullDashboard(mergeOverrides: Partial<DashboardData["mergeHealth"]> = {}): DashboardData {
      return {
        generatedAt: `${TODAY}T12:00:00.000Z`,
        healthScore: 85,
        topConcern: null,
        jobs: { total: 5, complete: 4, failed: 1, queued: 0, running: 0, successRate: 80, totalCostUsd: 10, avgCostPerJob: 2, avgDurationSec: 60, failureBreakdown: {}, rateLimited: 0, crashRecoveries: 0, crashRecoverySavedUsd: 0 },
        oracle: { totalDecisions: 10, accuracyPercent: 90, confidenceAvg: 8.5, circuitBreakerTripped: false },
        budget: { dailyLimitUsd: 50, dailySpentUsd: 10, dailyRemaining: 40, jobCount: 5, maxJobsPerDay: 20, byInstance: {} },
        adaptiveTurns: { totalSegments: 10, adaptiveSegments: 8, fallbackSegments: 2, clampedSegments: 0, heavyToolActivations: 1, avgTurns: 12, minTurns: 5, maxTurns: 15, adaptiveRate: 80 },
        bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0 },
        mergeHealth: {
          totalAttempts: 5, merged: 4, blocked: 1, successRate: 80, avgTestDurationMs: 5000,
          testFailures: 1, rebaseConflicts: 0, postMergeReverts: 1, revertRate: 25,
          prsCreated: 0, prsAutoMergeEnabled: 0,
          autoFixAttempts: 0, autoFixSuccesses: 0, autoFixCostUsd: 0,
          ...mergeOverrides,
        },
        composition: { composedJobs: 0, avgSkillsBefore: 0, avgSkillsAfter: 0, estimatedSavingsUsd: 0 },
        compositionIntelligence: { oracleActive: false, oracleAdjustedJobs: 0, oracleFailureRate: 0, staticFailureRate: 0, skipRiskScores: {}, circuitBreaker: "ok" },
        instances: [],
      };
    }

    it("includes Self-Healing section when autoFixAttempts > 0", () => {
      const data = makeFullDashboard({ autoFixAttempts: 2, autoFixSuccesses: 1, autoFixCostUsd: 5.50 });
      const output = formatDashboard(data);
      expect(output).toContain("### Self-Healing");
      expect(output).toContain("Auto-fix attempts | 2");
      expect(output).toContain("Auto-fix successes | 1 (50%)");
      expect(output).toContain("Auto-fix cost | $5.50");
    });

    it("omits Self-Healing section when autoFixAttempts is 0", () => {
      const data = makeFullDashboard({ autoFixAttempts: 0 });
      const output = formatDashboard(data);
      expect(output).not.toContain("Self-Healing");
    });

    it("shows 100% success rate when all auto-fix succeed", () => {
      const data = makeFullDashboard({ autoFixAttempts: 3, autoFixSuccesses: 3, autoFixCostUsd: 9.0 });
      const output = formatDashboard(data);
      expect(output).toContain("Auto-fix successes | 3 (100%)");
    });
  });
});
