/**
 * Regression: ISSUE-001 — maxJobsPerDay counted completions not enqueues
 * Found by /qa on 2026-03-26
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-26.md
 *
 * Bug: enqueue() checked dailyCost.jobCount (incremented only on completion)
 * instead of counting actual jobs enqueued today. This allowed unlimited
 * enqueues before any job completed via processNext().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-jobrunner-regression-2");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: {
      dailyCostLimitUsd: 100,
      perJobCostLimitUsd: 10,
      maxJobsPerDay: 3,
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

describe("Regression: maxJobsPerDay counts enqueued jobs, not completed", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("rejects enqueue at limit even when no jobs have completed", () => {
    const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());

    // Enqueue 3 jobs (the limit) without processing any
    expect(runner.enqueue(["skill-a"], "manual", "t1")).toBeTruthy();
    expect(runner.enqueue(["skill-b"], "manual", "t2")).toBeTruthy();
    expect(runner.enqueue(["skill-c"], "manual", "t3")).toBeTruthy();

    // 4th should be rejected — all 3 slots taken by enqueued (not completed) jobs
    expect(runner.enqueue(["skill-d"], "manual", "t4")).toBeNull();
  });

  it("still rejects after some jobs complete via processNext", async () => {
    const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());

    // Enqueue 3 jobs
    runner.enqueue(["skill-a"], "manual", "t1");
    runner.enqueue(["skill-b"], "manual", "t2");
    runner.enqueue(["skill-c"], "manual", "t3");

    // Process one — it completes, but the completed job still counts for today
    await runner.processNext();

    // 4th should still be rejected: 3 jobs enqueued today (1 complete + 2 queued)
    expect(runner.enqueue(["skill-d"], "manual", "t4")).toBeNull();
  });

  it("allows enqueue after updateBudget raises the limit", () => {
    const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());

    // Fill to limit
    runner.enqueue(["skill-a"], "manual", "t1");
    runner.enqueue(["skill-b"], "manual", "t2");
    runner.enqueue(["skill-c"], "manual", "t3");
    expect(runner.enqueue(["overflow"], "manual", "t4")).toBeNull();

    // Raise the limit
    runner.updateBudget({ dailyCostLimitUsd: 100, perJobCostLimitUsd: 10, maxJobsPerDay: 5 });

    // Now should work
    expect(runner.enqueue(["skill-d"], "manual", "t5")).toBeTruthy();
    expect(runner.enqueue(["skill-e"], "manual", "t6")).toBeTruthy();
    expect(runner.enqueue(["skill-f"], "manual", "t7")).toBeNull(); // at new limit of 5
  });
});
