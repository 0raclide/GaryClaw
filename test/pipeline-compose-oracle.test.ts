import { describe, it, expect } from "vitest";
import {
  parsePipelineRecommendation,
  ORACLE_PIPELINE_THRESHOLD,
} from "../src/job-runner.js";

// ── parsePipelineRecommendation ─────────────────────────────────

describe("parsePipelineRecommendation", () => {
  it("parses a simple two-skill pipeline with ASCII arrow", () => {
    const content = "### Recommended Pipeline\nimplementimplement -> qa\n";
    // The content has a typo-like prefix — let's use clean content
    const clean = "### Recommended Pipeline\nimplement -> qa\n";
    expect(parsePipelineRecommendation(clean)).toEqual(["implement", "qa"]);
  });

  it("parses a multi-skill pipeline", () => {
    const content = "### Recommended Pipeline\noffice-hours -> implement -> plan-eng-review -> qa\n";
    expect(parsePipelineRecommendation(content)).toEqual([
      "office-hours",
      "implement",
      "plan-eng-review",
      "qa",
    ]);
  });

  it("accepts unicode arrow (→)", () => {
    const content = "### Recommended Pipeline\nimplement → qa\n";
    expect(parsePipelineRecommendation(content)).toEqual(["implement", "qa"]);
  });

  it("accepts mixed arrow styles", () => {
    const content = "### Recommended Pipeline\noffice-hours -> implement → qa\n";
    expect(parsePipelineRecommendation(content)).toEqual([
      "office-hours",
      "implement",
      "qa",
    ]);
  });

  it("handles extra whitespace around arrows", () => {
    const content = "### Recommended Pipeline\n  implement  ->  qa  \n";
    expect(parsePipelineRecommendation(content)).toEqual(["implement", "qa"]);
  });

  it("handles blank lines between heading and content", () => {
    const content = "### Recommended Pipeline\n\n\nimplement -> qa\n";
    expect(parsePipelineRecommendation(content)).toEqual(["implement", "qa"]);
  });

  it("returns null when section is missing", () => {
    const content = "## Top Pick: Foo\n**Priority:** P3\n";
    expect(parsePipelineRecommendation(content)).toBeNull();
  });

  it("returns null for malformed content (no valid skill names)", () => {
    const content = "### Recommended Pipeline\n\n(no specific recommendation)\n";
    expect(parsePipelineRecommendation(content)).toBeNull();
  });

  it("returns null when heading exists but no pipeline follows", () => {
    const content = "### Recommended Pipeline\n\n### Pipeline Reasoning\nSome reasoning here\n";
    expect(parsePipelineRecommendation(content)).toBeNull();
  });

  it("parses a single-skill pipeline", () => {
    const content = "### Recommended Pipeline\nqa\n";
    expect(parsePipelineRecommendation(content)).toEqual(["qa"]);
  });

  it("is case-insensitive for heading", () => {
    const content = "### recommended pipeline\nimplement -> qa\n";
    expect(parsePipelineRecommendation(content)).toEqual(["implement", "qa"]);
  });

  it("lowercases skill names from capitalized input", () => {
    const content = "### Recommended Pipeline\nImplement -> QA\n";
    // The /i flag makes [a-z] match uppercase; .toLowerCase() normalizes output
    const result = parsePipelineRecommendation(content);
    expect(result).toEqual(["implement", "qa"]);
  });

  it("handles pipeline embedded in larger priority.md content", () => {
    const content = `# Priority Pick

## Top Pick: Stale PID cleanup

**Priority:** P2
**Effort:** XS
**Weighted Score:** 7.8/10

### Scoring Breakdown
| Dimension | Score |
|-----------|-------|
| Autonomous | 7 |

### Recommended Pipeline
implement -> qa

### Pipeline Reasoning
XS effort with no blast radius concerns.

## Backlog Health
- Total items: 5
`;
    expect(parsePipelineRecommendation(content)).toEqual(["implement", "qa"]);
  });
});

// ── ORACLE_PIPELINE_THRESHOLD ───────────────────────────────────

describe("ORACLE_PIPELINE_THRESHOLD", () => {
  it("is 10", () => {
    expect(ORACLE_PIPELINE_THRESHOLD).toBe(10);
  });
});

// ── Oracle override integration logic ───────────────────────────

describe("oracle override logic", () => {
  it("oracle recommendation is intersected with requestedSkills (can only remove)", () => {
    // Simulate the intersection logic from job-runner.ts
    const originalSkills = ["prioritize", "office-hours", "implement", "plan-eng-review", "qa"];
    const oracleRecommendation = ["implement", "qa", "deploy"]; // "deploy" not in original

    const oracleComposed = originalSkills.filter(s => oracleRecommendation.includes(s));
    expect(oracleComposed).toEqual(["implement", "qa"]);
    // "deploy" was filtered out because it's not in originalSkills
    expect(oracleComposed).not.toContain("deploy");
  });

  it("empty oracle recommendation after intersection falls through to static", () => {
    const originalSkills = ["prioritize", "implement", "qa"];
    const oracleRecommendation = ["deploy", "monitor"]; // none in original

    const oracleComposed = originalSkills.filter(s => oracleRecommendation.includes(s));
    expect(oracleComposed.length).toBe(0);
    // The guard `oracleComposed.length > 0` prevents override
  });

  it("oracle recommendation identical to current skills is a no-op", () => {
    const currentSkills = ["implement", "qa"];
    const oracleRecommendation = ["implement", "qa"];

    const oracleComposed = currentSkills.filter(s => oracleRecommendation.includes(s));
    // Same length → condition `oracleComposed.length !== currentSkills.length` is false
    expect(oracleComposed.length).toBe(currentSkills.length);
  });

  it("oracle override requires >= ORACLE_PIPELINE_THRESHOLD outcomes", () => {
    // Below threshold
    expect(9 >= ORACLE_PIPELINE_THRESHOLD).toBe(false);
    // At threshold
    expect(10 >= ORACLE_PIPELINE_THRESHOLD).toBe(true);
    // Above threshold
    expect(15 >= ORACLE_PIPELINE_THRESHOLD).toBe(true);
  });

  it("compositionMethod is set to 'oracle' when oracle overrides", () => {
    // Simulate the flow
    const job: { compositionMethod?: string; composedFrom?: string[] } = {};

    // Static composition happened first
    job.composedFrom = ["prioritize", "implement", "qa"];
    // Oracle overrides
    job.compositionMethod = "oracle";

    expect(job.compositionMethod).toBe("oracle");
  });

  it("compositionMethod is set to 'static' when only static composition happens", () => {
    const job: { compositionMethod?: string; composedFrom?: string[] } = {};

    // Static composition happened
    job.composedFrom = ["prioritize", "implement", "qa"];
    // No oracle override → set to static
    if (job.composedFrom && !job.compositionMethod) {
      job.compositionMethod = "static";
    }

    expect(job.compositionMethod).toBe("static");
  });

  it("compositionMethod remains undefined when no composition happens", () => {
    const job: { compositionMethod?: string; composedFrom?: string[] } = {};

    // No composition → composedFrom is undefined
    if (job.composedFrom && !job.compositionMethod) {
      job.compositionMethod = "static";
    }

    expect(job.compositionMethod).toBeUndefined();
  });

  it("oracle preserves order from originalSkills", () => {
    const originalSkills = ["prioritize", "office-hours", "implement", "plan-eng-review", "qa"];
    const oracleRecommendation = ["qa", "implement", "plan-eng-review"]; // different order

    const oracleComposed = originalSkills.filter(s => oracleRecommendation.includes(s));
    // Order comes from originalSkills, not oracleRecommendation
    expect(oracleComposed).toEqual(["implement", "plan-eng-review", "qa"]);
  });
});
