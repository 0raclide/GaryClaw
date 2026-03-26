/**
 * Pipeline implement integration tests — verifies the implement skill dispatch
 * path in executePipelineFrom: buildImplementPrompt is called with all previous
 * skills, and the resulting prompt is passed to runSkillWithInitialPrompt.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mock orchestrator: runSkill + runSkillWithInitialPrompt
vi.mock("../src/orchestrator.js", () => ({
  runSkill: vi.fn().mockResolvedValue(undefined),
  runSkillWithInitialPrompt: vi.fn().mockResolvedValue(undefined),
}));

// Mock checkpoint reader (returns null — no checkpoint data)
vi.mock("../src/checkpoint.js", () => ({
  readCheckpoint: vi.fn().mockReturnValue(null),
}));

// Mock report builder
vi.mock("../src/report.js", () => ({
  buildReport: vi.fn().mockReturnValue({
    runId: "test",
    skillName: "implement",
    startTime: "",
    endTime: "",
    totalSessions: 0,
    totalTurns: 0,
    estimatedCostUsd: 0,
    issues: [],
    findings: [],
    decisions: [],
    relayPoints: [],
  }),
}));

import { runPipeline } from "../src/pipeline.js";
import { runSkill, runSkillWithInitialPrompt } from "../src/orchestrator.js";
import type { GaryClawConfig, OrchestratorCallbacks, OrchestratorEvent, RunReport } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-pipeline-impl-tmp");
const DESIGNS_DIR = join(TEST_DIR, "docs", "designs");

function createTestConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skillName: "qa",
    projectDir: TEST_DIR,
    maxTurnsPerSegment: 15,
    relayThresholdRatio: 0.85,
    checkpointDir: join(TEST_DIR, ".garyclaw"),
    settingSources: [],
    env: {},
    askTimeoutMs: 5000,
    maxRelaySessions: 10,
    autonomous: true,
    ...overrides,
  };
}

function createMockCallbacks(): OrchestratorCallbacks & { events: OrchestratorEvent[] } {
  const events: OrchestratorEvent[] = [];
  return {
    events,
    onEvent: (event: OrchestratorEvent) => { events.push(event); },
    onAskUser: vi.fn().mockResolvedValue("approve"),
  };
}

beforeEach(() => {
  mkdirSync(DESIGNS_DIR, { recursive: true });
  vi.mocked(runSkill).mockReset().mockResolvedValue(undefined);
  vi.mocked(runSkillWithInitialPrompt).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("pipeline implement dispatch", () => {
  it("calls buildImplementPrompt (not buildContextHandoff) when skillName is implement", async () => {
    writeFileSync(
      join(DESIGNS_DIR, "feature.md"),
      "# Feature Design\n\n## Implementation Order\n1. Build it\n2. Test it",
      "utf-8",
    );

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["implement"], config, callbacks);

    // Should use runSkillWithInitialPrompt (via the implement branch)
    expect(runSkillWithInitialPrompt).toHaveBeenCalledOnce();
    expect(runSkill).not.toHaveBeenCalled();

    // The prompt should contain implement-specific content
    const prompt = vi.mocked(runSkillWithInitialPrompt).mock.calls[0][2];
    expect(prompt).toContain("implementing a reviewed and approved design");
    expect(prompt).toContain("# Feature Design");
    expect(prompt).toContain("## Rules");
  });

  it("passes ALL previous skills to buildImplementPrompt, not just the last one", async () => {
    writeFileSync(
      join(DESIGNS_DIR, "feature.md"),
      "# Feature\n\nSimple design.",
      "utf-8",
    );

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    // Run pipeline: qa → design-review → implement
    // The first two skills will run via runSkill (no prev report for qa)
    // or runSkillWithInitialPrompt (context handoff for design-review)
    await runPipeline(["qa", "design-review", "implement"], config, callbacks);

    // Find the implement call — it should be runSkillWithInitialPrompt
    // The third call should be for implement
    const implCalls = vi.mocked(runSkillWithInitialPrompt).mock.calls.filter(
      (call) => call[0].skillName === "implement",
    );
    expect(implCalls).toHaveLength(1);

    // The implement prompt should contain design doc content
    const prompt = implCalls[0][2];
    expect(prompt).toContain("implementing a reviewed and approved design");
    expect(prompt).toContain("## Rules");
  });

  it("uses runSkillWithInitialPrompt for the implement prompt", async () => {
    writeFileSync(
      join(DESIGNS_DIR, "feature.md"),
      "# Design\n\n## Problem\nNeed feature.",
      "utf-8",
    );

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["implement"], config, callbacks);

    // Should NOT call plain runSkill for implement
    expect(runSkill).not.toHaveBeenCalled();

    // Should call runSkillWithInitialPrompt
    expect(runSkillWithInitialPrompt).toHaveBeenCalled();
    const call = vi.mocked(runSkillWithInitialPrompt).mock.calls[0];
    expect(call[0].skillName).toBe("implement");
  });

  it("non-implement skills use runSkill when no previous report exists", async () => {
    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["qa"], config, callbacks);

    // qa is not implement, and there's no previous skill report
    expect(runSkill).toHaveBeenCalledOnce();
    expect(runSkillWithInitialPrompt).not.toHaveBeenCalled();
  });
});
