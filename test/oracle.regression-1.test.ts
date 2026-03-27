// Regression: ISSUE-003 — ESCALATION_PHRASES "delete" matches substrings like "undelete"
// Found by /qa on 2026-03-27
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md

import { describe, it, expect } from "vitest";
import { askOracle, ESCALATION_PHRASES } from "../src/oracle.js";
import type { OracleInput, OracleConfig } from "../src/oracle.js";

function makeInput(question: string): OracleInput {
  return {
    question,
    options: [
      { label: "A", description: "Yes" },
      { label: "B", description: "No" },
    ],
    skillName: "qa",
    decisionHistory: [],
    projectContext: "Test project",
  };
}

function makeConfig(choice = "A", confidence = 8): OracleConfig {
  return {
    queryFn: async () =>
      JSON.stringify({ choice, confidence, rationale: "Test", principle: "Bias toward action" }),
    escalateThreshold: 6,
  };
}

describe("ESCALATION_PHRASES — word boundary regression", () => {
  it("does NOT escalate on 'undelete' (contains 'delete' as substring)", async () => {
    const result = await askOracle(makeInput("Should we undelete the record?"), makeConfig());
    expect(result.escalate).toBe(false);
  });

  it("does NOT escalate on 'deleted' past tense in benign context", async () => {
    const result = await askOracle(makeInput("The file was already deleted, should we log it?"), makeConfig());
    // "deleted" ends at word boundary but starts at word boundary too — \bdelete\b won't match "deleted"
    // because "deleted" has an extra "d" after "delete"
    expect(result.escalate).toBe(false);
  });

  it("DOES escalate on exact 'delete' with word boundaries", async () => {
    const result = await askOracle(makeInput("Should we delete the user account?"), makeConfig());
    expect(result.escalate).toBe(true);
  });

  it("DOES escalate on 'delete' at end of sentence", async () => {
    const result = await askOracle(makeInput("The action is to delete"), makeConfig());
    expect(result.escalate).toBe(true);
  });

  it("does NOT escalate on 'dropdown' (contains 'drop' as substring)", async () => {
    const result = await askOracle(makeInput("Should we use a dropdown menu?"), makeConfig());
    expect(result.escalate).toBe(false);
  });

  it("DOES escalate on exact 'drop' as standalone word", async () => {
    const result = await askOracle(makeInput("Should we drop the table?"), makeConfig());
    expect(result.escalate).toBe(true);
  });

  it("does NOT escalate on 'destroyer' (contains 'destroy' substring)", async () => {
    const result = await askOracle(makeInput("The destroyer pattern handles cleanup"), makeConfig());
    expect(result.escalate).toBe(false);
  });

  it("DOES escalate on 'force push' exact phrase", async () => {
    const result = await askOracle(makeInput("Should we force push to main?"), makeConfig());
    expect(result.escalate).toBe(true);
  });

  it("does NOT escalate on 'production-like' in description option", async () => {
    const input: OracleInput = {
      question: "Which environment?",
      options: [
        { label: "A", description: "Use a production-like staging" },
        { label: "B", description: "Use local dev" },
      ],
      skillName: "qa",
      decisionHistory: [],
      projectContext: "Test project",
    };
    // "production" has word boundary at hyphen, but \bproduction\b should still match
    // because "-" is not a word char. This IS expected to escalate.
    const result = await askOracle(input, makeConfig());
    expect(result.escalate).toBe(true);
  });
});
