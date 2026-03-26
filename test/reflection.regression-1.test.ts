/**
 * Regression: ISSUE-003 — unbounded description length in findRelatedIssue
 * Found by /qa on 2026-03-26
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-26.md
 *
 * Before fix: a 100K-char description would create a massive Set in memory.
 * After fix: descriptions are capped at 2000 chars before keyword matching.
 */

import { describe, it, expect } from "vitest";
import type { Decision, Issue } from "../src/types.js";
import { findRelatedIssue } from "../src/reflection.js";

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    timestamp: "2026-03-26T10:00:00.000Z",
    sessionIndex: 0,
    question: "Should we fix the alignment padding overflow bug?",
    options: [
      { label: "Yes", description: "Fix it" },
      { label: "No", description: "Skip it" },
    ],
    chosen: "Yes",
    confidence: 8,
    rationale: "Clear fix",
    principle: "Bias toward action",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "ISSUE-001",
    severity: "medium",
    category: "Functional",
    description: "Alignment padding overflow bug in layout",
    status: "open",
    ...overrides,
  };
}

describe("ISSUE-003: description length cap in findRelatedIssue", () => {
  it("handles a very long description without excessive memory", () => {
    // Generate a 100K description with repeated words
    const longDesc = "alignment padding overflow bug ".repeat(3500); // ~105K chars
    const issue = makeIssue({ description: longDesc });
    const decision = makeDecision();

    // Should still match via keyword overlap (words exist in first 2000 chars)
    const result = findRelatedIssue(decision, [issue]);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ISSUE-001");
  });

  it("matches keywords that appear only within the 2000-char window", () => {
    // Put matching words at the start, then pad with noise
    const desc = "alignment padding overflow bug " + "x".repeat(5000);
    const issue = makeIssue({ description: desc });
    const decision = makeDecision();

    const result = findRelatedIssue(decision, [issue]);
    expect(result).not.toBeNull();
  });

  it("does not match keywords that appear only after the 2000-char cutoff", () => {
    // Only noise for first 2000 chars, matching words come after
    const desc = "x ".repeat(1200) + "alignment padding overflow bug";
    const issue = makeIssue({ description: desc });
    // Decision question has alignment/padding/overflow — but they're past the cap
    const decision = makeDecision({
      question: "Should we fix alignment padding overflow?",
    });

    const result = findRelatedIssue(decision, [issue]);
    // Should NOT match via keyword overlap since matching words are past 2000 chars
    // (May still match via other heuristics like ID)
    // The point is the Set only contains words from the first 2000 chars
    expect(result).toBeNull();
  });

  it("still handles normal-length descriptions correctly", () => {
    const issue = makeIssue();
    const decision = makeDecision();

    const result = findRelatedIssue(decision, [issue]);
    expect(result).not.toBeNull();
  });
});
