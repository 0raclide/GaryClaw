// Regression: ISSUE-001 — extractOracleFields DRY helper produces identical output
// Found by /qa on 2026-03-29
// Report: .gstack/qa-reports/qa-report-garyclaw-worker-5-2026-03-29.md

import { describe, it, expect } from "vitest";
import { extractOracleFields, parseBatchOracleResponse } from "../src/oracle.js";

const OPTIONS = [
  { label: "Dark", description: "Dark theme" },
  { label: "Light", description: "Light theme" },
  { label: "Other", description: "Custom" },
];

describe("extractOracleFields", () => {
  it("extracts all 5 fields from a well-formed entry", () => {
    const result = extractOracleFields(
      { choice: "Dark", confidence: 8, rationale: "Better contrast", principle: "User preference", otherProposal: undefined },
      OPTIONS,
    );
    expect(result).toEqual({
      choice: "Dark",
      confidence: 8,
      rationale: "Better contrast",
      principle: "User preference",
      otherProposal: undefined,
    });
  });

  it("clamps confidence to 1-10 range", () => {
    // Note: confidence 0 is falsy, so `Number(0) || 5` defaults to 5, then clamped to 5
    expect(extractOracleFields({ choice: "Dark", confidence: 0 }, OPTIONS).confidence).toBe(5);
    expect(extractOracleFields({ choice: "Dark", confidence: 15 }, OPTIONS).confidence).toBe(10);
    expect(extractOracleFields({ choice: "Dark", confidence: -5 }, OPTIONS).confidence).toBe(1);
  });

  it("defaults missing rationale and principle", () => {
    const result = extractOracleFields({ choice: "Light" }, OPTIONS);
    expect(result.rationale).toBe("No rationale provided");
    expect(result.principle).toBe("Bias toward action");
  });

  it("extracts otherProposal when choice is Other", () => {
    const result = extractOracleFields(
      { choice: "Other", otherProposal: "Solarized" },
      OPTIONS,
    );
    expect(result.choice).toBe("Other");
    expect(result.otherProposal).toBe("Solarized");
  });

  it("ignores otherProposal when choice is not Other", () => {
    const result = extractOracleFields(
      { choice: "Dark", otherProposal: "Solarized" },
      OPTIONS,
    );
    expect(result.otherProposal).toBeUndefined();
  });

  it("handles empty entry object gracefully", () => {
    const result = extractOracleFields({}, OPTIONS);
    // resolveChoice with undefined falls back to first option
    expect(result.confidence).toBe(5); // Number(undefined) || 5
    expect(result.rationale).toBe("No rationale provided");
    expect(result.principle).toBe("Bias toward action");
  });

  it("produces same output as parseBatchOracleResponse for array path", () => {
    const raw = JSON.stringify([
      { choice: "Dark", confidence: 9, rationale: "High contrast", principle: "P1" },
      { choice: "Light", confidence: 6, rationale: "Readable", principle: "P3", otherProposal: "ignored" },
    ]);
    const questions = [
      { question: "Q1", options: OPTIONS },
      { question: "Q2", options: OPTIONS },
    ];
    const batchResults = parseBatchOracleResponse(raw, questions);
    // Verify each uses extractOracleFields — same defaults, same clamping
    expect(batchResults[0].choice).toBe("Dark");
    expect(batchResults[0].confidence).toBe(9);
    expect(batchResults[1].otherProposal).toBeUndefined(); // Light, not Other
  });
});
