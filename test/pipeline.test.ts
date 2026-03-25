/**
 * Pipeline module tests — state persistence, context handoff, report generation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  writePipelineState,
  readPipelineState,
  validatePipelineState,
  buildContextHandoff,
  buildPipelineReport,
  formatPipelineReportMarkdown,
} from "../src/pipeline.js";
import {
  createMockCheckpoint,
  createMockIssue,
  createMockFinding,
  createMockDecision,
  resetCounters,
} from "./helpers.js";
import type {
  PipelineState,
  PipelineSkillEntry,
  RunReport,
} from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-pipeline-tmp");

function createMockPipelineState(
  overrides: Partial<PipelineState> = {},
): PipelineState {
  return {
    version: 1,
    pipelineId: "pipeline-test-001",
    skills: [
      { skillName: "qa", status: "pending" },
      { skillName: "design-review", status: "pending" },
    ],
    currentSkillIndex: 0,
    startTime: "2026-03-25T10:00:00.000Z",
    totalCostUsd: 0,
    autonomous: false,
    ...overrides,
  };
}

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

describe("Pipeline State Persistence", () => {
  beforeEach(() => {
    resetCounters();
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("writes and reads pipeline state", () => {
    const state = createMockPipelineState();
    writePipelineState(state, TEST_DIR);

    const read = readPipelineState(TEST_DIR);
    expect(read).not.toBeNull();
    expect(read!.pipelineId).toBe("pipeline-test-001");
    expect(read!.skills).toHaveLength(2);
    expect(read!.skills[0].skillName).toBe("qa");
    expect(read!.skills[1].skillName).toBe("design-review");
  });

  it("returns null for missing pipeline state", () => {
    const read = readPipelineState(join(TEST_DIR, "nonexistent"));
    expect(read).toBeNull();
  });

  it("returns null for corrupt pipeline state", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(TEST_DIR, "pipeline.json"), "not json", "utf-8");
    const read = readPipelineState(TEST_DIR);
    expect(read).toBeNull();
  });

  it("returns null for pipeline state missing required fields", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(
      join(TEST_DIR, "pipeline.json"),
      JSON.stringify({ version: 1, pipelineId: "test" }),
      "utf-8",
    );
    const read = readPipelineState(TEST_DIR);
    expect(read).toBeNull();
  });

  it("preserves skill status and reports through write/read cycle", () => {
    const report = createMockRunReport("qa", {
      issues: [createMockIssue({ status: "fixed" })],
      findings: [createMockFinding()],
    });

    const state = createMockPipelineState({
      skills: [
        {
          skillName: "qa",
          status: "complete",
          startTime: "2026-03-25T10:00:00.000Z",
          endTime: "2026-03-25T10:30:00.000Z",
          report,
        },
        { skillName: "design-review", status: "running" },
      ],
      currentSkillIndex: 1,
      totalCostUsd: 0.05,
    });

    writePipelineState(state, TEST_DIR);
    const read = readPipelineState(TEST_DIR);

    expect(read!.skills[0].status).toBe("complete");
    expect(read!.skills[0].report!.issues).toHaveLength(1);
    expect(read!.skills[0].report!.issues[0].status).toBe("fixed");
    expect(read!.skills[1].status).toBe("running");
    expect(read!.currentSkillIndex).toBe(1);
  });

  it("creates directory if it does not exist", () => {
    const nested = join(TEST_DIR, "nested", "dir");
    const state = createMockPipelineState();
    writePipelineState(state, nested);
    expect(existsSync(join(nested, "pipeline.json"))).toBe(true);
  });
});

describe("validatePipelineState", () => {
  it("accepts valid pipeline state", () => {
    expect(validatePipelineState(createMockPipelineState())).toBe(true);
  });

  it("rejects null", () => {
    expect(validatePipelineState(null)).toBe(false);
  });

  it("rejects wrong version", () => {
    expect(
      validatePipelineState({ ...createMockPipelineState(), version: 2 }),
    ).toBe(false);
  });

  it("rejects missing pipelineId", () => {
    const s = createMockPipelineState();
    delete (s as any).pipelineId;
    expect(validatePipelineState(s)).toBe(false);
  });

  it("rejects non-array skills", () => {
    expect(
      validatePipelineState({ ...createMockPipelineState(), skills: "not array" }),
    ).toBe(false);
  });

  it("rejects missing autonomous field", () => {
    const s = createMockPipelineState();
    delete (s as any).autonomous;
    expect(validatePipelineState(s)).toBe(false);
  });
});

describe("buildContextHandoff", () => {
  beforeEach(() => {
    resetCounters();
  });

  it("builds handoff prompt with issues summary", () => {
    const report = createMockRunReport("qa", {
      issues: [
        createMockIssue({ status: "fixed" }),
        createMockIssue({ status: "open", severity: "critical" }),
        createMockIssue({ status: "open", severity: "high" }),
      ],
    });

    const prompt = buildContextHandoff("qa", report, "design-review");

    expect(prompt).toContain("Previous skill /qa completed");
    expect(prompt).toContain("1 issues fixed");
    expect(prompt).toContain("2 issues still open");
    expect(prompt).toContain("[critical]");
    expect(prompt).toContain("[high]");
    expect(prompt).toContain("Now run the /design-review skill");
  });

  it("builds handoff prompt with decisions", () => {
    const report = createMockRunReport("qa", {
      decisions: [
        createMockDecision({ question: "Fix the header?", chosen: "Yes" }),
        createMockDecision({ question: "Update the nav?", chosen: "No" }),
      ],
    });

    const prompt = buildContextHandoff("qa", report, "design-review");

    expect(prompt).toContain("Key Decisions");
    expect(prompt).toContain("Fix the header?");
    expect(prompt).toContain("Update the nav?");
  });

  it("builds handoff prompt with findings", () => {
    const report = createMockRunReport("qa", {
      findings: [
        createMockFinding({ category: "performance", description: "Slow load" }),
      ],
    });

    const prompt = buildContextHandoff("qa", report, "design-review");

    expect(prompt).toContain("Findings");
    expect(prompt).toContain("[performance]");
    expect(prompt).toContain("Slow load");
  });

  it("builds handoff prompt with run stats", () => {
    const report = createMockRunReport("qa", {
      totalSessions: 3,
      totalTurns: 45,
      estimatedCostUsd: 0.123,
    });

    const prompt = buildContextHandoff("qa", report, "ship");

    expect(prompt).toContain("Sessions: 3");
    expect(prompt).toContain("Turns: 45");
    expect(prompt).toContain("$0.123");
  });

  it("handles empty report gracefully", () => {
    const report = createMockRunReport("qa");

    const prompt = buildContextHandoff("qa", report, "design-review");

    expect(prompt).toContain("Previous skill /qa completed");
    expect(prompt).toContain("Now run the /design-review skill");
    expect(prompt).not.toContain("## Issues from /qa");
  });

  it("limits decisions to last 5", () => {
    const decisions = Array.from({ length: 8 }, (_, i) =>
      createMockDecision({ question: `Decision ${i + 1}?` }),
    );
    const report = createMockRunReport("qa", { decisions });

    const prompt = buildContextHandoff("qa", report, "ship");

    expect(prompt).toContain("last 5");
    expect(prompt).toContain("Decision 4?");
    expect(prompt).toContain("Decision 8?");
    expect(prompt).not.toContain("Decision 1?");
  });
});

describe("buildPipelineReport", () => {
  beforeEach(() => {
    resetCounters();
  });

  it("merges issues and findings across skills", () => {
    const state = createMockPipelineState({
      skills: [
        {
          skillName: "qa",
          status: "complete",
          report: createMockRunReport("qa", {
            issues: [
              createMockIssue({ id: "QA-001", status: "fixed" }),
              createMockIssue({ id: "QA-002", status: "open" }),
            ],
            findings: [createMockFinding({ description: "Finding A" })],
            totalSessions: 2,
            totalTurns: 20,
            estimatedCostUsd: 0.05,
          }),
        },
        {
          skillName: "design-review",
          status: "complete",
          report: createMockRunReport("design-review", {
            issues: [
              createMockIssue({ id: "DR-001", status: "fixed" }),
            ],
            findings: [
              createMockFinding({ description: "Finding A" }), // Duplicate
              createMockFinding({ description: "Finding B" }),
            ],
            totalSessions: 1,
            totalTurns: 15,
            estimatedCostUsd: 0.03,
          }),
        },
      ],
      totalCostUsd: 0.08,
    });

    const report = buildPipelineReport(state, "2026-03-25T11:00:00.000Z");

    expect(report.issues).toHaveLength(3); // QA-001, QA-002, DR-001
    expect(report.findings).toHaveLength(2); // "Finding A" deduped
    expect(report.totalSessions).toBe(3);
    expect(report.totalTurns).toBe(35);
    expect(report.totalCostUsd).toBe(0.08);
  });

  it("deduplicates issues by id (later skill wins)", () => {
    const state = createMockPipelineState({
      skills: [
        {
          skillName: "qa",
          status: "complete",
          report: createMockRunReport("qa", {
            issues: [
              createMockIssue({ id: "SHARED-001", status: "open" }),
            ],
          }),
        },
        {
          skillName: "design-review",
          status: "complete",
          report: createMockRunReport("design-review", {
            issues: [
              createMockIssue({ id: "SHARED-001", status: "fixed", fixCommit: "abc123" }),
            ],
          }),
        },
      ],
    });

    const report = buildPipelineReport(state, "2026-03-25T11:00:00.000Z");

    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].id).toBe("SHARED-001");
    expect(report.issues[0].status).toBe("fixed");
  });

  it("handles skills with no reports", () => {
    const state = createMockPipelineState({
      skills: [
        { skillName: "qa", status: "complete" },
        { skillName: "design-review", status: "pending" },
      ],
    });

    const report = buildPipelineReport(state, "2026-03-25T11:00:00.000Z");

    expect(report.issues).toHaveLength(0);
    expect(report.findings).toHaveLength(0);
    expect(report.decisions).toHaveLength(0);
    expect(report.totalSessions).toBe(0);
  });
});

describe("formatPipelineReportMarkdown", () => {
  beforeEach(() => {
    resetCounters();
  });

  it("produces valid markdown with all sections", () => {
    const state = createMockPipelineState({
      pipelineId: "pipeline-markdown-test",
      skills: [
        {
          skillName: "qa",
          status: "complete",
          startTime: "2026-03-25T10:00:00.000Z",
          endTime: "2026-03-25T10:30:00.000Z",
          report: createMockRunReport("qa", {
            issues: [
              createMockIssue({ id: "QA-100", status: "open", severity: "critical" }),
              createMockIssue({ id: "QA-101", status: "fixed" }),
            ],
            findings: [createMockFinding({ category: "perf" })],
            decisions: [createMockDecision()],
            estimatedCostUsd: 0.05,
          }),
        },
        {
          skillName: "ship",
          status: "complete",
          startTime: "2026-03-25T10:30:00.000Z",
          endTime: "2026-03-25T10:45:00.000Z",
          report: createMockRunReport("ship", {
            estimatedCostUsd: 0.02,
          }),
        },
      ],
      totalCostUsd: 0.07,
    });

    const report = buildPipelineReport(state, "2026-03-25T10:45:00.000Z");
    const md = formatPipelineReportMarkdown(report);

    expect(md).toContain("# GaryClaw Pipeline Report");
    expect(md).toContain("pipeline-markdown-test");
    expect(md).toContain("/qa → /ship");
    expect(md).toContain("$0.070");
    expect(md).toContain("### /qa — COMPLETE");
    expect(md).toContain("### /ship — COMPLETE");
    expect(md).toContain("Open Issues (1)");
    expect(md).toContain("QA-100");
    expect(md).toContain("[perf]");
    expect(md).toContain("Decisions (1)");
    expect(md).toContain("Generated by GaryClaw Pipeline");
  });

  it("handles empty pipeline report", () => {
    const state = createMockPipelineState({
      skills: [
        { skillName: "qa", status: "complete" },
      ],
    });

    const report = buildPipelineReport(state, "2026-03-25T11:00:00.000Z");
    const md = formatPipelineReportMarkdown(report);

    expect(md).toContain("# GaryClaw Pipeline Report");
    expect(md).not.toContain("## All Issues");
    expect(md).not.toContain("## Findings");
  });

  it("shows correct per-skill issue counts", () => {
    const state = createMockPipelineState({
      skills: [
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
      ],
    });

    const report = buildPipelineReport(state, "2026-03-25T11:00:00.000Z");
    const md = formatPipelineReportMarkdown(report);

    expect(md).toContain("Issues: 3 total, 2 fixed");
  });
});

describe("Pipeline state edge cases", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("handles 3-skill pipeline state", () => {
    const state = createMockPipelineState({
      skills: [
        { skillName: "qa", status: "complete" },
        { skillName: "design-review", status: "complete" },
        { skillName: "ship", status: "pending" },
      ],
      currentSkillIndex: 2,
    });

    writePipelineState(state, TEST_DIR);
    const read = readPipelineState(TEST_DIR);

    expect(read!.skills).toHaveLength(3);
    expect(read!.currentSkillIndex).toBe(2);
  });

  it("overwrites existing pipeline state", () => {
    const state1 = createMockPipelineState({ totalCostUsd: 0.01 });
    writePipelineState(state1, TEST_DIR);

    const state2 = createMockPipelineState({ totalCostUsd: 0.05 });
    writePipelineState(state2, TEST_DIR);

    const read = readPipelineState(TEST_DIR);
    expect(read!.totalCostUsd).toBe(0.05);
  });

  it("preserves autonomous flag", () => {
    const state = createMockPipelineState({ autonomous: true });
    writePipelineState(state, TEST_DIR);

    const read = readPipelineState(TEST_DIR);
    expect(read!.autonomous).toBe(true);
  });
});
