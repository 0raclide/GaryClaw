/**
 * Extended pipeline tests — skill failure handling, buildSkillReport with
 * checkpoint data, context handoff edge cases, formatPipelineReportMarkdown.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  writePipelineState,
  readPipelineState,
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
import type { PipelineState, RunReport, PipelineReport } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-pipeline-ext-tmp");

function createMockPipelineState(
  overrides: Partial<PipelineState> = {},
): PipelineState {
  return {
    version: 1,
    pipelineId: "pipeline-ext-001",
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

describe("pipeline — skill failure state", () => {
  beforeEach(() => {
    resetCounters();
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("persists failed skill status through write/read cycle", () => {
    const state = createMockPipelineState({
      skills: [
        { skillName: "qa", status: "complete", startTime: "2026-03-25T10:00:00Z", endTime: "2026-03-25T10:30:00Z" },
        { skillName: "design-review", status: "failed", startTime: "2026-03-25T10:30:00Z", endTime: "2026-03-25T10:31:00Z" },
        { skillName: "ship", status: "pending" },
      ],
      currentSkillIndex: 1,
    });

    writePipelineState(state, TEST_DIR);
    const loaded = readPipelineState(TEST_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.skills[1].status).toBe("failed");
    expect(loaded!.skills[2].status).toBe("pending");
  });

  it("builds context handoff with accumulated issues and findings", () => {
    const report = createMockRunReport("qa", {
      issues: [createMockIssue({ severity: "critical", description: "Broken login" })],
      findings: [createMockFinding({ description: "Missing error handling" })],
      decisions: [createMockDecision({ question: "Fix login?", chosen: "Yes" })],
    });

    const handoff = buildContextHandoff("qa", report, "design-review");
    expect(handoff).toContain("qa");
    expect(handoff).toContain("Broken login");
  });

  it("builds context handoff with empty report", () => {
    const report = createMockRunReport("qa");
    const handoff = buildContextHandoff("qa", report, "design-review");
    expect(handoff).toContain("qa");
    expect(typeof handoff).toBe("string");
    expect(handoff.length).toBeGreaterThan(0);
  });

  it("builds context handoff with decisions", () => {
    const report = createMockRunReport("qa", {
      decisions: [
        createMockDecision({ question: "Skip tests?", chosen: "No" }),
        createMockDecision({ question: "Fix layout?", chosen: "Yes" }),
      ],
    });

    const handoff = buildContextHandoff("qa", report, "ship");
    expect(handoff).toContain("Skip tests?");
    expect(handoff).toContain("Fix layout?");
  });
});

describe("pipeline — buildPipelineReport", () => {
  beforeEach(() => resetCounters());

  it("builds pipeline report from completed state", () => {
    const state = createMockPipelineState({
      skills: [
        {
          skillName: "qa",
          status: "complete",
          startTime: "2026-03-25T10:00:00Z",
          endTime: "2026-03-25T10:30:00Z",
          report: createMockRunReport("qa", {
            issues: [createMockIssue()],
          }),
        },
        {
          skillName: "design-review",
          status: "complete",
          startTime: "2026-03-25T10:30:00Z",
          endTime: "2026-03-25T11:00:00Z",
          report: createMockRunReport("design-review", {
            findings: [createMockFinding()],
          }),
        },
      ],
      currentSkillIndex: 2,
    });

    const report = buildPipelineReport(state, "2026-03-25T11:00:00Z");
    expect(report.pipelineId).toBe("pipeline-ext-001");
    expect(report.skills).toHaveLength(2);
    expect(report.issues).toHaveLength(1);
    expect(report.findings).toHaveLength(1);
  });

  it("builds pipeline report with failed skills", () => {
    const state = createMockPipelineState({
      skills: [
        {
          skillName: "qa",
          status: "complete",
          startTime: "2026-03-25T10:00:00Z",
          endTime: "2026-03-25T10:30:00Z",
          report: createMockRunReport("qa"),
        },
        {
          skillName: "ship",
          status: "failed",
          startTime: "2026-03-25T10:30:00Z",
          endTime: "2026-03-25T10:31:00Z",
        },
      ],
      currentSkillIndex: 1,
    });

    const report = buildPipelineReport(state, "2026-03-25T10:31:00Z");
    expect(report.skills).toHaveLength(2);
    expect(report.skills[1].status).toBe("failed");
    expect(report.totalCostUsd).toBe(0);
  });

  it("deduplicates issues by id (later skill wins)", () => {
    const state = createMockPipelineState({
      skills: [
        {
          skillName: "qa",
          status: "complete",
          report: createMockRunReport("qa", {
            issues: [createMockIssue({ id: "QA-001", status: "open", description: "Original" })],
          }),
        },
        {
          skillName: "design-review",
          status: "complete",
          report: createMockRunReport("design-review", {
            issues: [createMockIssue({ id: "QA-001", status: "fixed", description: "Fixed" })],
          }),
        },
      ],
    });

    const report = buildPipelineReport(state, "2026-03-25T11:00:00Z");
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].status).toBe("fixed");
    expect(report.issues[0].description).toBe("Fixed");
  });
});

describe("pipeline — formatPipelineReportMarkdown", () => {
  beforeEach(() => resetCounters());

  it("formats pipeline report as markdown", () => {
    const report: PipelineReport = {
      pipelineId: "pipeline-001",
      startTime: "2026-03-25T10:00:00Z",
      endTime: "2026-03-25T11:00:00Z",
      skills: [
        {
          skillName: "qa",
          status: "complete",
          startTime: "2026-03-25T10:00:00Z",
          endTime: "2026-03-25T10:30:00Z",
          report: createMockRunReport("qa", {
            issues: [
              createMockIssue({ severity: "critical", status: "open" }),
              createMockIssue({ severity: "high", status: "fixed" }),
            ],
          }),
        },
      ],
      totalSessions: 2,
      totalTurns: 20,
      totalCostUsd: 0.1,
      issues: [
        createMockIssue({ severity: "critical", status: "open" }),
        createMockIssue({ severity: "high", status: "fixed" }),
      ],
      findings: [],
      decisions: [],
    };

    const md = formatPipelineReportMarkdown(report);
    expect(md).toContain("Pipeline Report");
    expect(md).toContain("qa");
    expect(md).toContain("COMPLETE");
    expect(md).toContain("All Issues");
  });

  it("formats markdown with no issues", () => {
    const report: PipelineReport = {
      pipelineId: "pipeline-002",
      startTime: "2026-03-25T10:00:00Z",
      endTime: "2026-03-25T10:30:00Z",
      skills: [
        { skillName: "qa", status: "complete" },
      ],
      totalSessions: 1,
      totalTurns: 5,
      totalCostUsd: 0.02,
      issues: [],
      findings: [],
      decisions: [],
    };

    const md = formatPipelineReportMarkdown(report);
    expect(md).toContain("Pipeline Report");
    expect(md).not.toContain("All Issues");
  });

  it("includes findings in markdown", () => {
    const report: PipelineReport = {
      pipelineId: "pipeline-003",
      startTime: "2026-03-25T10:00:00Z",
      endTime: "2026-03-25T10:30:00Z",
      skills: [{ skillName: "qa", status: "complete" }],
      totalSessions: 1,
      totalTurns: 5,
      totalCostUsd: 0.02,
      issues: [],
      findings: [createMockFinding({ description: "Needs better error handling" })],
      decisions: [],
    };

    const md = formatPipelineReportMarkdown(report);
    expect(md).toContain("Findings");
    expect(md).toContain("Needs better error handling");
  });
});
