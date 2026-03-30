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
