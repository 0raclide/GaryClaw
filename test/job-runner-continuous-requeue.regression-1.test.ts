/**
 * Regression: continuous re-enqueue must use composedFrom (original skills),
 * not the trimmed skills array after adaptive pipeline composition.
 *
 * Bug: When composePipeline trims e.g. ["prioritize","office-hours","implement","qa"]
 * to ["prioritize","implement","qa"], the re-enqueue used the trimmed set. Subsequent
 * cycles never ran office-hours again. Fix: read composedFrom ?? skills.
 *
 * Found by /qa on 2026-03-30
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";

const TEST_DIR = join(process.cwd(), ".test-continuous-requeue-tmp");
const PARENT_DIR = join(TEST_DIR, "parent");

function createTestConfig() {
  return {
    version: 1 as const,
    projectDir: "/tmp/project",
    triggers: [] as [],
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
    logging: { level: "info" as const, retainDays: 7 },
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
    notifyRateLimitHold: vi.fn(),
    notifyRateLimitResume: vi.fn(),
    writeSummary: vi.fn(),
    log: vi.fn(),
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(PARENT_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Continuous re-enqueue uses composedFrom (original skills)", () => {
  it("re-enqueues with composedFrom skills when pipeline was composed", async () => {
    const deps = createMockDeps();
    const originalSkills = ["prioritize", "office-hours", "implement", "qa"];
    const composedSkills = ["prioritize", "implement", "qa"]; // office-hours trimmed

    // Pipeline completes with cost (triggers re-enqueue)
    deps.runPipeline.mockImplementation(
      async (_skills: unknown, _config: unknown, callbacks: { onEvent?: (e: unknown) => void }) => {
        callbacks?.onEvent?.({ type: "cost_update", costUsd: 1.50 });
      },
    );

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(originalSkills, "manual", "test");

    // Simulate what job-runner does after composePipeline: skills get trimmed,
    // but composedFrom preserves the original set
    const state = runner.getState();
    const job = state.jobs.find(j => j.status === "queued")!;
    job.composedFrom = originalSkills;
    job.skills = composedSkills;

    await runner.processNext();

    const postState = runner.getState();
    const queuedJobs = postState.jobs.filter(j => j.status === "queued");
    expect(queuedJobs.length).toBe(1);
    // The re-enqueued job should have the ORIGINAL skills, not the trimmed ones
    expect(queuedJobs[0].skills).toEqual(originalSkills);
  });

  it("falls back to skills when composedFrom is not set", async () => {
    const deps = createMockDeps();
    const skills = ["prioritize", "implement", "qa"];

    deps.runPipeline.mockImplementation(
      async (_skills: unknown, _config: unknown, callbacks: { onEvent?: (e: unknown) => void }) => {
        callbacks?.onEvent?.({ type: "cost_update", costUsd: 0.80 });
      },
    );

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(skills, "manual", "test");
    await runner.processNext();

    const postState = runner.getState();
    const queuedJobs = postState.jobs.filter(j => j.status === "queued");
    expect(queuedJobs.length).toBe(1);
    // No composedFrom → re-enqueue uses skills directly
    expect(queuedJobs[0].skills).toEqual(skills);
  });

  it("does NOT re-enqueue composed pipeline missing prioritize in original", async () => {
    const deps = createMockDeps();
    // Original set has no prioritize → no continuous re-enqueue
    const originalSkills = ["implement", "qa"];
    const composedSkills = ["implement", "qa"];

    deps.runPipeline.mockImplementation(
      async (_skills: unknown, _config: unknown, callbacks: { onEvent?: (e: unknown) => void }) => {
        callbacks?.onEvent?.({ type: "cost_update", costUsd: 1.00 });
      },
    );

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(originalSkills, "manual", "test");

    const state = runner.getState();
    const job = state.jobs.find(j => j.status === "queued")!;
    job.composedFrom = originalSkills;
    job.skills = composedSkills;

    await runner.processNext();

    const postState = runner.getState();
    const queuedJobs = postState.jobs.filter(j => j.status === "queued");
    // No re-enqueue because original skills don't include "prioritize"
    expect(queuedJobs.length).toBe(0);
  });
});
