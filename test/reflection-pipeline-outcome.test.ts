import { describe, it, expect } from "vitest";
import { buildPipelineOutcome, countPipelineOutcomes } from "../src/reflection.js";

// ── buildPipelineOutcome ────────────────────────────────────────

describe("buildPipelineOutcome", () => {
  it("builds success outcome for 0 QA issues", () => {
    const result = buildPipelineOutcome(
      { skills: ["implement", "qa"], composedFrom: ["implement", "plan-eng-review", "qa"], compositionMethod: "static" },
      0,
      1.50,
    );
    expect(result).toContain("Pipeline: [implement -> qa]");
    expect(result).toContain("Skipped: [plan-eng-review]");
    expect(result).toContain("Method: static");
    expect(result).toContain("QA issues: 0");
    expect(result).toContain("Cost: $1.50");
    expect(result).toContain("Outcome: success");
  });

  it("builds acceptable outcome for 1-2 QA issues", () => {
    const result = buildPipelineOutcome(
      { skills: ["implement", "qa"] },
      1,
      0.80,
    );
    expect(result).toContain("Outcome: acceptable");
  });

  it("builds acceptable outcome for exactly 2 QA issues", () => {
    const result = buildPipelineOutcome(
      { skills: ["implement", "qa"] },
      2,
      0.80,
    );
    expect(result).toContain("Outcome: acceptable");
  });

  it("builds failure outcome for 3+ QA issues", () => {
    const result = buildPipelineOutcome(
      { skills: ["implement", "qa"], composedFrom: ["office-hours", "implement", "qa"], compositionMethod: "oracle" },
      3,
      2.10,
    );
    expect(result).toContain("Outcome: failure");
    expect(result).toContain("Skipped: [office-hours]");
    expect(result).toContain("Method: oracle");
  });

  it("builds failure outcome for many QA issues", () => {
    const result = buildPipelineOutcome(
      { skills: ["implement", "qa"] },
      10,
      3.00,
    );
    expect(result).toContain("Outcome: failure");
    expect(result).toContain("QA issues: 10");
  });

  it("omits Skipped section when composedFrom is undefined", () => {
    const result = buildPipelineOutcome(
      { skills: ["implement", "qa"] },
      0,
      0.50,
    );
    expect(result).not.toContain("Skipped:");
    expect(result).toContain("Pipeline: [implement -> qa]");
  });

  it("omits Skipped section when no skills were actually skipped", () => {
    const result = buildPipelineOutcome(
      { skills: ["implement", "qa"], composedFrom: ["implement", "qa"] },
      0,
      0.50,
    );
    expect(result).not.toContain("Skipped:");
  });

  it("shows Method: none when compositionMethod is undefined", () => {
    const result = buildPipelineOutcome(
      { skills: ["implement", "qa"] },
      0,
      0.50,
    );
    expect(result).toContain("Method: none");
  });

  it("formats cost with 2 decimal places", () => {
    const result = buildPipelineOutcome(
      { skills: ["qa"] },
      0,
      0.1,
    );
    expect(result).toContain("Cost: $0.10");
  });

  it("handles single-skill pipeline", () => {
    const result = buildPipelineOutcome(
      { skills: ["qa"] },
      0,
      0.30,
    );
    expect(result).toContain("Pipeline: [qa]");
  });

  it("handles multi-skill pipeline with all skills shown", () => {
    const result = buildPipelineOutcome(
      {
        skills: ["prioritize", "office-hours", "implement", "plan-eng-review", "qa"],
        composedFrom: ["prioritize", "office-hours", "implement", "plan-eng-review", "qa"],
      },
      0,
      4.00,
    );
    expect(result).toContain("Pipeline: [prioritize -> office-hours -> implement -> plan-eng-review -> qa]");
    expect(result).not.toContain("Skipped:");
  });

  it("correctly computes multiple skipped skills", () => {
    const result = buildPipelineOutcome(
      {
        skills: ["implement", "qa"],
        composedFrom: ["prioritize", "office-hours", "implement", "plan-eng-review", "qa"],
        compositionMethod: "static",
      },
      0,
      0.50,
    );
    expect(result).toContain("Skipped: [prioritize, office-hours, plan-eng-review]");
  });
});

// ── countPipelineOutcomes ────────────────────────────────────────

describe("countPipelineOutcomes", () => {
  it("returns 0 for null input", () => {
    expect(countPipelineOutcomes(null)).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(countPipelineOutcomes("")).toBe(0);
  });

  it("returns 0 for content with no pipeline entries", () => {
    const content = "### Decision Outcomes\n- d-1: success\n- d-2: neutral\n";
    expect(countPipelineOutcomes(content)).toBe(0);
  });

  it("counts pipeline outcome entries", () => {
    const content = [
      "### Pipeline Outcomes",
      "Pipeline: [implement -> qa] | Skipped: [office-hours] | Method: static | QA issues: 0 | Cost: $0.50 | Outcome: success",
      "Pipeline: [implement -> plan-eng-review -> qa] | Method: oracle | QA issues: 2 | Cost: $1.20 | Outcome: acceptable",
      "Pipeline: [office-hours -> implement -> qa] | Skipped: [plan-eng-review] | Method: static | QA issues: 5 | Cost: $2.00 | Outcome: failure",
    ].join("\n");
    expect(countPipelineOutcomes(content)).toBe(3);
  });

  it("counts correctly when mixed with non-pipeline entries", () => {
    const content = [
      "### Decision Outcomes",
      "- d-1: Fixed issue in types.ts → success",
      "- d-2: Skipped dashboard change → neutral",
      "",
      "### Pipeline Outcomes",
      "Pipeline: [implement -> qa] | Outcome: success",
      "- d-3: another decision outcome",
      "Pipeline: [office-hours -> implement -> qa] | Outcome: failure",
    ].join("\n");
    expect(countPipelineOutcomes(content)).toBe(2);
  });

  it("does not count partial matches", () => {
    const content = "Some text about Pipeline: not a real entry\nAnother line with Pipeline: [but indented";
    // Only lines starting with "Pipeline: [" count
    expect(countPipelineOutcomes(content)).toBe(0);
  });

  it("counts single entry", () => {
    const content = "Pipeline: [qa] | Method: none | QA issues: 0 | Cost: $0.30 | Outcome: success";
    expect(countPipelineOutcomes(content)).toBe(1);
  });
});
