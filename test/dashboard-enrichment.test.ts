/**
 * Tests for bootstrap enrichment dashboard stats —
 * aggregateBootstrapEnrichmentStats and formatDashboard enrichment section.
 */

import { describe, it, expect } from "vitest";
import {
  aggregateBootstrapEnrichmentStats,
  formatDashboard,
} from "../src/dashboard.js";
import type { DashboardData } from "../src/types.js";

// ── aggregateBootstrapEnrichmentStats ──────────────────────────

describe("aggregateBootstrapEnrichmentStats", () => {
  it("returns zeros when no enrichment records", () => {
    const result = aggregateBootstrapEnrichmentStats([]);
    expect(result.triggered).toBe(0);
    expect(result.avgScoreImprovement).toBe(0);
  });

  it("counts enrichment triggers", () => {
    const records = [
      { previousScore: 30, enrichedScore: 65 },
      { previousScore: 25, enrichedScore: 70 },
    ];
    const result = aggregateBootstrapEnrichmentStats(records);
    expect(result.triggered).toBe(2);
  });

  it("computes average score improvement", () => {
    const records = [
      { previousScore: 30, enrichedScore: 70 }, // +40
      { previousScore: 20, enrichedScore: 60 }, // +40
    ];
    const result = aggregateBootstrapEnrichmentStats(records);
    expect(result.avgScoreImprovement).toBe(40);
  });

  it("handles negative score improvement (regression)", () => {
    const records = [
      { previousScore: 45, enrichedScore: 40 }, // -5
    ];
    const result = aggregateBootstrapEnrichmentStats(records);
    expect(result.avgScoreImprovement).toBe(-5);
  });

  it("handles single record", () => {
    const records = [
      { previousScore: 25, enrichedScore: 72 },
    ];
    const result = aggregateBootstrapEnrichmentStats(records);
    expect(result.triggered).toBe(1);
    expect(result.avgScoreImprovement).toBe(47);
  });
});

// ── formatDashboard enrichment section ──────────────────────────

describe("formatDashboard enrichment section", () => {
  function makeBaseDashboardData(enrichmentOverrides: Partial<DashboardData["bootstrapEnrichment"]> = {}): DashboardData {
    return {
      generatedAt: "2026-03-29T10:00:00Z",
      healthScore: 90,
      topConcern: null,
      jobs: { total: 3, complete: 3, failed: 0, queued: 0, running: 0, successRate: 100, totalCostUsd: 5.0, avgCostPerJob: 1.67, avgDurationSec: 120, failureBreakdown: {}, crashRecoveries: 0, crashRecoverySavedUsd: 0 },
      oracle: { totalDecisions: 10, accuracyPercent: 100, confidenceAvg: 9.0, circuitBreakerTripped: false },
      budget: { dailyLimitUsd: 25, dailySpentUsd: 5.0, dailyRemaining: 20, jobCount: 3, maxJobsPerDay: 20, byInstance: {} },
      adaptiveTurns: { totalSegments: 0, adaptiveSegments: 0, fallbackSegments: 0, clampedSegments: 0, heavyToolActivations: 0, avgTurns: 0, minTurns: 0, maxTurns: 0, adaptiveRate: 0 },
      bootstrapEnrichment: { triggered: 0, avgScoreImprovement: 0, ...enrichmentOverrides },
      instances: [],
    };
  }

  it("omits enrichment section when no enrichments triggered", () => {
    const md = formatDashboard(makeBaseDashboardData());
    expect(md).not.toContain("## Bootstrap Enrichment");
  });

  it("renders enrichment section when enrichments triggered", () => {
    const md = formatDashboard(makeBaseDashboardData({ triggered: 2, avgScoreImprovement: 35 }));
    expect(md).toContain("## Bootstrap Enrichment");
    expect(md).toContain("| Enrichments Triggered | 2 |");
    expect(md).toContain("| Avg Score Improvement | +35 pts |");
  });

  it("shows negative delta without + prefix", () => {
    const md = formatDashboard(makeBaseDashboardData({ triggered: 1, avgScoreImprovement: -5 }));
    expect(md).toContain("| Avg Score Improvement | -5 pts |");
  });

  it("renders enrichment section between adaptive turns and budget", () => {
    const data = makeBaseDashboardData({ triggered: 1, avgScoreImprovement: 20 });
    const md = formatDashboard(data);
    const enrichmentIdx = md.indexOf("## Bootstrap Enrichment");
    const budgetIdx = md.indexOf("## Budget");
    expect(enrichmentIdx).toBeGreaterThan(-1);
    expect(budgetIdx).toBeGreaterThan(enrichmentIdx);
  });
});
