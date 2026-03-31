/**
 * Job Runner skill cost collection tests — verifies pipeline_skill_complete events
 * populate Job.skillCosts correctly. This is the data pipeline for per-skill cost
 * attribution in the dashboard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig, GaryClawConfig, OrchestratorCallbacks } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-jr-skillcosts-tmp");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: {
      dailyCostLimitUsd: 50,
      perJobCostLimitUsd: 10,
      maxJobsPerDay: 20,
    },
    notifications: { enabled: false, onComplete: false, onError: false, onEscalation: false },
    orchestrator: {
      maxTurnsPerSegment: 15,
      relayThresholdRatio: 0.85,
      maxRelaySessions: 10,
      askTimeoutMs: 300000,
    },
    logging: { level: "info", retainDays: 7 },
    ...overrides,
  };
}

function createMockDeps() {
  return {
    runPipeline: vi.fn().mockResolvedValue(undefined),
    runSkill: vi.fn().mockResolvedValue(undefined),
    buildSdkEnv: vi.fn().mockReturnValue({ HOME: "/home" }),
    notifyJobComplete: vi.fn(),
    notifyJobError: vi.fn(),
    writeSummary: vi.fn(),
    log: vi.fn(),
  };
}

describe("Job Runner skill cost collection", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("collects skillCosts from pipeline_skill_complete events (multi-skill via runPipeline)", async () => {
    const deps = createMockDeps();
    deps.runPipeline.mockImplementation(async (_skills: string[], _config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
      cbs.onEvent({ type: "pipeline_skill_complete", skillName: "implement", skillIndex: 0, totalSkills: 2, costUsd: 1.50 });
      cbs.onEvent({ type: "pipeline_skill_complete", skillName: "qa", skillIndex: 1, totalSkills: 2, costUsd: 0.80 });
      cbs.onEvent({ type: "skill_complete", totalSessions: 1, totalTurns: 10, costUsd: 2.30 });
    });

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    const id = runner.enqueue(["implement", "qa"], "manual", "trigger")!;
    await runner.processNext();

    const job = runner.getState().jobs.find(j => j.id === id)!;
    expect(job.skillCosts).toEqual({ implement: 1.50, qa: 0.80 });
  });

  it("initializes skillCosts on first event (was undefined before)", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
      cbs.onEvent({ type: "pipeline_skill_complete", skillName: "qa", skillIndex: 0, totalSkills: 1, costUsd: 0.50 });
      cbs.onEvent({ type: "skill_complete", totalSessions: 1, totalTurns: 5, costUsd: 0.50 });
    });

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    const id = runner.enqueue(["qa"], "manual", "trigger")!;
    await runner.processNext();

    const job = runner.getState().jobs.find(j => j.id === id)!;
    expect(job.skillCosts).toBeDefined();
    expect(job.skillCosts!["qa"]).toBe(0.50);
  });

  it("overwrites cost if same skill name emitted twice", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
      // Could happen on pipeline retry — second emission should win
      cbs.onEvent({ type: "pipeline_skill_complete", skillName: "implement", skillIndex: 0, totalSkills: 1, costUsd: 1.00 });
      cbs.onEvent({ type: "pipeline_skill_complete", skillName: "implement", skillIndex: 0, totalSkills: 1, costUsd: 1.75 });
      cbs.onEvent({ type: "skill_complete", totalSessions: 1, totalTurns: 10, costUsd: 1.75 });
    });

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    const id = runner.enqueue(["implement"], "manual", "trigger")!;
    await runner.processNext();

    const job = runner.getState().jobs.find(j => j.id === id)!;
    expect(job.skillCosts!["implement"]).toBe(1.75);
  });

  it("job without pipeline_skill_complete events has no skillCosts", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
      cbs.onEvent({ type: "cost_update", costUsd: 0.50, sessionIndex: 0 });
      cbs.onEvent({ type: "skill_complete", totalSessions: 1, totalTurns: 5, costUsd: 0.50 });
    });

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    const id = runner.enqueue(["qa"], "manual", "trigger")!;
    await runner.processNext();

    const job = runner.getState().jobs.find(j => j.id === id)!;
    expect(job.skillCosts).toBeUndefined();
  });
});
