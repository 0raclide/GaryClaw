/**
 * Job Runner cross-cycle dedup tests — verifies pre-assignment skips TODOs
 * already completed by other daemon instances in prior cycles.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig, DaemonState, Job } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-crosscycle-tmp");
const PARENT_DIR = join(TEST_DIR, "parent");
const INSTANCE_DIR = join(PARENT_DIR, "daemons", "worker-1");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: TEST_DIR,
    triggers: [],
    budget: {
      dailyCostLimitUsd: 100,
      perJobCostLimitUsd: 10,
      maxJobsPerDay: 50,
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
    notifyMergeBlocked: vi.fn(),
    writeSummary: vi.fn(),
    log: vi.fn(),
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    triggeredBy: "manual",
    triggerDetail: "test",
    skills: ["prioritize", "implement", "qa"],
    projectDir: TEST_DIR,
    status: "queued",
    enqueuedAt: new Date().toISOString(),
    costUsd: 0,
    ...overrides,
  };
}

function makeState(jobs: Job[]): DaemonState {
  return {
    version: 1,
    jobs,
    dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
  };
}

function writeInstanceState(instanceName: string, state: DaemonState): void {
  const dir = join(PARENT_DIR, "daemons", instanceName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "daemon-state.json"), JSON.stringify(state), "utf-8");
}

function writeTodosMd(content: string): void {
  writeFileSync(join(TEST_DIR, "TODOS.md"), content, "utf-8");
}

const TODOS_CONTENT = `# TODOS

## P2: Fix auto-merge dirty tree
**Effort:** S
**Depends on:** nothing

## P2: Add cross-cycle dedup
**Effort:** S
**Depends on:** nothing

## P2: Improve dashboard stats
**Effort:** M
**Depends on:** nothing
`;

describe("Job Runner cross-cycle dedup", () => {
  beforeEach(() => {
    mkdirSync(INSTANCE_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("pre-assignment skips TODOs completed by other instances", async () => {
    // worker-2 already completed "Fix auto-merge dirty tree"
    writeInstanceState("worker-2", makeState([
      makeJob({
        status: "complete" as const,
        claimedTodoTitle: "Fix auto-merge dirty tree",
        completedAt: new Date().toISOString(),
      }),
    ]));

    writeTodosMd(TODOS_CONTENT);

    const deps = createMockDeps();
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
      "worker-1",
      PARENT_DIR,
    );

    // Enqueue a pipeline with prioritize
    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    // The pre-assignment should have picked "Add cross-cycle dedup" (2nd item),
    // skipping "Fix auto-merge dirty tree" (completed by worker-2)
    const logCalls = deps.log.mock.calls.map((c: string[]) => c.join(" "));
    const dedupLog = logCalls.find((msg: string) => msg.includes("Cross-cycle dedup"));
    expect(dedupLog).toBeTruthy();
    expect(dedupLog).toContain("1 already-completed TODO(s) excluded");

    const preAssignLog = logCalls.find((msg: string) => msg.includes("Pre-assigned TODO"));
    expect(preAssignLog).toBeTruthy();
    // Should pick the second item since first is completed by another instance
    expect(preAssignLog).toContain("Add cross-cycle dedup");
  });

  it("pre-assignment skips TODOs claimed by running instances (existing behavior preserved)", async () => {
    // worker-2 is currently working on "Fix auto-merge dirty tree" with DIFFERENT skills
    // (different skill set so cross-instance skill dedup doesn't block enqueue)
    writeInstanceState("worker-2", makeState([
      makeJob({
        skills: ["prioritize", "implement"],
        status: "running" as const,
        claimedTodoTitle: "Fix auto-merge dirty tree",
      }),
    ]));

    writeTodosMd(TODOS_CONTENT);

    const deps = createMockDeps();
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
      "worker-1",
      PARENT_DIR,
    );

    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    const logCalls = deps.log.mock.calls.map((c: string[]) => c.join(" "));
    const preAssignLog = logCalls.find((msg: string) => msg.includes("Pre-assigned TODO"));
    expect(preAssignLog).toBeTruthy();
    // Should pick the second item since first is claimed by running worker-2
    expect(preAssignLog).toContain("Add cross-cycle dedup");
  });

  it("pre-assignment logs cross-cycle dedup count", async () => {
    // Multiple completed items across instances
    writeInstanceState("worker-2", makeState([
      makeJob({ status: "complete" as const, claimedTodoTitle: "Fix auto-merge dirty tree", completedAt: new Date().toISOString() }),
      makeJob({ id: "job-002", status: "complete" as const, claimedTodoTitle: "Add cross-cycle dedup", completedAt: new Date().toISOString() }),
    ]));

    writeTodosMd(TODOS_CONTENT);

    const deps = createMockDeps();
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
      "worker-1",
      PARENT_DIR,
    );

    runner.enqueue(["prioritize"], "manual", "test");
    await runner.processNext();

    const logCalls = deps.log.mock.calls.map((c: string[]) => c.join(" "));
    const dedupLog = logCalls.find((msg: string) => msg.includes("Cross-cycle dedup"));
    expect(dedupLog).toContain("2 already-completed TODO(s) excluded");
  });

  it("pre-assignment still works when no completed titles exist", async () => {
    // No other instances have completed anything
    writeTodosMd(TODOS_CONTENT);

    const deps = createMockDeps();
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
      "worker-1",
      PARENT_DIR,
    );

    runner.enqueue(["prioritize"], "manual", "test");
    await runner.processNext();

    const logCalls = deps.log.mock.calls.map((c: string[]) => c.join(" "));
    // No cross-cycle dedup log (0 completed titles — log is skipped)
    const dedupLog = logCalls.find((msg: string) => msg.includes("Cross-cycle dedup"));
    expect(dedupLog).toBeUndefined();

    // Should still pre-assign the first item
    const preAssignLog = logCalls.find((msg: string) => msg.includes("Pre-assigned TODO"));
    expect(preAssignLog).toBeTruthy();
    expect(preAssignLog).toContain("Fix auto-merge dirty tree");
  });
});
