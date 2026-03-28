// Regression: ISSUE-001 — createSdkOracleQueryFn used raw type cast instead of extractResultData
// Found by /qa on 2026-03-28
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md

import { describe, it, expect, vi } from "vitest";
import { askOracle } from "../src/oracle.js";
import type { OracleInput, OracleConfig } from "../src/oracle.js";

function makeInput(): OracleInput {
  return {
    question: "Which approach?",
    options: [
      { label: "A", description: "Simple" },
      { label: "B", description: "Complex" },
    ],
    skillName: "qa",
    decisionHistory: [],
  };
}

describe("Oracle queryFn result parsing regression", () => {
  it("parses result correctly when queryFn returns valid JSON", async () => {
    const config: OracleConfig = {
      queryFn: vi.fn().mockResolvedValue(
        JSON.stringify({ choice: "B", confidence: 8, rationale: "Better", principle: "Bias toward action" }),
      ),
      escalateThreshold: 6,
    };

    const result = await askOracle(makeInput(), config);
    expect(result.choice).toBe("B");
    expect(result.confidence).toBe(8);
  });

  it("falls back gracefully when queryFn returns empty string", async () => {
    // This is what happened when the old raw cast didn't match the SDK shape
    const config: OracleConfig = {
      queryFn: vi.fn().mockResolvedValue(""),
      escalateThreshold: 6,
    };

    const result = await askOracle(makeInput(), config);
    // Should fall back to first option with low confidence, not crash
    expect(result.choice).toBe("A");
    expect(result.confidence).toBeLessThanOrEqual(5);
  });

  it("falls back when queryFn returns non-JSON text", async () => {
    const config: OracleConfig = {
      queryFn: vi.fn().mockResolvedValue("I think option B is better because..."),
      escalateThreshold: 6,
    };

    const result = await askOracle(makeInput(), config);
    // Should still produce a result, not crash
    expect(result.choice).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
  });
});
