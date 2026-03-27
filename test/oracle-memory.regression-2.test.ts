// Regression: ISSUE-001 — Shallow copy in updateMetricsWithOutcome shared confidenceTrend array reference
// Found by /qa on 2026-03-27
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md

import { describe, it, expect } from "vitest";
import type { DecisionOutcome, OracleMetrics } from "../src/types.js";
import { updateMetricsWithOutcome } from "../src/oracle-memory.js";

function makeMetrics(overrides: Partial<OracleMetrics> = {}): OracleMetrics {
  return {
    totalDecisions: 5,
    accurateDecisions: 4,
    neutralDecisions: 0,
    failedDecisions: 1,
    accuracyPercent: 80,
    confidenceTrend: [7, 8, 6, 9, 7],
    circuitBreakerTripped: false,
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<DecisionOutcome> = {}): DecisionOutcome {
  return {
    decisionId: "d-test",
    timestamp: new Date().toISOString(),
    question: "test?",
    chosenOption: "A",
    outcome: "success",
    confidence: 8,
    ...overrides,
  };
}

describe("updateMetricsWithOutcome — array isolation (ISSUE-001)", () => {
  it("does not mutate the original metrics confidenceTrend array", () => {
    const original = makeMetrics({ confidenceTrend: [5, 6, 7] });
    const originalTrend = original.confidenceTrend;
    const updated = updateMetricsWithOutcome(original, makeOutcome({ confidence: 9 }));

    // Updated should have the new value appended
    expect(updated.confidenceTrend).toEqual([5, 6, 7, 9]);
    // Original must be untouched
    expect(original.confidenceTrend).toEqual([5, 6, 7]);
    // Must be different array references
    expect(updated.confidenceTrend).not.toBe(originalTrend);
    expect(original.confidenceTrend).toBe(originalTrend);
  });

  it("does not share array reference between input and output", () => {
    const metrics = makeMetrics({ confidenceTrend: [1, 2, 3] });
    const result = updateMetricsWithOutcome(metrics, makeOutcome({ confidence: 4 }));

    // Mutating the result should not affect the input
    result.confidenceTrend.push(99);
    expect(metrics.confidenceTrend).toEqual([1, 2, 3]);
  });

  it("handles empty confidenceTrend without sharing reference", () => {
    const metrics = makeMetrics({ confidenceTrend: [] });
    const result = updateMetricsWithOutcome(metrics, makeOutcome({ confidence: 5 }));

    expect(result.confidenceTrend).toEqual([5]);
    expect(metrics.confidenceTrend).toEqual([]);
    expect(result.confidenceTrend).not.toBe(metrics.confidenceTrend);
  });

  it("respects rolling window of 20 without mutating original", () => {
    const trend = Array.from({ length: 20 }, (_, i) => i + 1);
    const metrics = makeMetrics({ confidenceTrend: trend });
    const result = updateMetricsWithOutcome(metrics, makeOutcome({ confidence: 99 }));

    // Should drop oldest, keep last 19 + new
    expect(result.confidenceTrend).toHaveLength(20);
    expect(result.confidenceTrend[19]).toBe(99);
    expect(result.confidenceTrend[0]).toBe(2); // dropped 1
    // Original untouched
    expect(metrics.confidenceTrend).toHaveLength(20);
    expect(metrics.confidenceTrend[0]).toBe(1);
  });
});
