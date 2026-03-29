/**
 * Regression: pipeline.ts writeTodoState wiring — verifies that runPipeline
 * writes TODO state files after each skill that maps to a lifecycle state.
 *
 * Found by /plan-eng-review on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// Mock orchestrator
vi.mock("../src/orchestrator.js", () => ({
  runSkill: vi.fn().mockResolvedValue(undefined),
  runSkillWithInitialPrompt: vi.fn().mockResolvedValue(undefined),
}));

// Mock checkpoint reader
vi.mock("../src/checkpoint.js", () => ({
  readCheckpoint: vi.fn().mockReturnValue(null),
}));

// Mock report builder
vi.mock("../src/report.js", () => ({
  buildReport: vi.fn().mockReturnValue({
    runId: "test",
    skillName: "qa",
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
import { readTodoState } from "../src/todo-state.js";
import type { GaryClawConfig, OrchestratorCallbacks, OrchestratorEvent } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-pipeline-todostate-tmp");

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
  mkdirSync(join(TEST_DIR, ".garyclaw"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("pipeline writeTodoState wiring", () => {
  it("writes TODO state after a skill with lifecycle mapping (qa → qa-complete)", async () => {
    const config = createTestConfig({
      todoTitle: "Fix the broken dashboard",
      instanceName: "worker-1",
    });
    const callbacks = createMockCallbacks();

    await runPipeline(["qa"], config, callbacks);

    // The state file should exist at the parent checkpoint dir level
    const state = readTodoState(join(TEST_DIR, ".garyclaw"), "fix-the-broken-dashboard");
    expect(state).not.toBeNull();
    expect(state!.title).toBe("Fix the broken dashboard");
    expect(state!.state).toBe("qa-complete");
    expect(state!.instanceName).toBe("worker-1");
  });

  it("does NOT write TODO state when todoTitle is not set", async () => {
    const config = createTestConfig(); // no todoTitle
    const callbacks = createMockCallbacks();

    await runPipeline(["qa"], config, callbacks);

    // No todo-state dir should be created
    const todoStateDir = join(TEST_DIR, ".garyclaw", "todo-state");
    expect(existsSync(todoStateDir)).toBe(false);
  });

  it("does NOT write TODO state for skills without lifecycle mapping", async () => {
    const config = createTestConfig({
      todoTitle: "Some task",
    });
    const callbacks = createMockCallbacks();

    // "design-review" has no SKILL_TO_STATE mapping (skillToTodoState returns null)
    // It also has no special dispatch path, so runSkill is called directly
    await runPipeline(["design-review"], config, callbacks);

    const state = readTodoState(join(TEST_DIR, ".garyclaw"), "some-task");
    expect(state).toBeNull();
  });

  it("writes TODO state after each mapped skill in a multi-skill pipeline", async () => {
    const config = createTestConfig({
      todoTitle: "Add auto-merge feature",
      instanceName: "worker-2",
    });
    const callbacks = createMockCallbacks();

    // implement → implemented, then qa → qa-complete
    await runPipeline(["implement", "qa"], config, callbacks);

    // The final state should reflect the last skill's lifecycle state
    const state = readTodoState(join(TEST_DIR, ".garyclaw"), "add-auto-merge-feature");
    expect(state).not.toBeNull();
    // qa runs after implement, so state should be qa-complete
    expect(state!.state).toBe("qa-complete");
  });

  it("uses rootCheckpointDir when set instead of regex-stripped checkpointDir", async () => {
    // Simulate job-runner layout: checkpointDir is nested under jobs/
    const rootDir = join(TEST_DIR, ".garyclaw", "daemons", "worker-1");
    const jobDir = join(rootDir, "jobs", "job-123", "skill-0-qa");
    mkdirSync(jobDir, { recursive: true });

    const config = createTestConfig({
      todoTitle: "Use rootCheckpointDir",
      instanceName: "worker-1",
      checkpointDir: jobDir,
      rootCheckpointDir: rootDir,
    });
    const callbacks = createMockCallbacks();

    await runPipeline(["qa"], config, callbacks);

    // State should be written to rootCheckpointDir, not the regex-stripped path
    const state = readTodoState(rootDir, "use-rootcheckpointdir");
    expect(state).not.toBeNull();
    expect(state!.state).toBe("qa-complete");
  });

  it("falls back to regex stripping when rootCheckpointDir not set", async () => {
    const config = createTestConfig({
      todoTitle: "Regex fallback test",
      instanceName: "worker-1",
      // No rootCheckpointDir — should use regex fallback
    });
    const callbacks = createMockCallbacks();

    await runPipeline(["qa"], config, callbacks);

    // Regex strips skill-N-name from checkpointDir, writing to parent
    const state = readTodoState(join(TEST_DIR, ".garyclaw"), "regex-fallback-test");
    expect(state).not.toBeNull();
    expect(state!.state).toBe("qa-complete");
  });
});
