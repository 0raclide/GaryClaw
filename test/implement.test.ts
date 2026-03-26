/**
 * Implement skill tests — design doc discovery, implementation order extraction,
 * review context formatting, and prompt building.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  findDesignDoc,
  loadDesignDoc,
  extractImplementationOrder,
  formatReviewContext,
  buildImplementPrompt,
} from "../src/implement.js";
import {
  createMockIssue,
  createMockFinding,
  createMockDecision,
  resetCounters,
} from "./helpers.js";
import type { PipelineSkillEntry, RunReport, GaryClawConfig } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-implement-tmp");
const DESIGNS_DIR = join(TEST_DIR, "docs", "designs");

function createMockRunReport(
  skillName: string,
  overrides: Partial<RunReport> = {},
): RunReport {
  return {
    runId: `run-${skillName}`,
    skillName,
    startTime: "2026-03-25T10:00:00.000Z",
    endTime: "2026-03-25T10:30:00.000Z",
    totalSessions: 1,
    totalTurns: 10,
    estimatedCostUsd: 0.05,
    issues: [],
    findings: [],
    decisions: [],
    relayPoints: [],
    ...overrides,
  };
}

function createMockConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skillName: "implement",
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

describe("findDesignDoc", () => {
  beforeEach(() => {
    mkdirSync(DESIGNS_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns null when docs/designs directory does not exist", () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const result = findDesignDoc(TEST_DIR);
    expect(result).toBeNull();
  });

  it("returns null when docs/designs is empty", () => {
    const result = findDesignDoc(TEST_DIR);
    expect(result).toBeNull();
  });

  it("finds a single design doc", () => {
    writeFileSync(join(DESIGNS_DIR, "feature.md"), "# Feature\nSome design", "utf-8");

    const result = findDesignDoc(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.path).toContain("feature.md");
    expect(result!.content).toBe("# Feature\nSome design");
  });

  it("returns the most recently modified doc when multiple exist", () => {
    const older = join(DESIGNS_DIR, "old-feature.md");
    const newer = join(DESIGNS_DIR, "new-feature.md");

    writeFileSync(older, "# Old Feature", "utf-8");
    writeFileSync(newer, "# New Feature", "utf-8");

    // Set old file to a past time
    const pastDate = new Date("2020-01-01");
    utimesSync(older, pastDate, pastDate);

    const result = findDesignDoc(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.path).toContain("new-feature.md");
    expect(result!.content).toBe("# New Feature");
  });

  it("ignores non-.md files", () => {
    writeFileSync(join(DESIGNS_DIR, "notes.txt"), "not a design doc", "utf-8");
    writeFileSync(join(DESIGNS_DIR, "data.json"), "{}", "utf-8");

    const result = findDesignDoc(TEST_DIR);
    expect(result).toBeNull();
  });
});

describe("extractImplementationOrder", () => {
  it("extracts numbered steps from standard format", () => {
    const doc = `# Design

## Problem
Some problem.

## Implementation Order
1. Create types.ts with all interfaces
2. Build the core module
3. Write tests
4. Integrate into CLI

## Verification
Test it.`;

    const steps = extractImplementationOrder(doc);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toBe("1. Create types.ts with all interfaces");
    expect(steps[1]).toBe("2. Build the core module");
    expect(steps[2]).toBe("3. Write tests");
    expect(steps[3]).toBe("4. Integrate into CLI");
  });

  it("handles lowercase 'order' variant", () => {
    const doc = `## Implementation order
1. Step one
2. Step two`;

    const steps = extractImplementationOrder(doc);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toBe("1. Step one");
  });

  it("returns empty array when section is missing", () => {
    const doc = `# Design

## Problem
Some problem.

## Verification
Test it.`;

    const steps = extractImplementationOrder(doc);
    expect(steps).toHaveLength(0);
  });

  it("returns empty array when section has no numbered items", () => {
    const doc = `## Implementation Order
No numbered items here, just prose.

## Next Section`;

    const steps = extractImplementationOrder(doc);
    expect(steps).toHaveLength(0);
  });

  it("extracts only numbered items, skipping prose", () => {
    const doc = `## Implementation Order
Build in this order:

1. First step
Some additional context about first step.
2. Second step
More context.

Then verify everything works.

## Verification`;

    const steps = extractImplementationOrder(doc);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toBe("1. First step");
    expect(steps[1]).toBe("2. Second step");
  });

  it("handles section at end of document (no following ##)", () => {
    const doc = `# Design

## Implementation Order
1. Only step`;

    const steps = extractImplementationOrder(doc);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toBe("1. Only step");
  });
});

describe("formatReviewContext", () => {
  beforeEach(() => {
    resetCounters();
  });

  it("returns empty string for no previous skills", () => {
    const result = formatReviewContext([]);
    expect(result).toBe("");
  });

  it("returns empty string when skills have no reports", () => {
    const skills: PipelineSkillEntry[] = [
      { skillName: "qa", status: "complete" },
    ];
    const result = formatReviewContext(skills);
    expect(result).toBe("");
  });

  it("returns empty string when reports have no content", () => {
    const skills: PipelineSkillEntry[] = [
      {
        skillName: "qa",
        status: "complete",
        report: createMockRunReport("qa"),
      },
    ];
    const result = formatReviewContext(skills);
    expect(result).toBe("");
  });

  it("formats decisions from one review", () => {
    const skills: PipelineSkillEntry[] = [
      {
        skillName: "plan-ceo-review",
        status: "complete",
        report: createMockRunReport("plan-ceo-review", {
          decisions: [
            createMockDecision({ question: "Use advisory locking?", chosen: "Yes", confidence: 9 }),
          ],
        }),
      },
    ];

    const result = formatReviewContext(skills);
    expect(result).toContain("### /plan-ceo-review");
    expect(result).toContain("**Decisions (1):**");
    expect(result).toContain("Use advisory locking? -> Yes (confidence: 9/10)");
  });

  it("formats decisions and findings from two reviews", () => {
    const skills: PipelineSkillEntry[] = [
      {
        skillName: "plan-ceo-review",
        status: "complete",
        report: createMockRunReport("plan-ceo-review", {
          decisions: [
            createMockDecision({ question: "Expand scope?", chosen: "No" }),
          ],
          findings: [
            createMockFinding({ category: "architecture", description: "Use event sourcing" }),
          ],
        }),
      },
      {
        skillName: "plan-eng-review",
        status: "complete",
        report: createMockRunReport("plan-eng-review", {
          decisions: [
            createMockDecision({ question: "Use Redis?", chosen: "No, in-memory" }),
          ],
          issues: [
            createMockIssue({ id: "ENG-001", status: "open", severity: "high", description: "Missing error handling" }),
          ],
        }),
      },
    ];

    const result = formatReviewContext(skills);
    expect(result).toContain("### /plan-ceo-review");
    expect(result).toContain("### /plan-eng-review");
    expect(result).toContain("Expand scope?");
    expect(result).toContain("Use Redis?");
    expect(result).toContain("[architecture] Use event sourcing");
    expect(result).toContain("ENG-001 [high]: Missing error handling");
  });

  it("shows issue counts with open/fixed breakdown", () => {
    const skills: PipelineSkillEntry[] = [
      {
        skillName: "qa",
        status: "complete",
        report: createMockRunReport("qa", {
          issues: [
            createMockIssue({ status: "fixed" }),
            createMockIssue({ status: "fixed" }),
            createMockIssue({ status: "open" }),
          ],
        }),
      },
    ];

    const result = formatReviewContext(skills);
    expect(result).toContain("3 total (2 fixed, 1 open)");
  });
});

describe("buildImplementPrompt", () => {
  beforeEach(() => {
    resetCounters();
    mkdirSync(DESIGNS_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("builds prompt with design doc and implementation order", async () => {
    writeFileSync(
      join(DESIGNS_DIR, "feature.md"),
      `# Feature Design

## Problem
Need a feature.

## Implementation Order
1. Create types
2. Build module
3. Write tests

## Verification
Run tests.`,
      "utf-8",
    );

    const config = createMockConfig();
    const prompt = await buildImplementPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("implementing a reviewed and approved design");
    expect(prompt).toContain("## Design Document");
    expect(prompt).toContain("# Feature Design");
    expect(prompt).toContain("## Implementation Order");
    expect(prompt).toContain("1. Create types");
    expect(prompt).toContain("2. Build module");
    expect(prompt).toContain("3. Write tests");
    expect(prompt).toContain("## Rules");
  });

  it("includes review context from previous skills", async () => {
    writeFileSync(join(DESIGNS_DIR, "feature.md"), "# Design\n\nSimple design.", "utf-8");

    const config = createMockConfig();
    const prevSkills: PipelineSkillEntry[] = [
      {
        skillName: "plan-eng-review",
        status: "complete",
        report: createMockRunReport("plan-eng-review", {
          decisions: [
            createMockDecision({ question: "Use DI?", chosen: "Yes" }),
          ],
        }),
      },
    ];

    const prompt = await buildImplementPrompt(config, prevSkills, TEST_DIR);

    expect(prompt).toContain("## Review Findings");
    expect(prompt).toContain("### /plan-eng-review");
    expect(prompt).toContain("Use DI?");
  });

  it("handles missing design doc with fallback message", async () => {
    // No design doc exists — designs dir is empty
    const config = createMockConfig();
    const prompt = await buildImplementPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("No design doc found");
    expect(prompt).toContain("## Rules");
  });

  it("includes all rules in the prompt", async () => {
    writeFileSync(join(DESIGNS_DIR, "feature.md"), "# Design", "utf-8");

    const config = createMockConfig();
    const prompt = await buildImplementPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("Follow the implementation order exactly");
    expect(prompt).toContain("Types first");
    expect(prompt).toContain("One commit per step");
    expect(prompt).toContain("Run tests after every commit");
    expect(prompt).toContain("Do not modify code outside");
    expect(prompt).toContain("Use existing patterns");
    expect(prompt).toContain("Test strategy");
  });

  it("builds prompt with no review context when implement is first skill", async () => {
    writeFileSync(join(DESIGNS_DIR, "feature.md"), "# Solo Design", "utf-8");

    const config = createMockConfig();
    const prompt = await buildImplementPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("## Design Document");
    expect(prompt).toContain("# Solo Design");
    expect(prompt).not.toContain("## Review Findings");
    expect(prompt).toContain("## Rules");
  });

  it("skips implementation order section when none found in design doc", async () => {
    writeFileSync(
      join(DESIGNS_DIR, "feature.md"),
      "# Design\n\n## Problem\nJust a problem, no implementation order.",
      "utf-8",
    );

    const config = createMockConfig();
    const prompt = await buildImplementPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("## Design Document");
    expect(prompt).not.toContain("## Implementation Order");
    expect(prompt).toContain("## Rules");
  });

  it("handles full pipeline context with multiple reviews", async () => {
    writeFileSync(
      join(DESIGNS_DIR, "big-feature.md"),
      `# Big Feature

## Implementation Order
1. Types
2. Core
3. Tests`,
      "utf-8",
    );

    const config = createMockConfig();
    const prevSkills: PipelineSkillEntry[] = [
      {
        skillName: "plan-ceo-review",
        status: "complete",
        report: createMockRunReport("plan-ceo-review", {
          decisions: [createMockDecision({ question: "Think bigger?", chosen: "Yes" })],
          findings: [createMockFinding({ description: "Add monitoring" })],
        }),
      },
      {
        skillName: "plan-eng-review",
        status: "complete",
        report: createMockRunReport("plan-eng-review", {
          decisions: [createMockDecision({ question: "Use Redis?", chosen: "No" })],
          issues: [createMockIssue({ id: "ENG-001", status: "open" })],
        }),
      },
    ];

    const prompt = await buildImplementPrompt(config, prevSkills, TEST_DIR);

    expect(prompt).toContain("## Design Document");
    expect(prompt).toContain("# Big Feature");
    expect(prompt).toContain("## Implementation Order");
    expect(prompt).toContain("1. Types");
    expect(prompt).toContain("## Review Findings");
    expect(prompt).toContain("### /plan-ceo-review");
    expect(prompt).toContain("### /plan-eng-review");
    expect(prompt).toContain("Think bigger?");
    expect(prompt).toContain("Use Redis?");
    expect(prompt).toContain("Add monitoring");
    expect(prompt).toContain("ENG-001");
    expect(prompt).toContain("## Rules");
  });

  it("handles design doc with no designs directory at all", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });

    const config = createMockConfig();
    const prompt = await buildImplementPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("No design doc found");
  });

  it("uses config.designDoc when set instead of auto-discovery", async () => {
    // Create a specific design doc at a custom path
    const specificDir = join(TEST_DIR, "custom");
    mkdirSync(specificDir, { recursive: true });
    writeFileSync(
      join(specificDir, "specific.md"),
      "# Specific Design\n\n## Implementation Order\n1. Do the thing",
      "utf-8",
    );

    // Also create a different design doc in the default location
    writeFileSync(
      join(DESIGNS_DIR, "default.md"),
      "# Default Design\nThis should NOT be used",
      "utf-8",
    );

    const config = createMockConfig({ designDoc: "custom/specific.md" });
    const prompt = await buildImplementPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("# Specific Design");
    expect(prompt).not.toContain("Default Design");
    expect(prompt).toContain("1. Do the thing");
  });
});

describe("loadDesignDoc", () => {
  beforeEach(() => {
    mkdirSync(DESIGNS_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("loads file from absolute path", () => {
    const absPath = join(DESIGNS_DIR, "absolute.md");
    writeFileSync(absPath, "# Absolute Path Design", "utf-8");

    const result = loadDesignDoc(absPath, TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(absPath);
    expect(result!.content).toBe("# Absolute Path Design");
  });

  it("loads file from relative path (resolved against projectDir)", () => {
    writeFileSync(
      join(DESIGNS_DIR, "relative.md"),
      "# Relative Path Design",
      "utf-8",
    );

    const result = loadDesignDoc("docs/designs/relative.md", TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(join(TEST_DIR, "docs", "designs", "relative.md"));
    expect(result!.content).toBe("# Relative Path Design");
  });

  it("returns null for nonexistent path", () => {
    const result = loadDesignDoc("docs/designs/nonexistent.md", TEST_DIR);
    expect(result).toBeNull();
  });

  it("returns null for nonexistent absolute path", () => {
    const result = loadDesignDoc("/tmp/definitely-does-not-exist-garyclaw.md", TEST_DIR);
    expect(result).toBeNull();
  });
});
