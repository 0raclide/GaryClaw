/**
 * Prioritize skill tests — parsing, context loading, prompt building.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTodoItems,
  loadOvernightGoal,
  loadOracleContext,
  formatPipelineContext,
  formatMetricsSummary,
  buildPrioritizePrompt,
} from "../src/prioritize.js";
import {
  createMockIssue,
  createMockFinding,
  createMockDecision,
  resetCounters,
} from "./helpers.js";
import type {
  PipelineSkillEntry,
  RunReport,
  GaryClawConfig,
  OracleMetrics,
} from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-prioritize-tmp");

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
    skillName: "prioritize",
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

const SAMPLE_TODOS = `# TODOS

## P2: Daemon Hardening (Phase 4b) — PARTIALLY FIXED

**What:** Remaining hardening for the daemon.

**Why:** Production-readiness for long-running daemon instances.

**Effort:** XS (human: ~1 day / CC: ~15 min)
**Depends on:** Phase 4a (complete)
**Added by:** /plan-eng-review on 2026-03-26

## P3: Codebase Summary Persistence Across Relays

**What:** Generate a structured "codebase summary" during each session.

**Why:** When GaryClaw relays to a fresh session, reasoning is lost.

**Effort:** S (human: ~3 days / CC: ~30 min)
**Depends on:** Phase 1a (relay working), Phase 2 (if bundled with oracle context)
**Added by:** /plan-eng-review on 2026-03-25

## P3: Adaptive maxTurns Strategy

**What:** Dynamic segment sizing.

**Why:** Fixed maxTurns is a blunt instrument.

**Context:** Identified during eng review performance section.

**Effort:** XS (human: ~1 day / CC: ~15 min)
**Depends on:** Phase 1a (token monitor working)
**Added by:** /plan-eng-review on 2026-03-25

## P4: Daemon Shutdown AbortSignal Improvement

**What:** Improve daemon shutdown.

**Effort:** XS (human: ~1 day / CC: ~15 min)
**Depends on:** Phase 4a (complete)
**Added by:** /qa Run 6 on 2026-03-26
`;

beforeEach(() => {
  resetCounters();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── parseTodoItems ───────────────────────────────────────────────

describe("parseTodoItems", () => {
  it("parses structured TODOS.md into items", () => {
    const items = parseTodoItems(SAMPLE_TODOS);
    expect(items).toHaveLength(4);
  });

  it("extracts priority levels correctly", () => {
    const items = parseTodoItems(SAMPLE_TODOS);
    expect(items[0].priority).toBe(2);
    expect(items[1].priority).toBe(3);
    expect(items[2].priority).toBe(3);
    expect(items[3].priority).toBe(4);
  });

  it("extracts titles", () => {
    const items = parseTodoItems(SAMPLE_TODOS);
    expect(items[0].title).toBe("Daemon Hardening (Phase 4b)");
    expect(items[1].title).toBe("Codebase Summary Persistence Across Relays");
  });

  it("extracts effort levels", () => {
    const items = parseTodoItems(SAMPLE_TODOS);
    expect(items[0].effort).toBe("XS");
    expect(items[1].effort).toBe("S");
    expect(items[2].effort).toBe("XS");
  });

  it("extracts dependencies", () => {
    const items = parseTodoItems(SAMPLE_TODOS);
    expect(items[0].dependencies).toEqual(["Phase 4a (complete)"]);
    expect(items[1].dependencies).toEqual([
      "Phase 1a (relay working)",
      "Phase 2 (if bundled with oracle context)",
    ]);
  });

  it("extracts status from heading", () => {
    const items = parseTodoItems(SAMPLE_TODOS);
    expect(items[0].status).toBe("PARTIALLY FIXED");
    expect(items[1].status).toBeNull();
  });

  it("extracts context field", () => {
    const items = parseTodoItems(SAMPLE_TODOS);
    expect(items[2].context).toContain("eng review performance");
    expect(items[0].context).toBeNull();
  });

  it("includes full description block", () => {
    const items = parseTodoItems(SAMPLE_TODOS);
    expect(items[0].description).toContain("Remaining hardening");
    expect(items[0].description).toContain("Production-readiness");
  });

  it("returns empty array for empty input", () => {
    expect(parseTodoItems("")).toEqual([]);
  });

  it("returns empty array for content with no P-items", () => {
    expect(parseTodoItems("# TODOS\n\nNo items yet.")).toEqual([]);
  });

  it("handles malformed headings gracefully", () => {
    const content = "## Not a P-item\n\nSome text\n\n## P2: Valid Item\n\n**Effort:** M\n";
    const items = parseTodoItems(content);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Valid Item");
    expect(items[0].effort).toBe("M");
  });

  it("handles items with no effort field", () => {
    const content = "## P1: Urgent Fix\n\n**What:** Fix the thing.\n";
    const items = parseTodoItems(content);
    expect(items).toHaveLength(1);
    expect(items[0].effort).toBeNull();
    expect(items[0].dependencies).toEqual([]);
  });
});

// ── loadOvernightGoal ────────────────────────────────────────────

describe("loadOvernightGoal", () => {
  it("reads file when it exists", () => {
    writeFileSync(join(TEST_DIR, "overnight-goal.md"), "Ship P2 items\n", "utf-8");
    const goal = loadOvernightGoal(TEST_DIR);
    expect(goal).toBe("Ship P2 items\n");
  });

  it("returns null when file is missing", () => {
    const goal = loadOvernightGoal(TEST_DIR);
    expect(goal).toBeNull();
  });

  it("returns empty string for empty file", () => {
    writeFileSync(join(TEST_DIR, "overnight-goal.md"), "", "utf-8");
    const goal = loadOvernightGoal(TEST_DIR);
    expect(goal).toBe("");
  });
});

// ── loadOracleContext ────────────────────────────────────────────

describe("loadOracleContext", () => {
  it("returns null when no oracle data exists", () => {
    const ctx = loadOracleContext(TEST_DIR);
    expect(ctx).toBeNull();
  });

  it("includes metrics when they exist", () => {
    const metricsDir = join(TEST_DIR, ".garyclaw", "oracle-memory");
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(
      join(metricsDir, "metrics.json"),
      JSON.stringify({
        totalDecisions: 25,
        accurateDecisions: 20,
        neutralDecisions: 3,
        failedDecisions: 2,
        accuracyPercent: 90.9,
        confidenceTrend: [8, 7, 9],
        lastReflectionTimestamp: null,
        circuitBreakerTripped: false,
      }),
      "utf-8",
    );

    const ctx = loadOracleContext(TEST_DIR);
    expect(ctx).toContain("Total decisions: 25");
    expect(ctx).toContain("91%");
  });

  it("includes circuit breaker warning when tripped", () => {
    const metricsDir = join(TEST_DIR, ".garyclaw", "oracle-memory");
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(
      join(metricsDir, "metrics.json"),
      JSON.stringify({
        totalDecisions: 20,
        accurateDecisions: 5,
        neutralDecisions: 0,
        failedDecisions: 15,
        accuracyPercent: 25,
        confidenceTrend: [],
        lastReflectionTimestamp: null,
        circuitBreakerTripped: true,
      }),
      "utf-8",
    );

    const ctx = loadOracleContext(TEST_DIR);
    expect(ctx).toContain("Circuit breaker TRIPPED");
  });

  it("includes decision outcomes when they exist", () => {
    const memDir = join(TEST_DIR, ".garyclaw", "oracle-memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "decision-outcomes.md"),
      "### dec-001\n- **Question:** Fix the bug?\n- **Chosen:** Yes\n- **Outcome:** success\n",
      "utf-8",
    );

    const ctx = loadOracleContext(TEST_DIR);
    expect(ctx).toContain("Recent Decision Outcomes");
    expect(ctx).toContain("Fix the bug?");
  });
});

// ── formatMetricsSummary ─────────────────────────────────────────

describe("formatMetricsSummary", () => {
  it("returns empty string for zero decisions", () => {
    const metrics: OracleMetrics = {
      totalDecisions: 0,
      accurateDecisions: 0,
      neutralDecisions: 0,
      failedDecisions: 0,
      accuracyPercent: 100,
      confidenceTrend: [],
      lastReflectionTimestamp: null,
      circuitBreakerTripped: false,
    };
    expect(formatMetricsSummary(metrics)).toBe("");
  });

  it("formats metrics with decisions", () => {
    const metrics: OracleMetrics = {
      totalDecisions: 10,
      accurateDecisions: 8,
      neutralDecisions: 1,
      failedDecisions: 1,
      accuracyPercent: 88.9,
      confidenceTrend: [7, 8],
      lastReflectionTimestamp: null,
      circuitBreakerTripped: false,
    };
    const result = formatMetricsSummary(metrics);
    expect(result).toContain("Total decisions: 10");
    expect(result).toContain("89%");
    expect(result).not.toContain("Circuit breaker");
  });

  it("includes circuit breaker warning", () => {
    const metrics: OracleMetrics = {
      totalDecisions: 10,
      accurateDecisions: 3,
      neutralDecisions: 0,
      failedDecisions: 7,
      accuracyPercent: 30,
      confidenceTrend: [],
      lastReflectionTimestamp: null,
      circuitBreakerTripped: true,
    };
    const result = formatMetricsSummary(metrics);
    expect(result).toContain("Circuit breaker TRIPPED");
  });
});

// ── formatPipelineContext ────────────────────────────────────────

describe("formatPipelineContext", () => {
  it("returns empty string for no previous skills", () => {
    expect(formatPipelineContext([])).toBe("");
  });

  it("returns empty string for skills without reports", () => {
    const skills: PipelineSkillEntry[] = [
      { skillName: "qa", status: "pending" },
    ];
    expect(formatPipelineContext(skills)).toBe("");
  });

  it("formats open issues from previous skills", () => {
    const skills: PipelineSkillEntry[] = [
      {
        skillName: "qa",
        status: "complete",
        report: createMockRunReport("qa", {
          issues: [
            createMockIssue({ status: "open", severity: "high", description: "Broken auth" }),
            createMockIssue({ status: "fixed" }),
          ],
        }),
      },
    ];
    const result = formatPipelineContext(skills);
    expect(result).toContain("/qa");
    expect(result).toContain("OPEN");
    expect(result).toContain("Broken auth");
    expect(result).toContain("1 fixed, 1 open");
  });

  it("formats deferred issues", () => {
    const skills: PipelineSkillEntry[] = [
      {
        skillName: "qa",
        status: "complete",
        report: createMockRunReport("qa", {
          issues: [
            createMockIssue({ status: "deferred", description: "Low-priority cleanup" }),
          ],
        }),
      },
    ];
    const result = formatPipelineContext(skills);
    expect(result).toContain("DEFERRED");
    expect(result).toContain("Low-priority cleanup");
  });

  it("formats findings and decisions", () => {
    const skills: PipelineSkillEntry[] = [
      {
        skillName: "design-review",
        status: "complete",
        report: createMockRunReport("design-review", {
          findings: [createMockFinding({ category: "architecture", description: "Missing retry logic" })],
          decisions: [createMockDecision({ question: "Use WebSocket?", chosen: "Yes", confidence: 9 })],
        }),
      },
    ];
    const result = formatPipelineContext(skills);
    expect(result).toContain("Missing retry logic");
    expect(result).toContain("Use WebSocket?");
    expect(result).toContain("9/10");
  });

  it("skips skills with empty reports", () => {
    const skills: PipelineSkillEntry[] = [
      {
        skillName: "qa",
        status: "complete",
        report: createMockRunReport("qa"),
      },
    ];
    expect(formatPipelineContext(skills)).toBe("");
  });
});

// ── buildPrioritizePrompt ────────────────────────────────────────

describe("buildPrioritizePrompt", () => {
  it("includes role description", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("technical product manager");
    expect(prompt).toContain("highest-impact item");
  });

  it("includes TODOS.md content when present", async () => {
    writeFileSync(join(TEST_DIR, "TODOS.md"), SAMPLE_TODOS, "utf-8");
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Daemon Hardening");
    expect(prompt).toContain("Adaptive maxTurns");
  });

  it("handles missing TODOS.md gracefully", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("No TODOS.md found");
  });

  it("includes overnight goal when present", async () => {
    writeFileSync(join(TEST_DIR, "overnight-goal.md"), "Ship P2 items\n", "utf-8");
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Overnight Goal");
    expect(prompt).toContain("Ship P2 items");
  });

  it("omits overnight goal section when file is missing", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).not.toContain("Overnight Goal");
  });

  it("includes oracle context when memory is enabled", async () => {
    const metricsDir = join(TEST_DIR, ".garyclaw", "oracle-memory");
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(
      join(metricsDir, "metrics.json"),
      JSON.stringify({
        totalDecisions: 10,
        accurateDecisions: 8,
        neutralDecisions: 1,
        failedDecisions: 1,
        accuracyPercent: 88.9,
        confidenceTrend: [],
        lastReflectionTimestamp: null,
        circuitBreakerTripped: false,
      }),
      "utf-8",
    );

    const config = createMockConfig({ noMemory: false });
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Oracle Intelligence");
  });

  it("omits oracle context when --no-memory", async () => {
    const metricsDir = join(TEST_DIR, ".garyclaw", "oracle-memory");
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(
      join(metricsDir, "metrics.json"),
      JSON.stringify({
        totalDecisions: 10,
        accurateDecisions: 8,
        neutralDecisions: 1,
        failedDecisions: 1,
        accuracyPercent: 88.9,
        confidenceTrend: [],
        lastReflectionTimestamp: null,
        circuitBreakerTripped: false,
      }),
      "utf-8",
    );

    const config = createMockConfig({ noMemory: true });
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).not.toContain("Oracle Intelligence");
  });

  it("includes pipeline context from previous skills", async () => {
    const config = createMockConfig();
    const prevSkills: PipelineSkillEntry[] = [
      {
        skillName: "qa",
        status: "complete",
        report: createMockRunReport("qa", {
          issues: [createMockIssue({ status: "open", description: "Auth bug" })],
        }),
      },
    ];
    const prompt = await buildPrioritizePrompt(config, prevSkills, TEST_DIR);
    expect(prompt).toContain("Previous Skill Findings");
    expect(prompt).toContain("Auth bug");
  });

  it("includes scoring rubric", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Scoring Rubric");
    expect(prompt).toContain("Autonomous run quality");
    expect(prompt).toContain("Unblocks other work");
    expect(prompt).toContain("Effort efficiency");
    expect(prompt).toContain("Dependency readiness");
  });

  it("includes confidence gate instruction", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Confidence Gate");
    expect(prompt).toContain("5.0/10");
    expect(prompt).toContain("Backlog Exhausted");
  });

  it("includes anti-patterns", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Anti-Patterns");
    expect(prompt).toContain("Do NOT pick items with unmet dependencies");
    expect(prompt).toContain("Do NOT modify any source code");
  });

  it("includes worked example", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Worked Example");
    expect(prompt).toContain("Stale PID cleanup");
  });

  it("includes all four phases", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Phase 1 — READ");
    expect(prompt).toContain("Phase 2 — SCORE");
    expect(prompt).toContain("Phase 3 — RANK");
    expect(prompt).toContain("Phase 4 — OUTPUT");
  });

  it("includes output format specification", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain(".garyclaw/priority.md");
    expect(prompt).toContain("Top Pick");
    expect(prompt).toContain("Alternatives");
    expect(prompt).toContain("Skipped Items");
    expect(prompt).toContain("Backlog Health");
  });
});
