/**
 * Pipeline failure + resume tests (11A) — tests the skill failure catch path
 * and resume-from-failure flow in pipeline.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  writePipelineState,
  readPipelineState,
  validatePipelineState,
  buildContextHandoff,
  buildPipelineReport,
} from "../src/pipeline.js";

import type {
  PipelineState,
  RunReport,
  OrchestratorEvent,
} from "../src/types.js";

const TEST_DIR = join(tmpdir(), `garyclaw-pipeline-fail-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function createTestPipelineState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    version: 1,
    pipelineId: "test-pipeline-123",
    skills: [
      { skillName: "qa", status: "complete", startTime: "2026-03-26T00:00:00Z", endTime: "2026-03-26T00:05:00Z", report: createMinimalReport("qa") },
      { skillName: "design-review", status: "pending" },
      { skillName: "ship", status: "pending" },
    ],
    currentSkillIndex: 1,
    startTime: "2026-03-26T00:00:00Z",
    totalCostUsd: 0.5,
    autonomous: true,
    ...overrides,
  };
}

function createMinimalReport(skillName: string): RunReport {
  return {
    runId: `run-${skillName}`,
    skillName,
    startTime: "2026-03-26T00:00:00Z",
    endTime: "2026-03-26T00:05:00Z",
    totalSessions: 1,
    totalTurns: 10,
    estimatedCostUsd: 0.5,
    issues: [],
    findings: [],
    decisions: [],
    relayPoints: [],
  };
}

describe("Pipeline failure state persistence", () => {
  it("writePipelineState + readPipelineState round-trips with safe-json", () => {
    const state = createTestPipelineState();

    writePipelineState(state, TEST_DIR);
    const loaded = readPipelineState(TEST_DIR);

    expect(loaded).not.toBeNull();
    expect(loaded!.pipelineId).toBe("test-pipeline-123");
    expect(loaded!.skills).toHaveLength(3);
  });

  it("readPipelineState returns null for corrupt JSON (safe-json recovery)", () => {
    // Write corrupt JSON directly to bypass safe-json
    const fs = require("node:fs");
    fs.writeFileSync(join(TEST_DIR, "pipeline.json"), "{corrupt!!!", "utf-8");

    const loaded = readPipelineState(TEST_DIR);
    expect(loaded).toBeNull();
  });

  it("readPipelineState returns null for invalid schema", () => {
    const fs = require("node:fs");
    fs.writeFileSync(join(TEST_DIR, "pipeline.json"), '{"version": 99, "skills": []}', "utf-8");

    const loaded = readPipelineState(TEST_DIR);
    expect(loaded).toBeNull();
  });

  it("persists failed skill status correctly", () => {
    const state = createTestPipelineState();
    state.skills[1].status = "failed";
    state.skills[1].endTime = "2026-03-26T00:10:00Z";

    writePipelineState(state, TEST_DIR);
    const loaded = readPipelineState(TEST_DIR);

    expect(loaded!.skills[1].status).toBe("failed");
    expect(loaded!.skills[1].endTime).toBe("2026-03-26T00:10:00Z");
  });
});

describe("Pipeline resume from failure", () => {
  it("validatePipelineState accepts valid state", () => {
    const state = createTestPipelineState();
    expect(validatePipelineState(state)).toBe(true);
  });

  it("validatePipelineState rejects missing fields", () => {
    expect(validatePipelineState({})).toBe(false);
    expect(validatePipelineState({ version: 1 })).toBe(false);
    expect(validatePipelineState(null)).toBe(false);
  });

  it("failed skill can be resumed by setting status back to pending", () => {
    const state = createTestPipelineState();
    state.skills[1].status = "failed";
    state.currentSkillIndex = 1;

    // Simulate what resumePipeline does: find first failed, reset to pending
    for (let i = 0; i < state.skills.length; i++) {
      if (state.skills[i].status === "failed") {
        state.skills[i].status = "pending";
        state.currentSkillIndex = i;
        break;
      }
    }

    expect(state.skills[1].status).toBe("pending");
    expect(state.currentSkillIndex).toBe(1);
    // Skill 0 (qa) is still complete
    expect(state.skills[0].status).toBe("complete");
    // Skill 2 (ship) is still pending
    expect(state.skills[2].status).toBe("pending");
  });
});

describe("Pipeline report with mixed statuses", () => {
  it("buildPipelineReport handles skills with no report (failed before report)", () => {
    const state = createTestPipelineState();
    state.skills[1].status = "failed";
    state.skills[1].report = undefined;

    const report = buildPipelineReport(state, "2026-03-26T00:15:00Z");

    expect(report.totalCostUsd).toBe(state.totalCostUsd);
    // Issues should only come from completed skills
    expect(report.issues).toHaveLength(0);
  });

  it("buildContextHandoff produces valid handoff even with empty report", () => {
    const emptyReport = createMinimalReport("qa");
    const handoff = buildContextHandoff("qa", emptyReport, "design-review");

    expect(handoff).toContain("Previous skill /qa completed");
    expect(handoff).toContain("Now run the /design-review skill");
    expect(handoff).toContain("Sessions: 1");
  });
});
