/**
 * Job Runner Validation Gate — wiring tests for priority pick rejection + pipeline abort.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner, PriorityPickExhaustedError } from "../src/job-runner.js";
import type { DaemonConfig, OrchestratorEvent } from "../src/types.js";

// Mock todo-state to prevent git env leak
vi.mock("../src/todo-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/todo-state.js")>();
  return {
    ...actual,
    detectArtifacts: vi.fn().mockReturnValue({
      branchExists: false,
      branchCommitCount: 0,
      commitsOnMain: false,
    }),
  };
});

const TEST_DIR = join(process.cwd(), ".test-jr-valgate-tmp");
const PARENT_DIR = join(TEST_DIR, "parent");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: TEST_DIR,
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
    resumePipeline: vi.fn().mockResolvedValue(undefined),
    runSkill: vi.fn().mockResolvedValue(undefined),
    buildSdkEnv: vi.fn().mockReturnValue({ HOME: "/home" }),
    notifyJobComplete: vi.fn(),
    notifyJobError: vi.fn(),
    notifyJobResumed: vi.fn(),
    writeSummary: vi.fn(),
    log: vi.fn(),
  };
}

describe("Job Runner Validation Gate Wiring", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(PARENT_DIR, { recursive: true });
    // TODOS.md with one completed and one open item
    writeFileSync(join(TEST_DIR, "TODOS.md"), `# TODOS

## ~~P3: Implement Skill Hardening~~ — COMPLETE (2026-03-27)

**What:** Already done.

## P2: Open Feature

**What:** Build this.
`);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("rejects completed pick and falls through to valid alternative", async () => {
    const events: OrchestratorEvent[] = [];
    const config = createTestConfig({
      onEvent: (e: OrchestratorEvent) => events.push(e),
    });
    const deps = createMockDeps();

    // Simulate pipeline that writes priority.md with a completed pick + valid alternative
    deps.runPipeline.mockImplementation(async (_skills: string[], _cfg: any, callbacks: any) => {
      // Write priority.md that picks a completed item with a valid alternative
      const priorityDir = join(TEST_DIR, ".garyclaw");
      mkdirSync(priorityDir, { recursive: true });
      writeFileSync(join(priorityDir, "priority.md"), `## Top Pick: P3: Implement Skill Hardening

### 2nd: P2: Open Feature — Score: 7.5/10
A valid alternative.
`);
      // Fire the pipeline_skill_complete event for prioritize
      if (callbacks?.onEvent) {
        callbacks.onEvent({
          type: "pipeline_skill_complete",
          skillName: "prioritize",
          costUsd: 0.10,
        });
      }
    });

    const runner = createJobRunner(config, TEST_DIR, deps);
    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    // Should have emitted priority_pick_rejected
    const rejected = events.find(e => e.type === "priority_pick_rejected");
    expect(rejected).toBeDefined();
    if (rejected && rejected.type === "priority_pick_rejected") {
      expect(rejected.title).toContain("Implement Skill Hardening");
      expect(rejected.reason).toBe("completed");
    }

    // Should have claimed the alternative
    const state = runner.getState();
    const job = state.jobs[0];
    expect(job.claimedTodoTitle).toBe("P2: Open Feature");
  });

  it("aborts pipeline when all picks are exhausted", async () => {
    const events: OrchestratorEvent[] = [];
    const config = createTestConfig({
      onEvent: (e: OrchestratorEvent) => events.push(e),
    });
    const deps = createMockDeps();

    // TODOS.md has two completed items — both picks match completed titles
    writeFileSync(join(TEST_DIR, "TODOS.md"), `# TODOS

## ~~P3: Implement Skill Hardening~~ — COMPLETE (2026-03-27)

**What:** Already done.

## ~~P2: Daemon Resilience Improvements~~ — COMPLETE (2026-03-28)

**What:** Also done.
`);

    // Simulate pipeline that writes priority.md where all picks match completed items
    deps.runPipeline.mockImplementation(async (_skills: string[], _cfg: any, callbacks: any) => {
      const priorityDir = join(TEST_DIR, ".garyclaw");
      mkdirSync(priorityDir, { recursive: true });
      writeFileSync(join(priorityDir, "priority.md"), `## Top Pick: P3: Implement Skill Hardening

### 2nd: P2: Daemon Resilience Improvements — Score: 6.0/10
Also completed.
`);
      // Fire the pipeline_skill_complete event for prioritize — should throw
      if (callbacks?.onEvent) {
        callbacks.onEvent({
          type: "pipeline_skill_complete",
          skillName: "prioritize",
          costUsd: 0.10,
        });
      }
    });

    const runner = createJobRunner(config, TEST_DIR, deps);
    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    // Should have emitted both rejected and exhausted events
    const exhausted = events.find(e => e.type === "priority_pick_exhausted");
    expect(exhausted).toBeDefined();

    // Job should be marked idle (not failed or complete) — exhaustion is graceful, but did no work
    const state = runner.getState();
    const job = state.jobs[0];
    expect(job.status).toBe("idle");
    expect(job.error).toContain("All priority picks rejected");
  });

  it("PriorityPickExhaustedError is exported and has correct name", () => {
    const err = new PriorityPickExhaustedError();
    expect(err.name).toBe("PriorityPickExhaustedError");
    expect(err.message).toContain("All priority picks rejected");
    expect(err instanceof Error).toBe(true);
  });
});
