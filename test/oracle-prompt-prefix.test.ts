import { describe, it, expect } from "vitest";
import { buildOraclePromptPrefix, DECISION_PRINCIPLES } from "../src/oracle.js";
import type { OraclePromptPrefixInput } from "../src/oracle.js";
import type { OracleMemoryFiles } from "../src/types.js";

function makePrefixInput(overrides: Partial<OraclePromptPrefixInput> = {}): OraclePromptPrefixInput {
  return {
    skillName: "qa",
    decisionHistory: [],
    ...overrides,
  };
}

describe("buildOraclePromptPrefix", () => {
  it("includes system preamble and Decision Principles", () => {
    const prefix = buildOraclePromptPrefix(makePrefixInput());
    expect(prefix).toContain("You are a decision-making oracle for GaryClaw");
    expect(prefix).toContain("## Decision Principles");
    expect(prefix).toContain(DECISION_PRINCIPLES);
  });

  it("includes skill name in Current Context", () => {
    const prefix = buildOraclePromptPrefix(makePrefixInput({ skillName: "design-review" }));
    expect(prefix).toContain("- Skill: /design-review");
  });

  it("includes projectContext when provided", () => {
    const prefix = buildOraclePromptPrefix(makePrefixInput({ projectContext: "MyProject" }));
    expect(prefix).toContain("- Project: MyProject");
  });

  it("omits projectContext line when not provided", () => {
    const prefix = buildOraclePromptPrefix(makePrefixInput());
    expect(prefix).not.toContain("- Project:");
  });

  it("truncates projectContext at 500 chars", () => {
    const longContext = "A".repeat(600);
    const prefix = buildOraclePromptPrefix(makePrefixInput({ projectContext: longContext }));
    expect(prefix).toContain("A".repeat(500));
    expect(prefix).not.toContain("A".repeat(501));
  });

  it("injects all memory sections when provided", () => {
    const memory: OracleMemoryFiles = {
      taste: "Be concise",
      domainExpertise: "WebSocket best practices",
      decisionOutcomes: "Used vitest — worked well",
      memoryMd: "Project uses ESM",
    };

    const prefix = buildOraclePromptPrefix(makePrefixInput({ memory }));
    expect(prefix).toContain("## Taste Profile (personal preferences)\nBe concise");
    expect(prefix).toContain("## Domain Expertise (researched knowledge)\nWebSocket best practices");
    expect(prefix).toContain("## Decision Outcomes (what worked and what didn't — P7 applies here)\nUsed vitest — worked well");
    expect(prefix).toContain("## Project Memory (MEMORY.md)\nProject uses ESM");
  });

  it("omits memory sections when memory not provided", () => {
    const prefix = buildOraclePromptPrefix(makePrefixInput());
    expect(prefix).not.toContain("Taste Profile");
    expect(prefix).not.toContain("Domain Expertise");
    expect(prefix).not.toContain("Decision Outcomes");
    expect(prefix).not.toContain("Project Memory");
  });

  it("omits individual memory sections that are null", () => {
    const memory: OracleMemoryFiles = {
      taste: "Be concise",
      domainExpertise: null,
      decisionOutcomes: null,
      memoryMd: null,
    };

    const prefix = buildOraclePromptPrefix(makePrefixInput({ memory }));
    expect(prefix).toContain("Taste Profile");
    expect(prefix).not.toContain("Domain Expertise");
    expect(prefix).not.toContain("Decision Outcomes");
    expect(prefix).not.toContain("Project Memory");
  });

  it("includes recent decisions capped at 5", () => {
    const decisions = Array.from({ length: 8 }, (_, i) => ({
      timestamp: `2026-03-25T10:0${i}:00Z`,
      sessionIndex: 0,
      question: `Question ${i + 1}?`,
      options: [],
      chosen: `Choice ${i + 1}`,
      confidence: 9,
      rationale: "test",
      principle: "DRY",
    }));

    const prefix = buildOraclePromptPrefix(makePrefixInput({ decisionHistory: decisions }));
    expect(prefix).toContain("## Recent Decisions (last 5)");
    // Should have the last 5 (indices 3-7)
    expect(prefix).not.toContain("Question 1?");
    expect(prefix).not.toContain("Question 3?");
    expect(prefix).toContain("Question 4?");
    expect(prefix).toContain("Question 8?");
  });

  it("omits Recent Decisions section when history is empty", () => {
    const prefix = buildOraclePromptPrefix(makePrefixInput({ decisionHistory: [] }));
    expect(prefix).not.toContain("Recent Decisions");
  });

  it("memory injects between principles and recent decisions", () => {
    const memory: OracleMemoryFiles = {
      taste: "TASTE_MARKER",
      domainExpertise: null,
      decisionOutcomes: null,
      memoryMd: null,
    };

    const input = makePrefixInput({
      memory,
      decisionHistory: [{
        timestamp: "2026-03-25T10:00:00Z",
        sessionIndex: 0,
        question: "Previous?",
        options: [],
        chosen: "Yes",
        confidence: 9,
        rationale: "test",
        principle: "DRY",
      }],
    });

    const prefix = buildOraclePromptPrefix(input);
    const principlesIdx = prefix.indexOf("Decision Principles");
    const tasteIdx = prefix.indexOf("TASTE_MARKER");
    const recentIdx = prefix.indexOf("Recent Decisions");

    expect(principlesIdx).toBeLessThan(tasteIdx);
    expect(tasteIdx).toBeLessThan(recentIdx);
  });
});
