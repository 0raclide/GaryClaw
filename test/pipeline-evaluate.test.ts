/**
 * Pipeline evaluate integration tests — verifies the evaluate skill dispatch
 * path in executePipelineFrom: buildEvaluatePrompt is called and the resulting
 * prompt is passed to runSkillWithInitialPrompt.
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
vi.mock("../src/checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/checkpoint.js")>();
  return {
    ...actual,
    readCheckpoint: vi.fn().mockReturnValue(null),
  };
});

// Mock report builder
vi.mock("../src/report.js", () => ({
  buildReport: vi.fn().mockReturnValue({
    runId: "test",
    skillName: "evaluate",
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
import type { GaryClawConfig, OrchestratorCallbacks, OrchestratorEvent } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-pipeline-evaluate-tmp");

function createTestConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skillName: "evaluate",
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
  mkdirSync(TEST_DIR, { recursive: true });
  vi.mocked(runSkill).mockReset().mockResolvedValue(undefined);
  vi.mocked(runSkillWithInitialPrompt).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("pipeline evaluate dispatch", () => {
  it("calls buildEvaluatePrompt and dispatches via runSkillWithInitialPrompt", async () => {
    // Create minimal target repo artifacts
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Test Project\n## Architecture\nStuff");

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["evaluate"], config, callbacks);

    // Should use runSkillWithInitialPrompt (via the evaluate branch)
    expect(runSkillWithInitialPrompt).toHaveBeenCalledOnce();
    expect(runSkill).not.toHaveBeenCalled();

    // The prompt should contain evaluate-specific content
    const prompt = vi.mocked(runSkillWithInitialPrompt).mock.calls[0][2];
    expect(prompt).toContain("GaryClaw self-improvement analyst");
    expect(prompt).toContain("Bootstrap Quality");
    expect(prompt).toContain("<improvements>");
  });

  it("evaluate receives previous skills context in pipeline", async () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project");

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    // Run qa → evaluate pipeline
    // qa goes through runSkill (no previous entry, generic skill)
    // evaluate goes through runSkillWithInitialPrompt (evaluate dispatch)
    await runPipeline(["qa", "evaluate"], config, callbacks);

    // qa dispatched via runSkill, evaluate via runSkillWithInitialPrompt
    expect(runSkill).toHaveBeenCalledOnce();
    expect(runSkillWithInitialPrompt).toHaveBeenCalledOnce();

    // evaluate call should have evaluate-specific content
    const evalCall = vi.mocked(runSkillWithInitialPrompt).mock.calls[0];
    expect(evalCall[0].skillName).toBe("evaluate");
    const prompt = evalCall[2];
    expect(prompt).toContain("GaryClaw self-improvement analyst");
  });

  it("evaluate works standalone without previous skills", async () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\n## Tech Stack\nNode.js");

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["evaluate"], config, callbacks);

    expect(runSkillWithInitialPrompt).toHaveBeenCalledOnce();
    const prompt = vi.mocked(runSkillWithInitialPrompt).mock.calls[0][2];
    expect(prompt).toContain("Oracle Performance");
    expect(prompt).toContain("Pipeline Health");
  });

  it("emits pipeline_skill_start and pipeline_skill_complete events", async () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project");

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["evaluate"], config, callbacks);

    const startEvent = callbacks.events.find(
      (e) => e.type === "pipeline_skill_start" && "skillName" in e && e.skillName === "evaluate",
    );
    const completeEvent = callbacks.events.find(
      (e) => e.type === "pipeline_skill_complete" && "skillName" in e && e.skillName === "evaluate",
    );
    expect(startEvent).toBeDefined();
    expect(completeEvent).toBeDefined();
  });

  it("works in full dogfood pipeline: bootstrap → evaluate", async () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test-app", dependencies: { react: "^18" } }),
    );
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap", "evaluate"], config, callbacks);

    expect(runSkillWithInitialPrompt).toHaveBeenCalledTimes(2);

    // First call: bootstrap
    const bootstrapCall = vi.mocked(runSkillWithInitialPrompt).mock.calls[0];
    expect(bootstrapCall[0].skillName).toBe("bootstrap");

    // Second call: evaluate
    const evaluateCall = vi.mocked(runSkillWithInitialPrompt).mock.calls[1];
    expect(evaluateCall[0].skillName).toBe("evaluate");
  });
});
