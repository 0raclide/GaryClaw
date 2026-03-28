/**
 * Evaluate skill tests — bootstrap quality analysis, oracle performance,
 * pipeline health, improvement extraction, Claude output parsing,
 * deduplication, report formatting, and prompt building.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  scoreTokenEfficiency,
  extractDependencies,
  computeFrameworkCoverage,
  detectSections,
  analyzeBootstrapQuality,
  analyzeOraclePerformance,
  analyzePipelineHealth,
  extractObviousImprovements,
  parseClaudeImprovements,
  deduplicateImprovements,
  formatEvaluationReport,
  formatDuration,
  formatImprovementCandidates,
  writeEvaluationReport,
  buildEvaluatePrompt,
  EXPECTED_SECTIONS,
  KNOWN_FRAMEWORKS,
} from "../src/evaluate.js";

import type {
  EvaluationReport,
  BootstrapEvaluation,
  OracleEvaluation,
  PipelineEvaluation,
  ImprovementCandidate,
  GaryClawConfig,
} from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-evaluate-tmp");

function createTestConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skillName: "evaluate",
    projectDir: TEST_DIR,
    maxTurnsPerSegment: 15,
    relayThresholdRatio: 0.85,
    checkpointDir: join(TEST_DIR, ".garyclaw"),
    settingSources: [],
    env: {},
    askTimeoutMs: 30000,
    maxRelaySessions: 10,
    autonomous: true,
    ...overrides,
  };
}

function createMockReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    targetRepo: TEST_DIR,
    timestamp: "2026-03-28T12:00:00.000Z",
    bootstrap: {
      claudeMdExists: true,
      claudeMdSizeTokens: 5000,
      claudeMdHasSections: ["Architecture", "Tech Stack"],
      claudeMdMissingSections: ["Test Strategy", "Usage"],
      todosMdExists: true,
      todosMdItemCount: 5,
      todosMdItemsAboveThreshold: 2,
      qualityScore: 72,
      qualityNotes: ["Missing sections: Test Strategy, Usage"],
    },
    oracle: {
      totalDecisions: 14,
      lowConfidenceCount: 3,
      escalatedCount: 0,
      averageConfidence: 7.2,
      topicClusters: [
        { topic: "TypeScript Strict Mode", count: 2, avgConfidence: 4.5 },
      ],
      researchTriggered: false,
    },
    pipeline: {
      skillsRun: ["bootstrap", "prioritize", "implement", "qa"],
      skillsCompleted: ["bootstrap", "prioritize", "implement", "qa"],
      skillsFailed: [],
      totalRelays: 2,
      totalCostUsd: 0.42,
      totalDurationSec: 754,
      contextGrowthRate: 0.07,
      adaptiveTurnsUsed: true,
    },
    improvements: [],
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── scoreTokenEfficiency ────────────────────────────────────────

describe("scoreTokenEfficiency", () => {
  it("returns 10 for tokens in 2K-10K range", () => {
    expect(scoreTokenEfficiency(2000)).toBe(10);
    expect(scoreTokenEfficiency(5000)).toBe(10);
    expect(scoreTokenEfficiency(10000)).toBe(10);
  });

  it("returns 5 for tokens in 1K-2K or 10K-20K range", () => {
    expect(scoreTokenEfficiency(1000)).toBe(5);
    expect(scoreTokenEfficiency(1500)).toBe(5);
    expect(scoreTokenEfficiency(15000)).toBe(5);
    expect(scoreTokenEfficiency(20000)).toBe(5);
  });

  it("returns 0 for tokens outside acceptable range", () => {
    expect(scoreTokenEfficiency(500)).toBe(0);
    expect(scoreTokenEfficiency(0)).toBe(0);
    expect(scoreTokenEfficiency(25000)).toBe(0);
  });
});

// ── extractDependencies ──────────────────────────────────────────

describe("extractDependencies", () => {
  it("extracts from dependencies and devDependencies", () => {
    const pkg = JSON.stringify({
      dependencies: { react: "^18", "react-dom": "^18" },
      devDependencies: { vitest: "^1" },
    });
    const deps = extractDependencies(pkg);
    expect(deps).toContain("react");
    expect(deps).toContain("react-dom");
    expect(deps).toContain("vitest");
  });

  it("handles peerDependencies and optionalDependencies", () => {
    const pkg = JSON.stringify({
      peerDependencies: { react: "^18" },
      optionalDependencies: { fsevents: "^2" },
    });
    const deps = extractDependencies(pkg);
    expect(deps).toContain("react");
    expect(deps).toContain("fsevents");
  });

  it("returns empty array for invalid JSON", () => {
    expect(extractDependencies("not json")).toEqual([]);
  });

  it("returns empty array for empty package.json", () => {
    expect(extractDependencies("{}")).toEqual([]);
  });

  it("lowercases all dependency names", () => {
    const pkg = JSON.stringify({ dependencies: { "React-DOM": "^18" } });
    const deps = extractDependencies(pkg);
    expect(deps).toContain("react-dom");
  });
});

// ── computeFrameworkCoverage ─────────────────────────────────────

describe("computeFrameworkCoverage", () => {
  it("computes full coverage when all frameworks mentioned", () => {
    const deps = ["react", "vitest"];
    const content = "We use React and Vitest for testing.";
    const result = computeFrameworkCoverage(deps, content);
    expect(result.mentioned).toBe(2);
    expect(result.total).toBe(2);
    expect(result.coverage).toBe(1);
  });

  it("computes partial coverage", () => {
    const deps = ["react", "vitest", "express"];
    const content = "We use React for the frontend.";
    const result = computeFrameworkCoverage(deps, content);
    expect(result.mentioned).toBe(1);
    expect(result.total).toBe(3);
    expect(result.coverage).toBeCloseTo(1 / 3, 2);
  });

  it("returns coverage 1 when no known frameworks in deps", () => {
    const deps = ["some-unknown-package"];
    const content = "No frameworks here.";
    const result = computeFrameworkCoverage(deps, content);
    expect(result.total).toBe(0);
    expect(result.coverage).toBe(1);
  });

  it("handles case-insensitive matching", () => {
    const deps = ["react"];
    const content = "REACT is great.";
    const result = computeFrameworkCoverage(deps, content);
    expect(result.mentioned).toBe(1);
  });
});

// ── detectSections ───────────────────────────────────────────────

describe("detectSections", () => {
  it("finds sections in markdown headings", () => {
    const content = "## Architecture\nSome text\n## Tech Stack\nMore text";
    const result = detectSections(content);
    expect(result.found).toContain("Architecture");
    expect(result.found).toContain("Tech Stack");
    expect(result.missing).toContain("Test Strategy");
    expect(result.missing).toContain("Usage");
  });

  it("finds sections with ### headings", () => {
    const content = "### Test Strategy\nTests here";
    const result = detectSections(content);
    expect(result.found).toContain("Test Strategy");
  });

  it("handles case-insensitive matching", () => {
    const content = "## architecture\nDetails here";
    const result = detectSections(content);
    expect(result.found).toContain("Architecture");
  });

  it("returns all missing for empty content", () => {
    const result = detectSections("");
    expect(result.found).toEqual([]);
    expect(result.missing).toEqual(EXPECTED_SECTIONS);
  });

  it("uses custom expected sections", () => {
    const content = "## Custom Section\nContent";
    const result = detectSections(content, ["Custom Section", "Missing One"]);
    expect(result.found).toEqual(["Custom Section"]);
    expect(result.missing).toEqual(["Missing One"]);
  });
});

// ── analyzeBootstrapQuality ──────────────────────────────────────

describe("analyzeBootstrapQuality", () => {
  it("returns defaults when CLAUDE.md is missing", () => {
    const result = analyzeBootstrapQuality(TEST_DIR);
    expect(result.claudeMdExists).toBe(false);
    expect(result.qualityScore).toBe(0);
    expect(result.qualityNotes).toContain("No artifacts found — CLAUDE.md missing");
  });

  it("scores a complete CLAUDE.md highly", () => {
    const content = [
      "# My Project",
      "## Architecture",
      "Microservices architecture",
      "## Tech Stack",
      "React, Express, Vitest",
      "## Test Strategy",
      "Unit tests with Vitest",
      "## Usage",
      "npm start",
    ].join("\n");
    // Make it 2K-10K tokens range (pad content)
    const padded = content + "\n" + "x".repeat(7000);
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), padded);
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ dependencies: { react: "^18", express: "^4", vitest: "^1" } }),
    );

    const result = analyzeBootstrapQuality(TEST_DIR);
    expect(result.claudeMdExists).toBe(true);
    expect(result.claudeMdHasSections).toEqual(EXPECTED_SECTIONS);
    expect(result.claudeMdMissingSections).toEqual([]);
    expect(result.qualityScore).toBeGreaterThan(70);
  });

  it("detects missing sections", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "## Architecture\nSome content here");

    const result = analyzeBootstrapQuality(TEST_DIR);
    expect(result.claudeMdHasSections).toContain("Architecture");
    expect(result.claudeMdMissingSections).toContain("Tech Stack");
    expect(result.claudeMdMissingSections).toContain("Test Strategy");
    expect(result.claudeMdMissingSections).toContain("Usage");
  });

  it("detects TODOS.md existence and item count", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project");
    writeFileSync(
      join(TEST_DIR, "TODOS.md"),
      "## P1: Fix auth\n\n## P2: Add tests\n\n## P3: Refactor utils\n",
    );

    const result = analyzeBootstrapQuality(TEST_DIR);
    expect(result.todosMdExists).toBe(true);
    expect(result.todosMdItemCount).toBe(3);
  });

  it("notes when TODOS.md is missing", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project");

    const result = analyzeBootstrapQuality(TEST_DIR);
    expect(result.todosMdExists).toBe(false);
    expect(result.qualityNotes).toContain("No artifacts found — TODOS.md missing");
  });

  it("computes framework coverage from package.json", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "## Tech Stack\nWe use React.\n## Architecture\nSPA");
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ dependencies: { react: "^18", express: "^4" } }),
    );

    const result = analyzeBootstrapQuality(TEST_DIR);
    // React mentioned but Express not → partial coverage
    expect(result.qualityNotes.some((n) => n.includes("Tech stack coverage"))).toBe(true);
  });

  it("handles no package.json gracefully", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\n## Architecture\nSimple");

    const result = analyzeBootstrapQuality(TEST_DIR);
    expect(result.claudeMdExists).toBe(true);
    // No package.json = coverageRatio defaults to 1 (full coverage)
    expect(result.qualityScore).toBeGreaterThan(0);
  });
});

// ── analyzeOraclePerformance ─────────────────────────────────────

describe("analyzeOraclePerformance", () => {
  it("returns defaults when no decisions file exists", () => {
    const result = analyzeOraclePerformance(TEST_DIR);
    expect(result.totalDecisions).toBe(0);
    expect(result.averageConfidence).toBe(0);
  });

  it("parses decisions from JSONL file", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });

    const decisions = [
      { question: "Fix the auth bug?", confidence: 9, options: [], chosen: "Yes", principle: "P1", rationale: "Clear fix", timestamp: "2026-03-28", sessionIndex: 0 },
      { question: "Use React or Vue?", confidence: 5, options: [], chosen: "React", principle: "P2", rationale: "More common", timestamp: "2026-03-28", sessionIndex: 0 },
      { question: "Add TypeScript strict?", confidence: 4, options: [], chosen: "Yes", principle: "P4", rationale: "Better safety", timestamp: "2026-03-28", sessionIndex: 0 },
    ];
    writeFileSync(
      join(gcDir, "decisions.jsonl"),
      decisions.map((d) => JSON.stringify(d)).join("\n"),
    );

    const result = analyzeOraclePerformance(TEST_DIR);
    expect(result.totalDecisions).toBe(3);
    expect(result.lowConfidenceCount).toBe(2); // confidence < 6
    expect(result.averageConfidence).toBeCloseTo(6, 0);
  });

  it("counts escalated decisions", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });

    writeFileSync(
      join(gcDir, "decisions.jsonl"),
      JSON.stringify({ question: "Test?", confidence: 8, options: [], chosen: "Yes", principle: "P1", rationale: "OK", timestamp: "2026-03-28", sessionIndex: 0 }),
    );
    writeFileSync(
      join(gcDir, "escalated.jsonl"),
      JSON.stringify({ question: "Delete prod DB?", escalateReason: "Destructive" }) + "\n" +
      JSON.stringify({ question: "Override security?", escalateReason: "Security" }),
    );

    const result = analyzeOraclePerformance(TEST_DIR);
    expect(result.escalatedCount).toBe(2);
  });

  it("skips corrupt JSONL lines", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });

    writeFileSync(
      join(gcDir, "decisions.jsonl"),
      JSON.stringify({ question: "Fix?", confidence: 8, options: [], chosen: "Yes", principle: "P1", rationale: "OK", timestamp: "2026-03-28", sessionIndex: 0 }) +
      "\n{corrupt\n" +
      JSON.stringify({ question: "Add?", confidence: 7, options: [], chosen: "Yes", principle: "P2", rationale: "OK", timestamp: "2026-03-28", sessionIndex: 0 }),
    );

    const result = analyzeOraclePerformance(TEST_DIR);
    expect(result.totalDecisions).toBe(2);
  });
});

// ── analyzePipelineHealth ────────────────────────────────────────

describe("analyzePipelineHealth", () => {
  it("returns defaults when no pipeline.json exists", () => {
    const result = analyzePipelineHealth(TEST_DIR);
    expect(result.skillsRun).toEqual([]);
    expect(result.totalRelays).toBe(0);
  });

  it("parses pipeline state", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });

    const state = {
      version: 1,
      pipelineId: "test-pipeline",
      skills: [
        { skillName: "bootstrap", status: "complete", startTime: "2026-03-28T10:00:00Z", endTime: "2026-03-28T10:05:00Z" },
        { skillName: "qa", status: "failed", startTime: "2026-03-28T10:05:00Z", endTime: "2026-03-28T10:10:00Z" },
      ],
      currentSkillIndex: 1,
      startTime: "2026-03-28T10:00:00Z",
      totalCostUsd: 0.35,
      autonomous: true,
    };
    writeFileSync(join(gcDir, "pipeline.json"), JSON.stringify(state));

    const result = analyzePipelineHealth(TEST_DIR);
    expect(result.skillsRun).toEqual(["bootstrap", "qa"]);
    expect(result.skillsCompleted).toEqual(["bootstrap"]);
    expect(result.skillsFailed).toEqual(["qa"]);
    expect(result.totalCostUsd).toBe(0.35);
    expect(result.totalDurationSec).toBe(600); // 10 minutes
  });

  it("counts relays from checkpoint session count", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });

    const state = {
      version: 1,
      pipelineId: "test",
      skills: [{ skillName: "qa", status: "complete", startTime: "2026-03-28T10:00:00Z", endTime: "2026-03-28T10:05:00Z" }],
      currentSkillIndex: 0,
      startTime: "2026-03-28T10:00:00Z",
      totalCostUsd: 0.1,
      autonomous: true,
    };
    writeFileSync(join(gcDir, "pipeline.json"), JSON.stringify(state));

    // Create checkpoint with 3 sessions (2 relays)
    const skillDir = join(gcDir, "skill-0-qa");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "checkpoint.json"),
      JSON.stringify({
        tokenUsage: {
          sessionCount: 3,
          turnHistory: [
            { turn: 1, computedContextSize: 10000 },
            { turn: 2, computedContextSize: 20000 },
            { turn: 3, computedContextSize: 30000 },
          ],
        },
      }),
    );

    const result = analyzePipelineHealth(TEST_DIR);
    expect(result.totalRelays).toBe(2);
    expect(result.contextGrowthRate).toBeGreaterThan(0);
  });
});

// ── extractObviousImprovements ───────────────────────────────────

describe("extractObviousImprovements", () => {
  it("flags missing bootstrap sections as P2", () => {
    const report = createMockReport();
    const improvements = extractObviousImprovements(report);
    const sectionImprovement = improvements.find((i) => i.category === "bootstrap" && i.title.includes("missing"));
    expect(sectionImprovement).toBeDefined();
    expect(sectionImprovement!.priority).toBe("P2");
  });

  it("flags low-confidence Oracle clusters with 3+ decisions", () => {
    const report = createMockReport({
      oracle: {
        totalDecisions: 10,
        lowConfidenceCount: 5,
        escalatedCount: 0,
        averageConfidence: 5.5,
        topicClusters: [
          { topic: "TypeScript Config", count: 4, avgConfidence: 4.0 },
        ],
        researchTriggered: false,
      },
    });
    const improvements = extractObviousImprovements(report);
    const oracleImprovement = improvements.find((i) => i.category === "oracle");
    expect(oracleImprovement).toBeDefined();
    expect(oracleImprovement!.priority).toBe("P3");
  });

  it("does not flag Oracle clusters with fewer than 3 decisions", () => {
    const report = createMockReport({
      oracle: {
        totalDecisions: 5,
        lowConfidenceCount: 2,
        escalatedCount: 0,
        averageConfidence: 5.5,
        topicClusters: [
          { topic: "Testing", count: 2, avgConfidence: 4.0 },
        ],
        researchTriggered: false,
      },
    });
    const improvements = extractObviousImprovements(report);
    expect(improvements.find((i) => i.category === "oracle")).toBeUndefined();
  });

  it("flags excessive relays (>3)", () => {
    const report = createMockReport({
      pipeline: {
        skillsRun: ["qa"],
        skillsCompleted: ["qa"],
        skillsFailed: [],
        totalRelays: 5,
        totalCostUsd: 1.0,
        totalDurationSec: 300,
        contextGrowthRate: 0.1,
        adaptiveTurnsUsed: true,
      },
    });
    const improvements = extractObviousImprovements(report);
    expect(improvements.find((i) => i.category === "relay")).toBeDefined();
  });

  it("flags pipeline skill failures as P2", () => {
    const report = createMockReport({
      pipeline: {
        skillsRun: ["bootstrap", "qa"],
        skillsCompleted: ["bootstrap"],
        skillsFailed: ["qa"],
        totalRelays: 0,
        totalCostUsd: 0.1,
        totalDurationSec: 300,
        contextGrowthRate: 0,
        adaptiveTurnsUsed: false,
      },
    });
    const improvements = extractObviousImprovements(report);
    const failImprovement = improvements.find((i) => i.title.includes("failures"));
    expect(failImprovement).toBeDefined();
    expect(failImprovement!.priority).toBe("P2");
  });

  it("flags low bootstrap quality (<50)", () => {
    const report = createMockReport({
      bootstrap: {
        claudeMdExists: true,
        claudeMdSizeTokens: 200,
        claudeMdHasSections: [],
        claudeMdMissingSections: EXPECTED_SECTIONS,
        todosMdExists: false,
        todosMdItemCount: 0,
        todosMdItemsAboveThreshold: 0,
        qualityScore: 30,
        qualityNotes: ["Very incomplete"],
      },
    });
    const improvements = extractObviousImprovements(report);
    const qualityImprovement = improvements.find((i) => i.title.includes("quality below threshold"));
    expect(qualityImprovement).toBeDefined();
    expect(qualityImprovement!.priority).toBe("P2");
  });

  it("returns empty when everything is healthy", () => {
    const report = createMockReport({
      bootstrap: {
        claudeMdExists: true,
        claudeMdSizeTokens: 5000,
        claudeMdHasSections: EXPECTED_SECTIONS,
        claudeMdMissingSections: [],
        todosMdExists: true,
        todosMdItemCount: 5,
        todosMdItemsAboveThreshold: 3,
        qualityScore: 90,
        qualityNotes: [],
      },
      oracle: {
        totalDecisions: 10,
        lowConfidenceCount: 0,
        escalatedCount: 0,
        averageConfidence: 9.0,
        topicClusters: [],
        researchTriggered: false,
      },
      pipeline: {
        skillsRun: ["qa"],
        skillsCompleted: ["qa"],
        skillsFailed: [],
        totalRelays: 1,
        totalCostUsd: 0.2,
        totalDurationSec: 120,
        contextGrowthRate: 0.05,
        adaptiveTurnsUsed: true,
      },
    });
    const improvements = extractObviousImprovements(report);
    expect(improvements).toEqual([]);
  });
});

// ── parseClaudeImprovements ──────────────────────────────────────

describe("parseClaudeImprovements", () => {
  it("parses valid improvements from <improvements> block", () => {
    const output = `Here are my findings:
<improvements>
[
  { "title": "Fix bootstrap", "priority": "P2", "effort": "S", "category": "bootstrap", "description": "Needs work", "evidence": "Score 30/100" }
]
</improvements>
Done.`;
    const result = parseClaudeImprovements(output);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Fix bootstrap");
    expect(result[0].priority).toBe("P2");
  });

  it("returns empty array when no <improvements> block", () => {
    expect(parseClaudeImprovements("No improvements here")).toEqual([]);
  });

  it("returns empty array for invalid JSON in block", () => {
    const output = "<improvements>not json</improvements>";
    expect(parseClaudeImprovements(output)).toEqual([]);
  });

  it("drops entries with invalid priority", () => {
    const output = `<improvements>[
      { "title": "Fix", "priority": "P1", "effort": "S", "category": "bootstrap", "description": "X", "evidence": "Y" }
    ]</improvements>`;
    expect(parseClaudeImprovements(output)).toEqual([]);
  });

  it("drops entries with invalid effort", () => {
    const output = `<improvements>[
      { "title": "Fix", "priority": "P2", "effort": "L", "category": "bootstrap", "description": "X", "evidence": "Y" }
    ]</improvements>`;
    expect(parseClaudeImprovements(output)).toEqual([]);
  });

  it("drops entries with invalid category", () => {
    const output = `<improvements>[
      { "title": "Fix", "priority": "P2", "effort": "S", "category": "unknown", "description": "X", "evidence": "Y" }
    ]</improvements>`;
    expect(parseClaudeImprovements(output)).toEqual([]);
  });

  it("drops entries missing required fields", () => {
    const output = `<improvements>[
      { "title": "Fix", "priority": "P2" }
    ]</improvements>`;
    expect(parseClaudeImprovements(output)).toEqual([]);
  });

  it("keeps valid entries and drops invalid ones in same array", () => {
    const output = `<improvements>[
      { "title": "Valid", "priority": "P3", "effort": "XS", "category": "oracle", "description": "Good", "evidence": "Data" },
      { "title": "Invalid", "priority": "P1", "effort": "S", "category": "bootstrap", "description": "Bad", "evidence": "None" }
    ]</improvements>`;
    const result = parseClaudeImprovements(output);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Valid");
  });

  it("returns empty for non-array JSON", () => {
    const output = '<improvements>{"title": "not an array"}</improvements>';
    expect(parseClaudeImprovements(output)).toEqual([]);
  });
});

// ── deduplicateImprovements ──────────────────────────────────────

describe("deduplicateImprovements", () => {
  it("keeps unique improvements from both sources", () => {
    const obvious: ImprovementCandidate[] = [
      { title: "Fix bootstrap sections", priority: "P2", effort: "XS", category: "bootstrap", description: "Missing", evidence: "Short" },
    ];
    const claude: ImprovementCandidate[] = [
      { title: "Improve oracle confidence", priority: "P3", effort: "S", category: "oracle", description: "Low conf", evidence: "Data" },
    ];
    const result = deduplicateImprovements(obvious, claude);
    expect(result).toHaveLength(2);
  });

  it("deduplicates similar titles (Levenshtein < 0.3)", () => {
    const obvious: ImprovementCandidate[] = [
      { title: "Fix bootstrap sections", priority: "P2", effort: "XS", category: "bootstrap", description: "Missing", evidence: "Short" },
    ];
    const claude: ImprovementCandidate[] = [
      { title: "Fix bootstrap section", priority: "P2", effort: "S", category: "bootstrap", description: "Missing sections", evidence: "More detailed evidence here" },
    ];
    const result = deduplicateImprovements(obvious, claude);
    expect(result).toHaveLength(1);
    // Should keep the one with longer evidence
    expect(result[0].evidence).toBe("More detailed evidence here");
  });

  it("keeps both when titles are different enough", () => {
    const obvious: ImprovementCandidate[] = [
      { title: "Bootstrap missing test strategy", priority: "P2", effort: "XS", category: "bootstrap", description: "A", evidence: "B" },
    ];
    const claude: ImprovementCandidate[] = [
      { title: "Oracle domain gap TypeScript", priority: "P3", effort: "S", category: "oracle", description: "C", evidence: "D" },
    ];
    const result = deduplicateImprovements(obvious, claude);
    expect(result).toHaveLength(2);
  });
});

// ── formatDuration ───────────────────────────────────────────────

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(125)).toBe("2m 5s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3725)).toBe("1h 2m");
  });

  it("handles zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });
});

// ── formatImprovementCandidates ──────────────────────────────────

describe("formatImprovementCandidates", () => {
  it("formats as TODOS.md entries matching parseTodoItems contract", () => {
    const candidates: ImprovementCandidate[] = [
      {
        title: "Fix bootstrap sections",
        priority: "P2",
        effort: "XS",
        category: "bootstrap",
        description: "Bootstrap misses test strategy",
        evidence: "CLAUDE.md had no Test Strategy section",
      },
    ];
    const result = formatImprovementCandidates(candidates, "2026-03-28");
    expect(result).toContain("## P2: Fix bootstrap sections");
    expect(result).toContain("**What:** Bootstrap misses test strategy");
    expect(result).toContain("**Why:** CLAUDE.md had no Test Strategy section");
    expect(result).toContain("**Effort:** XS");
    expect(result).toContain("**Depends on:** Nothing");
    expect(result).toContain("**Added by:** evaluate skill on 2026-03-28");
  });

  it("formats multiple candidates separated by blank lines", () => {
    const candidates: ImprovementCandidate[] = [
      { title: "First", priority: "P2", effort: "S", category: "bootstrap", description: "A", evidence: "B" },
      { title: "Second", priority: "P3", effort: "M", category: "oracle", description: "C", evidence: "D" },
    ];
    const result = formatImprovementCandidates(candidates);
    expect(result).toContain("## P2: First");
    expect(result).toContain("## P3: Second");
  });

  it("includes separate human and CC effort estimates", () => {
    const candidates: ImprovementCandidate[] = [
      { title: "XS task", priority: "P4", effort: "XS", category: "skill", description: "A", evidence: "B" },
    ];
    const result = formatImprovementCandidates(candidates);
    expect(result).toContain("human: ~30min");
    expect(result).toContain("CC: ~5min");
  });

  it("shows compression ratio across all effort levels", () => {
    const xs: ImprovementCandidate[] = [{ title: "T", priority: "P4", effort: "XS", category: "skill", description: "A", evidence: "B" }];
    const s: ImprovementCandidate[] = [{ title: "T", priority: "P3", effort: "S", category: "skill", description: "A", evidence: "B" }];
    const m: ImprovementCandidate[] = [{ title: "T", priority: "P2", effort: "M", category: "skill", description: "A", evidence: "B" }];

    expect(formatImprovementCandidates(xs)).toContain("human: ~30min / CC: ~5min");
    expect(formatImprovementCandidates(s)).toContain("human: ~2 days / CC: ~20min");
    expect(formatImprovementCandidates(m)).toContain("human: ~1 week / CC: ~1h");
  });
});

// ── formatEvaluationReport ───────────────────────────────────────

describe("formatEvaluationReport", () => {
  it("produces markdown with all sections", () => {
    const report = createMockReport({
      improvements: [
        { title: "Fix something", priority: "P2", effort: "S", category: "bootstrap", description: "Desc", evidence: "Ev" },
      ],
    });
    const md = formatEvaluationReport(report);
    expect(md).toContain("# Dogfood Evaluation Report");
    expect(md).toContain("## Bootstrap Quality: 72/100");
    expect(md).toContain("## Oracle Performance");
    expect(md).toContain("## Pipeline Health");
    expect(md).toContain("## GaryClaw Improvement Candidates");
    expect(md).toContain("### P2: Fix something");
    expect(md).toContain("*Generated by GaryClaw Evaluate Skill*");
  });

  it("includes pipeline skills as arrow-separated list", () => {
    const report = createMockReport();
    const md = formatEvaluationReport(report);
    expect(md).toContain("bootstrap → prioritize → implement → qa");
  });

  it("omits improvement section when empty", () => {
    const report = createMockReport({ improvements: [] });
    const md = formatEvaluationReport(report);
    expect(md).not.toContain("## GaryClaw Improvement Candidates");
  });
});

// ── writeEvaluationReport ────────────────────────────────────────

describe("writeEvaluationReport", () => {
  it("writes JSON and markdown report files", () => {
    const report = createMockReport();
    writeEvaluationReport(TEST_DIR, report);

    expect(existsSync(join(TEST_DIR, ".garyclaw", "evaluation-report.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, ".garyclaw", "evaluation-report.md"))).toBe(true);
  });

  it("writes improvement-candidates.md when improvements exist", () => {
    const report = createMockReport({
      improvements: [
        { title: "Fix X", priority: "P2", effort: "S", category: "bootstrap", description: "D", evidence: "E" },
      ],
    });
    writeEvaluationReport(TEST_DIR, report);

    expect(existsSync(join(TEST_DIR, ".garyclaw", "improvement-candidates.md"))).toBe(true);
    const content = readFileSync(join(TEST_DIR, ".garyclaw", "improvement-candidates.md"), "utf-8");
    expect(content).toContain("## P2: Fix X");
  });

  it("does not write improvement-candidates.md when no improvements", () => {
    const report = createMockReport({ improvements: [] });
    writeEvaluationReport(TEST_DIR, report);

    expect(existsSync(join(TEST_DIR, ".garyclaw", "improvement-candidates.md"))).toBe(false);
  });

  it("creates .garyclaw directory if it does not exist", () => {
    const report = createMockReport();
    writeEvaluationReport(TEST_DIR, report);
    expect(existsSync(join(TEST_DIR, ".garyclaw"))).toBe(true);
  });
});

// ── buildEvaluatePrompt ──────────────────────────────────────────

describe("buildEvaluatePrompt", () => {
  it("includes evaluation data sections", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\n## Architecture\nStuff");
    mkdirSync(join(TEST_DIR, ".garyclaw"), { recursive: true });

    const config = createTestConfig();
    const prompt = buildEvaluatePrompt(config, [], TEST_DIR);

    expect(prompt).toContain("GaryClaw self-improvement analyst");
    expect(prompt).toContain("### Bootstrap Quality");
    expect(prompt).toContain("### Oracle Performance");
    expect(prompt).toContain("### Pipeline Health");
    expect(prompt).toContain("<improvements>");
  });

  it("includes previous skills context when provided", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project");

    const config = createTestConfig();
    const prevSkills = [
      {
        skillName: "qa",
        status: "complete" as const,
        report: {
          runId: "r1",
          skillName: "qa",
          startTime: "",
          endTime: "",
          totalSessions: 1,
          totalTurns: 5,
          estimatedCostUsd: 0.1,
          issues: [{ id: "QA-001", severity: "medium" as const, description: "Bug", status: "fixed" as const }],
          findings: [],
          decisions: [],
          relayPoints: [],
        },
      },
    ];
    const prompt = buildEvaluatePrompt(config, prevSkills, TEST_DIR);

    expect(prompt).toContain("### Previous Skills Context");
    expect(prompt).toContain("/qa");
  });

  it("includes already-identified improvements when found", () => {
    // Create CLAUDE.md with missing sections to trigger obvious improvements
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\nMinimal content");

    const config = createTestConfig();
    const prompt = buildEvaluatePrompt(config, [], TEST_DIR);

    expect(prompt).toContain("### Already Identified Improvements");
  });

  it("includes valid priorities and categories in instructions", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project");

    const config = createTestConfig();
    const prompt = buildEvaluatePrompt(config, [], TEST_DIR);

    expect(prompt).toContain("Valid priorities: P2, P3, P4");
    expect(prompt).toContain("Valid efforts: XS, S, M");
    expect(prompt).toContain("Valid categories: bootstrap, oracle, pipeline, skill, relay");
  });
});

// ── KNOWN_FRAMEWORKS constant ────────────────────────────────────

describe("KNOWN_FRAMEWORKS", () => {
  it("has at least 30 entries", () => {
    expect(KNOWN_FRAMEWORKS.size).toBeGreaterThanOrEqual(30);
  });

  it("maps framework names to package arrays", () => {
    const react = KNOWN_FRAMEWORKS.get("React");
    expect(react).toBeDefined();
    expect(react).toContain("react");
    expect(react).toContain("react-dom");
  });
});

// ── EXPECTED_SECTIONS constant ───────────────────────────────────

describe("EXPECTED_SECTIONS", () => {
  it("contains the four expected sections", () => {
    expect(EXPECTED_SECTIONS).toEqual(["Architecture", "Tech Stack", "Test Strategy", "Usage"]);
  });
});
