/**
 * Regression: ISSUE-001 — "adaptive disabled" misclassified as adaptive segment
 * Found by /qa on 2026-03-28
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md
 *
 * Bug: When --no-adaptive flag is used, orchestrator emits reason "adaptive disabled".
 * Job runner's reason string classifier had no match for this, so it fell through
 * to the else branch and incorrectly incremented adaptiveCount instead of fallbackCount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig, GaryClawConfig, OrchestratorCallbacks } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-jobrunner-regression-3");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: {
      dailyCostLimitUsd: 50,
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
    runSkill: vi.fn().mockResolvedValue(undefined),
    buildSdkEnv: vi.fn().mockReturnValue({ HOME: "/home" }),
    notify: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    runReflection: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Regression: 'adaptive disabled' reason string classification", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("counts 'adaptive disabled' as fallback, not adaptive", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
      cbs.onEvent({ type: "adaptive_turns", maxTurns: 15, reason: "adaptive disabled", sessionIndex: 0, segmentIndex: 0 });
      cbs.onEvent({ type: "adaptive_turns", maxTurns: 15, reason: "adaptive disabled", sessionIndex: 0, segmentIndex: 1 });
    });

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    const id = runner.enqueue(["qa"], "manual", "trigger")!;
    await runner.processNext();

    const job = runner.getState().jobs.find((j) => j.id === id)!;
    expect(job.adaptiveTurnsStats).toBeDefined();
    expect(job.adaptiveTurnsStats!.fallbackCount).toBe(2);
    expect(job.adaptiveTurnsStats!.adaptiveCount).toBe(0);
    expect(job.adaptiveTurnsStats!.segmentCount).toBe(2);
  });

  it("distinguishes 'adaptive disabled' from real adaptive segments", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
      cbs.onEvent({ type: "adaptive_turns", maxTurns: 15, reason: "adaptive disabled", sessionIndex: 0, segmentIndex: 0 });
      cbs.onEvent({ type: "adaptive_turns", maxTurns: 8, reason: "growth 5000 tok/turn, budget 50000 tok, predicted 8, clamped to 8", sessionIndex: 0, segmentIndex: 1 });
      cbs.onEvent({ type: "adaptive_turns", maxTurns: 15, reason: "no growth data yet, using configured default", sessionIndex: 1, segmentIndex: 0 });
    });

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    const id = runner.enqueue(["qa"], "manual", "trigger")!;
    await runner.processNext();

    const stats = runner.getState().jobs.find((j) => j.id === id)!.adaptiveTurnsStats!;
    expect(stats.fallbackCount).toBe(2); // "adaptive disabled" + "no growth data"
    expect(stats.adaptiveCount).toBe(1); // real adaptive
    expect(stats.clampedCount).toBe(0);
    expect(stats.segmentCount).toBe(3);
  });

  it("counts 'adaptive disabled' segments in min/max correctly", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
      cbs.onEvent({ type: "adaptive_turns", maxTurns: 15, reason: "adaptive disabled", sessionIndex: 0, segmentIndex: 0 });
    });

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    const id = runner.enqueue(["qa"], "manual", "trigger")!;
    await runner.processNext();

    const stats = runner.getState().jobs.find((j) => j.id === id)!.adaptiveTurnsStats!;
    expect(stats.minTurns).toBe(15);
    expect(stats.maxTurns).toBe(15);
    expect(stats.totalTurns).toBe(15);
  });
});
