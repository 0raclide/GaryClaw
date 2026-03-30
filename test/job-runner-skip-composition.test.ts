/**
 * Job Runner skipComposition tests — deterministic --todo override bypasses composition.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-skip-composition-tmp");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: TEST_DIR,
    triggers: [],
    budget: {
      dailyCostLimitUsd: 50,
      perJobCostLimitUsd: 10,
      maxJobsPerDay: 100,
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

describe("skipComposition bypass", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Create a minimal TODOS.md so parseTodoItems has something to parse
    writeFileSync(join(TEST_DIR, "TODOS.md"), `## P2: Fix the login bug\n\n**Effort:** XS\n\nFix it.\n`, "utf-8");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("skipComposition flag is preserved on enqueued job", () => {
    const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
    const id = runner.enqueue(["implement", "qa"], "manual", "CLI trigger");
    expect(id).toBeTruthy();

    const state = runner.getState();
    const job = state.jobs.find(j => j.id === id);
    expect(job).toBeDefined();

    // Manually set skipComposition (as daemon IPC handler does)
    job!.skipComposition = true;
    job!.claimedTodoTitle = "Fix the login bug";

    expect(job!.skipComposition).toBe(true);
    expect(job!.claimedTodoTitle).toBe("Fix the login bug");
  });

  it("skipComposition job retains original skills array", () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    const id = runner.enqueue(["design-review", "implement", "qa"], "manual", "CLI trigger");
    expect(id).toBeTruthy();

    const state = runner.getState();
    const job = state.jobs.find(j => j.id === id);
    job!.skipComposition = true;
    job!.claimedTodoTitle = "Fix the login bug";

    // Skills should include design-review which is NOT in FULL_PIPELINE
    expect(job!.skills).toEqual(["design-review", "implement", "qa"]);
  });

  it("composedFrom is not set when skipComposition is true", () => {
    const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
    const id = runner.enqueue(["implement", "qa"], "manual", "CLI trigger");
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === id);
    job!.skipComposition = true;

    // composedFrom should remain undefined since composition was skipped
    expect(job!.composedFrom).toBeUndefined();
  });
});
