/**
 * Pipeline bootstrap integration tests — verifies the bootstrap skill dispatch
 * path in executePipelineFrom: buildBootstrapPrompt is called and the resulting
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
    skillName: "bootstrap",
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

const TEST_DIR = join(process.cwd(), ".test-pipeline-bootstrap-tmp");

function createTestConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skillName: "bootstrap",
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

describe("pipeline bootstrap dispatch", () => {
  it("calls buildBootstrapPrompt and dispatches via runSkillWithInitialPrompt", async () => {
    // Create a minimal repo to analyze
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test-app", dependencies: { express: "^4" } }),
    );
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "console.log('hello');");

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    // Should use runSkillWithInitialPrompt (via the bootstrap branch)
    expect(runSkillWithInitialPrompt).toHaveBeenCalledOnce();
    expect(runSkill).not.toHaveBeenCalled();

    // The prompt should contain bootstrap-specific content
    const prompt = vi.mocked(runSkillWithInitialPrompt).mock.calls[0][2];
    expect(prompt).toContain("bootstrap");
    expect(prompt).toContain("Codebase Analysis");
    expect(prompt).toContain("Generate CLAUDE.md");
    expect(prompt).toContain("Generate TODOS.md");
  });

  it("bootstrap prompt omits CLAUDE.md instructions when it already exists", async () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Existing Project");
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "app.ts"), "export {};");

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    const prompt = vi.mocked(runSkillWithInitialPrompt).mock.calls[0][2];
    expect(prompt).not.toContain("Generate CLAUDE.md");
    expect(prompt).toContain("Generate TODOS.md");
  });

  it("bootstrap returns no-op prompt when both artifacts exist", async () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project");
    writeFileSync(join(TEST_DIR, "TODOS.md"), "## P1: Item");

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    const prompt = vi.mocked(runSkillWithInitialPrompt).mock.calls[0][2];
    expect(prompt).toContain("Nothing to bootstrap");
  });

  it("works in a pipeline: bootstrap → prioritize", async () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "pipeline-test" }),
    );
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap", "prioritize"], config, callbacks);

    // Both skills should dispatch via runSkillWithInitialPrompt
    expect(runSkillWithInitialPrompt).toHaveBeenCalledTimes(2);

    // First call should be bootstrap
    const bootstrapCall = vi.mocked(runSkillWithInitialPrompt).mock.calls[0];
    expect(bootstrapCall[0].skillName).toBe("bootstrap");

    // Second call should be prioritize
    const prioritizeCall = vi.mocked(runSkillWithInitialPrompt).mock.calls[1];
    expect(prioritizeCall[0].skillName).toBe("prioritize");
  });
});
