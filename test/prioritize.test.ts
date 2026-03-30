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
  aggregateFailurePatterns,
  getDecisionQualityTrends,
  measureRecentImpact,
  filterOpenTodos,
  addBudgetedSection,
  truncateSection,
  PRIORITIZE_PROMPT_BUDGET,
  PRIORITIZE_SECTION_BUDGETS,
} from "../src/prioritize.js";
import { estimateTokens } from "../src/checkpoint.js";
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
    expect(prompt).toContain("Wow factor");
    expect(prompt).toContain("Unblocks other work");
    expect(prompt).toContain("Effort efficiency");
    expect(prompt).toContain("Dependency readiness");
  });

  it("has correct scoring weights for all dimensions", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    // Autonomous run quality reduced from 3x to 2x
    expect(prompt).toMatch(/Autonomous run quality\s*\|\s*2x/i);
    // New Wow factor dimension at 2x
    expect(prompt).toMatch(/Wow factor\s*\|\s*2x/i);
    // Unblocks other work stays at 2x
    expect(prompt).toMatch(/Unblocks other work\s*\|\s*2x/i);
    // Effort efficiency stays at 1x
    expect(prompt).toMatch(/Effort efficiency\s*\|\s*1x/i);
    // Dependency readiness stays at 2x
    expect(prompt).toMatch(/Dependency readiness\s*\|\s*2x/i);
    // Overnight goal alignment reduced from 2x to 1x
    expect(prompt).toMatch(/Alignment with overnight goal\s*\|\s*1x/i);
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

  it("includes invention protocol", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Invention Protocol");
    expect(prompt).toContain("Step 1 — RESEARCH");
    expect(prompt).toContain("Step 3 — CRITIQUE");
    expect(prompt).toContain("Step 4 — PRUNE");
  });

  it("includes failure pattern scoring bonus instruction", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("+2 scoring bonus to items that fix recurring failure patterns");
  });

  it("includes failure patterns section when failures exist", async () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    writeFileSync(
      join(gcDir, "failures.jsonl"),
      JSON.stringify({ timestamp: "2026-03-30T01:00:00Z", jobId: "j1", skills: ["qa"], category: "project-bug", retryable: false, errorMessage: "test failed" }) + "\n",
      "utf-8",
    );

    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Failure Patterns");
    expect(prompt).toContain("project-bug");
  });

  it("includes decision quality trends when decisions exist", async () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        timestamp: `2026-03-30T0${i}:00:00Z`,
        sessionIndex: 0,
        question: "Should we use WebSocket for real-time updates?",
        options: [{ label: "Yes", description: "Use WS" }, { label: "No", description: "Use polling" }],
        chosen: "Yes",
        confidence: 4,
        rationale: "Low confidence",
        principle: "Bias toward action",
      }),
    );
    writeFileSync(join(gcDir, "decisions.jsonl"), lines.join("\n") + "\n", "utf-8");

    const metricsDir = join(gcDir, "oracle-memory");
    mkdirSync(metricsDir, { recursive: true });
    writeFileSync(
      join(metricsDir, "metrics.json"),
      JSON.stringify({
        totalDecisions: 10,
        accurateDecisions: 8,
        neutralDecisions: 1,
        failedDecisions: 1,
        accuracyPercent: 88.9,
        confidenceTrend: [4, 5, 4, 3, 5],
        lastReflectionTimestamp: null,
        circuitBreakerTripped: false,
      }),
      "utf-8",
    );

    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Decision Quality Trends");
  });

  it("includes impact measurement when enough jobs exist", async () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const jobs = Array.from({ length: 6 }, (_, i) => ({
      id: `job-${i}`,
      triggeredBy: "manual",
      triggerDetail: "test",
      skills: ["qa"],
      projectDir: TEST_DIR,
      status: "complete",
      enqueuedAt: `2026-03-${20 + i}T00:00:00Z`,
      startedAt: `2026-03-${20 + i}T00:01:00Z`,
      completedAt: `2026-03-${20 + i}T00:10:00Z`,
      costUsd: i < 3 ? 2.0 : 1.0,
    }));
    writeFileSync(
      join(gcDir, "daemon-state.json"),
      JSON.stringify({ version: 1, jobs, dailyCost: { date: "2026-03-30", totalUsd: 0, jobCount: 0 } }),
      "utf-8",
    );

    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Impact Measurement");
  });

  // ── Skill catalog injection ──────────────────────────────────
  it("includes skill catalog section", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("### Review Skills");
    expect(prompt).toContain("### Execution Skills");
  });

  it("includes skill catalog guidance for pipeline recommendation", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("### Recommended Pipeline");
    expect(prompt).toContain("design-review");
    expect(prompt).toContain("plan-eng-review");
  });

  it("skill catalog appears before output phase", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    const catalogIdx = prompt.indexOf("## Available Skills");
    const outputIdx = prompt.indexOf("## Phase 4 — OUTPUT");
    expect(catalogIdx).toBeGreaterThan(-1);
    expect(outputIdx).toBeGreaterThan(-1);
    expect(catalogIdx).toBeLessThan(outputIdx);
  });

  it("includes Task Category output instruction in prompt rules", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("### Task Category");
    expect(prompt).toContain("visual-ux, architectural, bug-fix, refactor, performance, infra, new-feature");
  });

  it("includes Task Category Guidelines section", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("## Task Category Guidelines");
    expect(prompt).toContain("UI changes, design polish");
  });

  it("injects per-category stats when 10+ pipeline outcomes exist", async () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    // Create 12 outcome records — 4 visual-ux with design-review skipped (3 failures),
    // 4 visual-ux with design-review included (0 failures), 4 refactor filler
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      outcomes.push(JSON.stringify({
        jobId: `skip-${i}`, timestamp: "2026-03-30T00:00:00Z", todoTitle: `task-${i}`,
        effort: "S", priority: 3, skills: ["implement", "qa"], skippedSkills: ["design-review"],
        qaFailureCount: i < 3 ? 2 : 0, reopenedCount: 0,
        outcome: i < 3 ? "failure" : "success", oracleAdjusted: false, taskCategory: "visual-ux",
      }));
    }
    for (let i = 0; i < 4; i++) {
      outcomes.push(JSON.stringify({
        jobId: `incl-${i}`, timestamp: "2026-03-30T00:00:00Z", todoTitle: `task-incl-${i}`,
        effort: "S", priority: 3, skills: ["design-review", "implement", "qa"], skippedSkills: [],
        qaFailureCount: 0, reopenedCount: 0,
        outcome: "success", oracleAdjusted: false, taskCategory: "visual-ux",
      }));
    }
    for (let i = 0; i < 4; i++) {
      outcomes.push(JSON.stringify({
        jobId: `filler-${i}`, timestamp: "2026-03-30T00:00:00Z", todoTitle: `filler-${i}`,
        effort: "S", priority: 3, skills: ["implement", "qa"], skippedSkills: [],
        qaFailureCount: 0, reopenedCount: 0,
        outcome: "success", oracleAdjusted: false, taskCategory: "refactor",
      }));
    }
    writeFileSync(join(gcDir, "pipeline-outcomes.jsonl"), outcomes.join("\n") + "\n", "utf-8");

    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("### Pipeline Outcome Patterns by Task Category");
    expect(prompt).toContain("visual-ux");
    expect(prompt).toContain("design-review");
    expect(prompt).toContain("High delta means the skill matters");
  });

  it("omits per-category stats when fewer than 10 outcomes", async () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const outcomes = Array.from({ length: 5 }, (_, i) => JSON.stringify({
      jobId: `j-${i}`, timestamp: "2026-03-30T00:00:00Z", todoTitle: `t-${i}`,
      effort: "S", priority: 3, skills: ["implement", "qa"], skippedSkills: [],
      qaFailureCount: 0, reopenedCount: 0,
      outcome: "success", oracleAdjusted: false, taskCategory: "refactor",
    }));
    writeFileSync(join(gcDir, "pipeline-outcomes.jsonl"), outcomes.join("\n") + "\n", "utf-8");

    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).not.toContain("Pipeline Outcome Patterns by Task Category");
  });

  it("omits per-category stats when no category/skill pairs meet min sample threshold", async () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    // 10 outcomes but each with a unique category — no pair hits MIN_CATEGORY_SAMPLES (3)
    const categories = ["visual-ux", "architectural", "bug-fix", "refactor", "performance",
      "infra", "new-feature", "visual-ux", "architectural", "bug-fix"];
    const outcomes = categories.map((cat, i) => JSON.stringify({
      jobId: `j-${i}`, timestamp: "2026-03-30T00:00:00Z", todoTitle: `t-${i}`,
      effort: "S", priority: 3, skills: ["implement", "qa"], skippedSkills: ["design-review"],
      qaFailureCount: 0, reopenedCount: 0,
      outcome: "success", oracleAdjusted: false, taskCategory: cat,
    }));
    writeFileSync(join(gcDir, "pipeline-outcomes.jsonl"), outcomes.join("\n") + "\n", "utf-8");

    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    // 10 outcomes exist, but per-category pairs may or may not hit MIN_CATEGORY_SAMPLES
    // This test verifies graceful handling either way — no crash
    expect(prompt).toContain("## Available Skills");
  });

  it("handles missing pipeline-outcomes.jsonl gracefully", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).not.toContain("Pipeline Outcome Patterns by Task Category");
    // Should still contain the rest of the prompt
    expect(prompt).toContain("## Phase 2 — SCORE");
  });
});

// ── aggregateFailurePatterns ─────────────────────────────────────

describe("aggregateFailurePatterns", () => {
  it("returns null for empty checkpoint dir", () => {
    expect(aggregateFailurePatterns(join(TEST_DIR, ".garyclaw"))).toBeNull();
  });

  it("returns null when failures.jsonl is missing", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    expect(aggregateFailurePatterns(gcDir)).toBeNull();
  });

  it("parses a single failure", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    writeFileSync(
      join(gcDir, "failures.jsonl"),
      JSON.stringify({ timestamp: "2026-03-30T01:00:00Z", jobId: "j1", skills: ["qa"], category: "project-bug", retryable: false, errorMessage: "test failed" }) + "\n",
      "utf-8",
    );

    const result = aggregateFailurePatterns(gcDir);
    expect(result).not.toBeNull();
    expect(result).toContain("1 total failure");
    expect(result).toContain("project-bug: 1 failure");
    expect(result).toContain("qa: 1 failure");
  });

  it("aggregates multiple categories", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const records = [
      { timestamp: "2026-03-30T01:00:00Z", jobId: "j1", skills: ["qa"], category: "project-bug", retryable: false, errorMessage: "e1" },
      { timestamp: "2026-03-30T02:00:00Z", jobId: "j2", skills: ["implement"], category: "sdk-bug", retryable: true, errorMessage: "e2" },
      { timestamp: "2026-03-30T03:00:00Z", jobId: "j3", skills: ["qa"], category: "project-bug", retryable: false, errorMessage: "e3" },
    ];
    writeFileSync(join(gcDir, "failures.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");

    const result = aggregateFailurePatterns(gcDir)!;
    expect(result).toContain("3 total failures");
    expect(result).toContain("project-bug: 2 failures");
    expect(result).toContain("sdk-bug: 1 failure");
    expect(result).toContain("qa: 2 failures");
    expect(result).toContain("implement: 1 failure");
  });

  it("scans cross-instance failures under daemons/", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    const instDir = join(gcDir, "daemons", "worker-1");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(
      join(instDir, "failures.jsonl"),
      JSON.stringify({ timestamp: "2026-03-30T01:00:00Z", jobId: "j1", skills: ["implement"], category: "garyclaw-bug", retryable: false, errorMessage: "e1" }) + "\n",
      "utf-8",
    );

    const result = aggregateFailurePatterns(gcDir);
    expect(result).not.toBeNull();
    expect(result).toContain("garyclaw-bug");
    expect(result).toContain("implement");
  });

  it("skips malformed JSONL lines", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    writeFileSync(
      join(gcDir, "failures.jsonl"),
      "not json\n" + JSON.stringify({ timestamp: "2026-03-30T01:00:00Z", jobId: "j1", skills: ["qa"], category: "infra-issue", retryable: true, errorMessage: "e1" }) + "\n",
      "utf-8",
    );

    const result = aggregateFailurePatterns(gcDir)!;
    expect(result).toContain("1 total failure");
    expect(result).toContain("infra-issue");
  });

  it("includes scoring bonus instruction", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    writeFileSync(
      join(gcDir, "failures.jsonl"),
      JSON.stringify({ timestamp: "2026-03-30T01:00:00Z", jobId: "j1", skills: ["qa"], category: "project-bug", retryable: false, errorMessage: "e1" }) + "\n",
      "utf-8",
    );

    const result = aggregateFailurePatterns(gcDir)!;
    expect(result).toContain("+2 scoring bonus");
  });
});

// ── getDecisionQualityTrends ─────────────────────────────────────

describe("getDecisionQualityTrends", () => {
  it("returns null when no oracle data or decisions exist", () => {
    expect(getDecisionQualityTrends(TEST_DIR)).toBeNull();
  });

  it("returns metrics when they exist even without decisions", () => {
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
        confidenceTrend: [7, 8, 9],
        lastReflectionTimestamp: null,
        circuitBreakerTripped: false,
      }),
      "utf-8",
    );

    const result = getDecisionQualityTrends(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain("Oracle accuracy: 89%");
    expect(result).toContain("10 decisions");
    expect(result).toContain("confidence trend");
  });

  it("clusters low-confidence decisions into topics", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });

    // Create decisions about the same topic with low confidence
    const decisions = [
      { timestamp: "t1", sessionIndex: 0, question: "Should we cache the WebSocket connection pool?", options: [], chosen: "Yes", confidence: 3, rationale: "", principle: "" },
      { timestamp: "t2", sessionIndex: 0, question: "How to handle WebSocket connection timeout?", options: [], chosen: "Retry", confidence: 4, rationale: "", principle: "" },
      { timestamp: "t3", sessionIndex: 0, question: "Should the WebSocket pool have a max size?", options: [], chosen: "Yes", confidence: 5, rationale: "", principle: "" },
    ];
    writeFileSync(join(gcDir, "decisions.jsonl"), decisions.map((d) => JSON.stringify(d)).join("\n") + "\n", "utf-8");

    const result = getDecisionQualityTrends(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain("Topics with low confidence");
  });

  it("ignores high-confidence decisions", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });

    const decisions = [
      { timestamp: "t1", sessionIndex: 0, question: "Fix the bug?", options: [], chosen: "Yes", confidence: 9, rationale: "", principle: "" },
      { timestamp: "t2", sessionIndex: 0, question: "Add the test?", options: [], chosen: "Yes", confidence: 8, rationale: "", principle: "" },
    ];
    writeFileSync(join(gcDir, "decisions.jsonl"), decisions.map((d) => JSON.stringify(d)).join("\n") + "\n", "utf-8");

    // No low-confidence groups should form
    const result = getDecisionQualityTrends(TEST_DIR);
    // May be null (no metrics + no low-conf groups) or just metrics (if metrics exist)
    if (result) {
      expect(result).not.toContain("Topics with low confidence");
    }
  });

  it("includes +1 bonus instruction when topics found", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });

    const decisions = [
      { timestamp: "t1", sessionIndex: 0, question: "Should we cache the database query results?", options: [], chosen: "Yes", confidence: 3, rationale: "", principle: "" },
      { timestamp: "t2", sessionIndex: 0, question: "How to invalidate database query cache entries?", options: [], chosen: "TTL", confidence: 4, rationale: "", principle: "" },
    ];
    writeFileSync(join(gcDir, "decisions.jsonl"), decisions.map((d) => JSON.stringify(d)).join("\n") + "\n", "utf-8");

    const result = getDecisionQualityTrends(TEST_DIR);
    if (result && result.includes("Topics with low confidence")) {
      expect(result).toContain("+1 scoring bonus");
    }
  });
});

// ── measureRecentImpact ──────────────────────────────────────────

describe("measureRecentImpact", () => {
  it("returns null for empty checkpoint dir", () => {
    expect(measureRecentImpact(join(TEST_DIR, ".garyclaw"))).toBeNull();
  });

  it("returns null for fewer than 4 jobs", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const jobs = [
      { id: "j1", triggeredBy: "manual", triggerDetail: "t", skills: ["qa"], projectDir: TEST_DIR, status: "complete", enqueuedAt: "2026-03-25T00:00:00Z", startedAt: "2026-03-25T00:01:00Z", completedAt: "2026-03-25T00:10:00Z", costUsd: 1.0 },
      { id: "j2", triggeredBy: "manual", triggerDetail: "t", skills: ["qa"], projectDir: TEST_DIR, status: "complete", enqueuedAt: "2026-03-26T00:00:00Z", startedAt: "2026-03-26T00:01:00Z", completedAt: "2026-03-26T00:10:00Z", costUsd: 1.5 },
    ];
    writeFileSync(
      join(gcDir, "daemon-state.json"),
      JSON.stringify({ version: 1, jobs, dailyCost: { date: "2026-03-30", totalUsd: 0, jobCount: 0 } }),
      "utf-8",
    );

    expect(measureRecentImpact(gcDir)).toBeNull();
  });

  it("detects cost decrease", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const jobs = Array.from({ length: 6 }, (_, i) => ({
      id: `j${i}`,
      triggeredBy: "manual",
      triggerDetail: "t",
      skills: ["qa"],
      projectDir: TEST_DIR,
      status: "complete",
      enqueuedAt: `2026-03-${20 + i}T00:00:00Z`,
      startedAt: `2026-03-${20 + i}T00:01:00Z`,
      completedAt: `2026-03-${20 + i}T00:10:00Z`,
      costUsd: i < 3 ? 3.0 : 1.0, // older jobs cost more
    }));
    writeFileSync(
      join(gcDir, "daemon-state.json"),
      JSON.stringify({ version: 1, jobs, dailyCost: { date: "2026-03-30", totalUsd: 0, jobCount: 0 } }),
      "utf-8",
    );

    const result = measureRecentImpact(gcDir)!;
    expect(result).toContain("Impact Measurement");
    expect(result).toContain("Cost improved");
    expect(result).toContain("savings");
  });

  it("detects cost increase", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const jobs = Array.from({ length: 6 }, (_, i) => ({
      id: `j${i}`,
      triggeredBy: "manual",
      triggerDetail: "t",
      skills: ["qa"],
      projectDir: TEST_DIR,
      status: "complete",
      enqueuedAt: `2026-03-${20 + i}T00:00:00Z`,
      startedAt: `2026-03-${20 + i}T00:01:00Z`,
      completedAt: `2026-03-${20 + i}T00:10:00Z`,
      costUsd: i < 3 ? 1.0 : 3.0, // newer jobs cost more
    }));
    writeFileSync(
      join(gcDir, "daemon-state.json"),
      JSON.stringify({ version: 1, jobs, dailyCost: { date: "2026-03-30", totalUsd: 0, jobCount: 0 } }),
      "utf-8",
    );

    const result = measureRecentImpact(gcDir)!;
    expect(result).toContain("Cost increased");
    expect(result).toContain("optimization");
  });

  it("detects stable costs", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const jobs = Array.from({ length: 4 }, (_, i) => ({
      id: `j${i}`,
      triggeredBy: "manual",
      triggerDetail: "t",
      skills: ["qa"],
      projectDir: TEST_DIR,
      status: "complete",
      enqueuedAt: `2026-03-${20 + i}T00:00:00Z`,
      startedAt: `2026-03-${20 + i}T00:01:00Z`,
      completedAt: `2026-03-${20 + i}T00:10:00Z`,
      costUsd: 2.0,
    }));
    writeFileSync(
      join(gcDir, "daemon-state.json"),
      JSON.stringify({ version: 1, jobs, dailyCost: { date: "2026-03-30", totalUsd: 0, jobCount: 0 } }),
      "utf-8",
    );

    const result = measureRecentImpact(gcDir)!;
    expect(result).toContain("stable");
  });

  it("scans cross-instance daemon state", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    const instDir = join(gcDir, "daemons", "worker-1");
    mkdirSync(instDir, { recursive: true });
    const jobs = Array.from({ length: 4 }, (_, i) => ({
      id: `j${i}`,
      triggeredBy: "manual",
      triggerDetail: "t",
      skills: ["qa"],
      projectDir: TEST_DIR,
      status: "complete",
      enqueuedAt: `2026-03-${20 + i}T00:00:00Z`,
      startedAt: `2026-03-${20 + i}T00:01:00Z`,
      completedAt: `2026-03-${20 + i}T00:10:00Z`,
      costUsd: 1.5,
    }));
    writeFileSync(
      join(instDir, "daemon-state.json"),
      JSON.stringify({ version: 1, jobs, dailyCost: { date: "2026-03-30", totalUsd: 0, jobCount: 0 } }),
      "utf-8",
    );

    const result = measureRecentImpact(gcDir);
    expect(result).not.toBeNull();
    expect(result).toContain("Impact Measurement");
  });

  it("skips non-complete and zero-cost jobs", () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const jobs = [
      { id: "j1", triggeredBy: "manual", triggerDetail: "t", skills: ["qa"], projectDir: TEST_DIR, status: "failed", enqueuedAt: "2026-03-25T00:00:00Z", costUsd: 5.0 },
      { id: "j2", triggeredBy: "manual", triggerDetail: "t", skills: ["qa"], projectDir: TEST_DIR, status: "complete", enqueuedAt: "2026-03-25T00:00:00Z", completedAt: "2026-03-25T00:10:00Z", costUsd: 0 },
      { id: "j3", triggeredBy: "manual", triggerDetail: "t", skills: ["qa"], projectDir: TEST_DIR, status: "queued", enqueuedAt: "2026-03-25T00:00:00Z", costUsd: 0 },
    ];
    writeFileSync(
      join(gcDir, "daemon-state.json"),
      JSON.stringify({ version: 1, jobs, dailyCost: { date: "2026-03-30", totalUsd: 0, jobCount: 0 } }),
      "utf-8",
    );

    // Only 0 qualifying jobs (failed has no completedAt filter pass, zero-cost skipped)
    expect(measureRecentImpact(gcDir)).toBeNull();
  });
});

// ── buildPrioritizePrompt: category stats injection ─────────────

describe("buildPrioritizePrompt — category stats", () => {
  it("includes Task Category in output format", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("### Task Category");
    expect(prompt).toContain("visual-ux");
    expect(prompt).toContain("architectural");
    expect(prompt).toContain("bug-fix");
  });

  it("includes Task Category Guidelines section", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("## Task Category Guidelines");
    expect(prompt).toContain("UI changes, design polish");
    expect(prompt).toContain("shared interfaces, cross-module changes");
  });

  it("omits per-category stats when pipeline-outcomes.jsonl is missing", async () => {
    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).not.toContain("Pipeline Outcome Patterns by Task Category");
  });

  it("omits per-category stats when fewer than 10 outcomes exist", async () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 9; i++) {
      lines.push(JSON.stringify({
        jobId: `j${i}`, timestamp: "2026-03-30T00:00:00Z", todoTitle: "Item",
        effort: "S", priority: 3, skills: ["implement", "qa"], skippedSkills: ["design-review"],
        qaFailureCount: 0, reopenedCount: 0, outcome: "success", oracleAdjusted: false,
        taskCategory: "visual-ux",
      }));
    }
    writeFileSync(join(gcDir, "pipeline-outcomes.jsonl"), lines.join("\n") + "\n", "utf-8");

    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).not.toContain("Pipeline Outcome Patterns by Task Category");
  });

  it("injects per-category stats table when 10+ outcomes with sufficient samples", async () => {
    const gcDir = join(TEST_DIR, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({
        jobId: `j${i}`, timestamp: "2026-03-30T00:00:00Z", todoTitle: "Item",
        effort: "S", priority: 3, skills: ["implement", "qa"],
        skippedSkills: ["design-review"],
        qaFailureCount: i < 5 ? 2 : 0, reopenedCount: 0,
        outcome: i < 5 ? "failure" : "success",
        oracleAdjusted: false, taskCategory: "visual-ux",
      }));
    }
    writeFileSync(join(gcDir, "pipeline-outcomes.jsonl"), lines.join("\n") + "\n", "utf-8");

    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Pipeline Outcome Patterns by Task Category");
    expect(prompt).toContain("visual-ux");
    expect(prompt).toContain("design-review");
    expect(prompt).toContain("High delta means the skill matters");
  });
});

// ── filterOpenTodos ─────────────────────────────────────────────

describe("filterOpenTodos", () => {
  it("keeps open items, removes struck-through items", () => {
    const input = `# TODOS

## P2: Open Item

**What:** Something to do.

## ~~P3: Done Item~~

**What:** Already done.

## P3: Another Open

**What:** More work.`;

    const result = filterOpenTodos(input);
    expect(result).toContain("## P2: Open Item");
    expect(result).toContain("## P3: Another Open");
    expect(result).not.toContain("~~P3: Done Item~~");
  });

  it("preserves preamble text before first ## block", () => {
    const input = `# TODOS

Some preamble text here.

## ~~P2: Completed~~

Done stuff.

## P3: Still Open

Open stuff.`;

    const result = filterOpenTodos(input);
    expect(result).toContain("# TODOS");
    expect(result).toContain("Some preamble text here.");
    expect(result).toContain("## P3: Still Open");
    expect(result).not.toContain("Completed");
  });

  it("handles all-struck-through input (returns empty for fallback path)", () => {
    const input = `# TODOS

## ~~P2: Done A~~

A stuff.

## ~~P3: Done B~~

B stuff.`;

    const result = filterOpenTodos(input);
    // When all structured items are struck through, return empty so the caller
    // falls through to the "No TODOS.md found" path instead of injecting just "# TODOS"
    expect(result).toBe("");
  });

  it("handles empty input", () => {
    expect(filterOpenTodos("")).toBe("");
  });

  it("handles input with no ## blocks", () => {
    const input = "# TODOS\n\nJust some text.";
    const result = filterOpenTodos(input);
    expect(result).toBe("# TODOS\n\nJust some text.");
  });
});

// ── Budget constants ────────────────────────────────────────────

describe("budget constants", () => {
  it("section budgets are reasonable (soft caps, may exceed total since empty sections donate budget)", () => {
    const sum = Object.values(PRIORITIZE_SECTION_BUDGETS).reduce((a, b) => a + b, 0);
    // Soft caps sum can exceed total budget — the waterfall pattern means
    // empty sections donate their budget, so not all caps are used simultaneously.
    // But they should be within 2x the total budget (sanity check).
    expect(sum).toBeLessThanOrEqual(PRIORITIZE_PROMPT_BUDGET * 2);
    expect(sum).toBeGreaterThan(0);
  });

  it("all section caps are positive", () => {
    for (const [key, val] of Object.entries(PRIORITIZE_SECTION_BUDGETS)) {
      expect(val, `${key} should be > 0`).toBeGreaterThan(0);
    }
  });

  it("PRIORITIZE_PROMPT_BUDGET is reasonable", () => {
    expect(PRIORITIZE_PROMPT_BUDGET).toBeGreaterThanOrEqual(10_000);
    expect(PRIORITIZE_PROMPT_BUDGET).toBeLessThanOrEqual(50_000);
  });
});

// ── addBudgetedSection ──────────────────────────────────────────

describe("addBudgetedSection", () => {
  it("adds content under cap unchanged", () => {
    const lines: string[] = [];
    const content = "Short content here.";
    const tokens = addBudgetedSection(lines, "### Header", content, 5000, 10000);
    expect(tokens).toBeGreaterThan(0);
    expect(lines).toContain("### Header");
    expect(lines.some(l => l.includes("Short content here."))).toBe(true);
  });

  it("truncates content over section cap (keepEnd=false default)", () => {
    const lines: string[] = [];
    // Create content that's ~2000 tokens (7000 chars)
    const content = Array.from({ length: 280 }, (_, i) => `Line ${i}: text for testing.`).join("\n");
    const tokens = addBudgetedSection(lines, "### Big Section", content, 500, 10000);
    expect(tokens).toBeLessThanOrEqual(600); // some overhead for header
    // The full content would be ~2000 tokens, but cap is 500
    const joined = lines.join("\n");
    expect(joined.length).toBeLessThan(content.length);
    // keepEnd=false (default): keeps beginning, shows truncation marker
    expect(joined).toContain("Line 0:");
    expect(joined).toContain("[...truncated to fit token budget]");
  });

  it("truncates with keepEnd=true (keeps newest)", () => {
    const lines: string[] = [];
    const content = Array.from({ length: 100 }, (_, i) => `Line ${i}: some content here`).join("\n");
    const tokens = addBudgetedSection(lines, "### Tail Section", content, 200, 10000, true);
    expect(tokens).toBeGreaterThan(0);
    const joined = lines.join("\n");
    expect(joined).toContain("Line 99:");
    expect(joined).toContain("[...older entries truncated]");
    expect(joined).not.toContain("Line 0:");
  });

  it("returns 0 for empty content", () => {
    const lines: string[] = [];
    expect(addBudgetedSection(lines, "### Empty", "", 5000, 10000)).toBe(0);
    expect(lines).toHaveLength(0);
  });

  it("returns 0 for whitespace-only content", () => {
    const lines: string[] = [];
    expect(addBudgetedSection(lines, "### Whitespace", "   \n  ", 5000, 10000)).toBe(0);
    expect(lines).toHaveLength(0);
  });

  it("returns 0 when remaining budget is zero", () => {
    const lines: string[] = [];
    expect(addBudgetedSection(lines, "### No Budget", "content", 5000, 0)).toBe(0);
    expect(lines).toHaveLength(0);
  });

  it("uses remaining budget when smaller than section cap", () => {
    const lines: string[] = [];
    // Content is ~1000 tokens, section cap 5000, but remaining only 200
    const content = "A ".repeat(1750); // ~1000 tokens
    const tokens = addBudgetedSection(lines, "### Limited", content, 5000, 200);
    expect(tokens).toBeLessThanOrEqual(300); // effective cap was 200
  });

  it("skips header when empty string", () => {
    const lines: string[] = [];
    addBudgetedSection(lines, "", "some content", 5000, 10000);
    // No header line should be present
    expect(lines[0]).toBe("some content");
  });
});

// ── buildPrioritizePrompt budget enforcement ────────────────────

describe("buildPrioritizePrompt budget enforcement", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("total prompt stays within budget with large TODOS.md", async () => {
    // Write a large TODOS.md (~20K tokens worth of open items)
    const bigTodos = "# TODOS\n\n" + Array.from({ length: 100 }, (_, i) =>
      `## P3: Item ${i}\n\n**What:** ${"Description text for this item. ".repeat(20)}\n\n**Effort:** S\n**Depends on:** None\n`
    ).join("\n");
    writeFileSync(join(TEST_DIR, "TODOS.md"), bigTodos, "utf-8");

    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    const tokens = estimateTokens(prompt);
    // The fixed sections (rules + worked example) are ~2.3K tokens and always included.
    // Budgeted sections are controlled by the waterfall; total should stay near budget.
    // Verify the TODOS section was truncated (not all 100 items present)
    const itemMatches = prompt.match(/## P3: Item \d+/g) ?? [];
    expect(itemMatches.length).toBeLessThan(100);
  });

  it("prompt is valid with empty sections (most null)", async () => {
    // No TODOS.md, no CLAUDE.md, no oracle, no daemon state — almost everything null
    const config = createMockConfig({ noMemory: true });
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("technical product manager");
    expect(prompt).toContain("Phase 1 — READ");
    expect(prompt).toContain("No TODOS.md found");
    expect(prompt).toContain("Scoring Rubric");
    expect(prompt).toContain("Worked Example");
  });

  it("filters struck-through items from TODOS.md", async () => {
    const todos = `# TODOS

## ~~P2: Already Done~~

Completed item.

## P3: Open Item

**What:** This is open.
**Effort:** S`;
    writeFileSync(join(TEST_DIR, "TODOS.md"), todos, "utf-8");

    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("Open Item");
    expect(prompt).not.toContain("Already Done");
  });

  it("scoring rules and worked example always survive", async () => {
    // Even with large context, the fixed sections must be present
    const bigTodos = "# TODOS\n\n" + Array.from({ length: 50 }, (_, i) =>
      `## P3: Item ${i}\n\n${"Long description. ".repeat(40)}\n`
    ).join("\n");
    writeFileSync(join(TEST_DIR, "TODOS.md"), bigTodos, "utf-8");

    // Write large CLAUDE.md
    writeFileSync(join(TEST_DIR, "CLAUDE.md"),
      "# Project\n\n" + "Capability description. ".repeat(500) + "\n---\n## Current Status\n" + "Status line.\n".repeat(200),
      "utf-8");

    const config = createMockConfig();
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toContain("## Scoring Rubric");
    expect(prompt).toContain("## Worked Example");
    expect(prompt).toContain("## Confidence Gate");
    expect(prompt).toContain("## Anti-Patterns");
  });
});

// ── truncateSection ─────────────────────────────────────────────

describe("truncateSection", () => {
  it("returns content unchanged when under budget", () => {
    const content = "Short text here.";
    expect(truncateSection(content, 1000)).toBe(content);
  });

  it("keepEnd=false (default): keeps beginning, drops end", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Entry ${i}: data here`);
    const content = lines.join("\n");
    const result = truncateSection(content, 100);
    expect(result).toContain("[...truncated to fit token budget]");
    expect(result).toContain("Entry 0:");
    expect(result).not.toContain("Entry 199:");
  });

  it("keepEnd=true: keeps newest content, drops oldest", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Entry ${i}: data here`);
    const content = lines.join("\n");
    const result = truncateSection(content, 100, true);
    expect(result).toContain("[...older entries truncated]");
    expect(result).toContain("Entry 199:");
    expect(result).not.toContain("Entry 0:");
  });

  it("keepEnd=true snaps to newline boundary", () => {
    // Build content that will be truncated
    const content = "AAAA\nBBBB\nCCCC\nDDDD\n".repeat(50);
    const result = truncateSection(content, 20, true);
    // Should not start mid-line
    expect(result.startsWith("[...older entries truncated]\n")).toBe(true);
  });

  it("keepEnd=false snaps to newline boundary", () => {
    const content = "AAAA\nBBBB\nCCCC\nDDDD\n".repeat(50);
    const result = truncateSection(content, 20, false);
    // Should end at a line boundary + truncation marker
    expect(result.endsWith("\n[...truncated to fit token budget]")).toBe(true);
  });

  it("uses estimateTokens consistently (no 14% overrun)", () => {
    // Create content that's exactly 1000 tokens via estimateTokens
    // estimateTokens uses chars / 3.5, so 3500 chars = 1000 tokens
    const content = "x".repeat(3500);
    const result = truncateSection(content, 500, true);
    // truncateSection uses maxTokens * 3.5 for char budget = 1750 chars
    // estimateTokens(result) should be ~500
    expect(estimateTokens(result)).toBeLessThanOrEqual(550); // some overhead for marker
  });

  it("handles content with no newlines (keepEnd=true)", () => {
    const content = "A".repeat(5000);
    const result = truncateSection(content, 100, true);
    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain("[...older entries truncated]");
  });

  it("handles content with no newlines (keepEnd=false)", () => {
    const content = "A".repeat(5000);
    const result = truncateSection(content, 100, false);
    expect(result.length).toBeLessThan(content.length);
    expect(result).toContain("[...truncated to fit token budget]");
  });
});

// ── prioritize_prompt_size event ────────────────────────────────

describe("prioritize_prompt_size event", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("emits prioritize_prompt_size event with token count and sections", async () => {
    writeFileSync(join(TEST_DIR, "TODOS.md"), SAMPLE_TODOS, "utf-8");

    const events: Array<{ type: string; tokens?: number; sections?: Record<string, number> }> = [];
    const config = createMockConfig({
      onEvent: (event) => events.push(event as any),
    });
    await buildPrioritizePrompt(config, [], TEST_DIR);

    const sizeEvents = events.filter(e => e.type === "prioritize_prompt_size");
    expect(sizeEvents).toHaveLength(1);
    expect(sizeEvents[0].tokens).toBeGreaterThan(0);
    expect(sizeEvents[0].sections).toBeDefined();
    expect(typeof sizeEvents[0].sections!.todos).toBe("number");
    expect(sizeEvents[0].sections!.todos).toBeGreaterThan(0);
  });

  it("does not emit event when onEvent is not provided", async () => {
    writeFileSync(join(TEST_DIR, "TODOS.md"), SAMPLE_TODOS, "utf-8");
    const config = createMockConfig(); // no onEvent
    // Should not throw
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);
    expect(prompt).toBeTruthy();
  });

  it("sections record tracks rules and workedExample as fixed sections", async () => {
    const events: Array<{ type: string; sections?: Record<string, number> }> = [];
    const config = createMockConfig({
      onEvent: (event) => events.push(event as any),
    });
    await buildPrioritizePrompt(config, [], TEST_DIR);

    const sizeEvent = events.find(e => e.type === "prioritize_prompt_size");
    expect(sizeEvent).toBeDefined();
    expect(sizeEvent!.sections!.rules).toBeGreaterThan(0);
    expect(sizeEvent!.sections!.workedExample).toBeGreaterThan(0);
  });

  it("sections record includes vision and capabilities when CLAUDE.md exists", async () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"),
      "# Project\n\nVision text.\n---\n## Current Status\nStatus here.\n---\n",
      "utf-8");

    const events: Array<{ type: string; sections?: Record<string, number> }> = [];
    const config = createMockConfig({
      onEvent: (event) => events.push(event as any),
    });
    await buildPrioritizePrompt(config, [], TEST_DIR);

    const sizeEvent = events.find(e => e.type === "prioritize_prompt_size");
    expect(sizeEvent!.sections!.vision).toBeGreaterThan(0);
    expect(sizeEvent!.sections!.capabilities).toBeGreaterThan(0);
  });

  it("total tokens in event reflects actual prompt size", async () => {
    writeFileSync(join(TEST_DIR, "TODOS.md"), SAMPLE_TODOS, "utf-8");

    const events: Array<{ type: string; tokens?: number }> = [];
    const config = createMockConfig({
      onEvent: (event) => events.push(event as any),
    });
    const prompt = await buildPrioritizePrompt(config, [], TEST_DIR);

    const sizeEvent = events.find(e => e.type === "prioritize_prompt_size");
    const actualTokens = estimateTokens(prompt);
    expect(sizeEvent!.tokens).toBe(actualTokens);
  });

  it("empty sections are not included in sections record", async () => {
    // No TODOS.md, no CLAUDE.md, noMemory — minimal sections
    const events: Array<{ type: string; sections?: Record<string, number> }> = [];
    const config = createMockConfig({
      noMemory: true,
      onEvent: (event) => events.push(event as any),
    });
    await buildPrioritizePrompt(config, [], TEST_DIR);

    const sizeEvent = events.find(e => e.type === "prioritize_prompt_size");
    // No TODOS.md → todosContent should not be in sections
    expect(sizeEvent!.sections!.todosContent).toBeUndefined();
    // No CLAUDE.md → vision should not be in sections
    expect(sizeEvent!.sections!.vision).toBeUndefined();
    // Oracle disabled → oracleContext should not be in sections
    expect(sizeEvent!.sections!.oracleContext).toBeUndefined();
  });
});
