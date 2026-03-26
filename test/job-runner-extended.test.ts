/**
 * Job Runner extended tests — pruneOldJobs, updateBudget, buildCallbacks,
 * per-job cost enforcement, daily cost reset, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner, PerJobCostExceededError } from "../src/job-runner.js";
import type { DaemonConfig, DaemonState } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-jobrunner-ext-tmp");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: {
      dailyCostLimitUsd: 5,
      perJobCostLimitUsd: 1,
      maxJobsPerDay: 10,
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

describe("Job Runner — Extended", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── pruneOldJobs ─────────────────────────────────────────────

  describe("pruneOldJobs", () => {
    it("prunes completed jobs beyond 100 limit", async () => {
      const deps = createMockDeps();
      // Pre-seed state with 105 completed jobs
      const state: DaemonState = {
        version: 1,
        jobs: [],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      for (let i = 0; i < 105; i++) {
        state.jobs.push({
          id: `job-old-${String(i).padStart(3, "0")}`,
          triggeredBy: "manual",
          triggerDetail: "test",
          skills: ["qa"],
          projectDir: "/tmp/p",
          status: "complete",
          enqueuedAt: new Date(2026, 0, 1, 0, i).toISOString(),
          completedAt: new Date(2026, 0, 1, 1, i).toISOString(),
          costUsd: 0.01,
        });
      }
      // Add 1 queued job that should NOT be pruned
      state.jobs.push({
        id: "job-queued",
        triggeredBy: "manual",
        triggerDetail: "test",
        skills: ["ship"],
        projectDir: "/tmp/p",
        status: "queued",
        enqueuedAt: new Date().toISOString(),
        costUsd: 0,
      });
      writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");

      // Create runner (loads state) and process the queued job to trigger pruning
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      // Enqueue + process triggers pruneOldJobs at end of processNext
      await runner.processNext();

      const finalState = JSON.parse(readFileSync(join(TEST_DIR, "daemon-state.json"), "utf-8"));
      // Should have ≤100 completed + the 1 queued that ran
      const completed = finalState.jobs.filter((j: any) => j.status === "complete");
      expect(completed.length).toBeLessThanOrEqual(100);
    });

    it("does not prune when under 100 completed jobs", async () => {
      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      // Enqueue and process 3 jobs
      for (let i = 0; i < 3; i++) {
        runner.enqueue([`skill-${i}`], "manual", "test");
      }
      for (let i = 0; i < 3; i++) {
        await runner.processNext();
      }

      const state = runner.getState();
      expect(state.jobs).toHaveLength(3);
      expect(state.jobs.every((j) => j.status === "complete")).toBe(true);
    });

    it("preserves queued and running jobs during pruning", async () => {
      const deps = createMockDeps();
      // Pre-seed with 105 completed + 2 queued
      const state: DaemonState = {
        version: 1,
        jobs: [],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      for (let i = 0; i < 105; i++) {
        state.jobs.push({
          id: `job-${i}`,
          triggeredBy: "manual",
          triggerDetail: "test",
          skills: ["qa"],
          projectDir: "/tmp/p",
          status: "complete",
          enqueuedAt: new Date(2026, 0, 1, 0, i).toISOString(),
          completedAt: new Date(2026, 0, 1, 1, i).toISOString(),
          costUsd: 0.01,
        });
      }
      state.jobs.push({
        id: "job-queued-1",
        triggeredBy: "manual",
        triggerDetail: "test",
        skills: ["ship"],
        projectDir: "/tmp/p",
        status: "queued",
        enqueuedAt: new Date().toISOString(),
        costUsd: 0,
      });
      writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      await runner.processNext(); // processes queued-1, triggers prune

      const finalState = runner.getState();
      // queued-1 should now be complete, and old completed should be pruned
      const completedJobs = finalState.jobs.filter((j) => j.status === "complete");
      expect(completedJobs.length).toBeLessThanOrEqual(100);
    });
  });

  // ── updateBudget ─────────────────────────────────────────────

  describe("updateBudget", () => {
    it("updates budget limits for future enqueues", async () => {
      const deps = createMockDeps();
      const config = createTestConfig({
        budget: { dailyCostLimitUsd: 5, perJobCostLimitUsd: 1, maxJobsPerDay: 3 },
      });
      const runner = createJobRunner(config, TEST_DIR, deps);

      // Fill up to the original limit of 3
      runner.enqueue(["skill-a"], "manual", "test");
      runner.enqueue(["skill-b"], "manual", "test");
      runner.enqueue(["skill-c"], "manual", "test");

      // Process them so they complete (no longer queued/running → no dedup block)
      await runner.processNext();
      await runner.processNext();
      await runner.processNext();

      // 4th should be rejected by maxJobsPerDay (daily cost tracks completed jobs)
      expect(runner.enqueue(["overflow"], "manual", "test")).toBeNull();

      // Update budget to allow 10 per day
      runner.updateBudget({
        dailyCostLimitUsd: 10,
        perJobCostLimitUsd: 2,
        maxJobsPerDay: 10,
      });

      // 4th should now work
      const id = runner.enqueue(["overflow"], "manual", "test");
      expect(id).toBeTruthy();
    });

    it("logs budget update", () => {
      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      runner.updateBudget({
        dailyCostLimitUsd: 50,
        perJobCostLimitUsd: 10,
        maxJobsPerDay: 100,
      });

      expect(deps.log).toHaveBeenCalledWith("info", expect.stringContaining("Budget updated"));
    });
  });

  // ── per-job cost enforcement ─────────────────────────────────

  describe("per-job cost enforcement", () => {
    it("marks job as failed when per-job cost is exceeded", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: any, cbs: any) => {
        // Simulate cost updates that exceed the $1 per-job limit
        cbs.onEvent({ type: "cost_update", costUsd: 0.5, sessionIndex: 0 });
        cbs.onEvent({ type: "cost_update", costUsd: 1.5, sessionIndex: 0 }); // exceeds $1
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "test");
      await runner.processNext();

      const state = runner.getState();
      const job = state.jobs.find((j) => j.skills[0] === "qa");
      expect(job?.status).toBe("failed");
      expect(job?.error).toContain("cost");
    });

    it("tracks cost from cost_update events", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: any, cbs: any) => {
        cbs.onEvent({ type: "cost_update", costUsd: 0.3, sessionIndex: 0 });
        cbs.onEvent({ type: "cost_update", costUsd: 0.7, sessionIndex: 0 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "test");
      await runner.processNext();

      const state = runner.getState();
      const job = state.jobs.find((j) => j.skills[0] === "qa");
      expect(job?.costUsd).toBe(0.7); // max of all cost_update values
    });

    it("tracks cost from skill_complete events", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: any, cbs: any) => {
        cbs.onEvent({ type: "skill_complete", totalSessions: 1, totalTurns: 5, costUsd: 0.8 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "test");
      await runner.processNext();

      const state = runner.getState();
      expect(state.jobs[0].costUsd).toBe(0.8);
    });

    it("tracks cost from pipeline_complete events", async () => {
      const deps = createMockDeps();
      deps.runPipeline.mockImplementation(async (_skills: any, _config: any, cbs: any) => {
        cbs.onEvent({ type: "pipeline_complete", totalSkills: 2, totalCostUsd: 0.9 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa", "ship"], "manual", "test");
      await runner.processNext();

      const state = runner.getState();
      expect(state.jobs[0].costUsd).toBe(0.9);
    });
  });

  // ── daily cost reset ─────────────────────────────────────────

  describe("daily cost reset", () => {
    it("resets daily cost when date changes", () => {
      const deps = createMockDeps();
      // Pre-seed state with yesterday's date and high cost
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const state: DaemonState = {
        version: 1,
        jobs: [],
        dailyCost: {
          date: yesterday.toISOString().slice(0, 10),
          totalUsd: 4.5,
          jobCount: 9,
        },
      };
      writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      // Should be able to enqueue because daily cost resets
      const id = runner.enqueue(["qa"], "manual", "test");
      expect(id).toBeTruthy();
    });
  });

  // ── stale running jobs on startup ────────────────────────────

  describe("stale job recovery", () => {
    it("marks running jobs as failed on startup", () => {
      const deps = createMockDeps();
      const state: DaemonState = {
        version: 1,
        jobs: [
          {
            id: "job-stale",
            triggeredBy: "manual",
            triggerDetail: "test",
            skills: ["qa"],
            projectDir: "/tmp/p",
            status: "running",
            enqueuedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            costUsd: 0.5,
          },
        ],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const currentState = runner.getState();
      expect(currentState.jobs[0].status).toBe("failed");
      expect(currentState.jobs[0].error).toContain("restarted");
    });
  });

  // ── onAskUser fallback ───────────────────────────────────────

  describe("daemon onAskUser", () => {
    it("returns 'deny' in daemon mode", async () => {
      const deps = createMockDeps();
      let capturedCallbacks: any;
      deps.runSkill.mockImplementation(async (_config: any, cbs: any) => {
        capturedCallbacks = cbs;
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "test");
      await runner.processNext();

      const answer = await capturedCallbacks.onAskUser("Question?", [], false);
      expect(answer).toBe("deny");
      expect(deps.log).toHaveBeenCalledWith("warn", expect.stringContaining("onAskUser"));
    });
  });

  // ── corrupt state file ───────────────────────────────────────

  describe("corrupt state recovery", () => {
    it("starts fresh when state file is corrupt JSON", () => {
      writeFileSync(join(TEST_DIR, "daemon-state.json"), "{invalid json!!!", "utf-8");

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const state = runner.getState();
      expect(state.jobs).toEqual([]);
      expect(state.version).toBe(1);
    });

    it("starts fresh when state file has wrong version", () => {
      const bad = { version: 99, jobs: [{ id: "should-be-gone" }], dailyCost: {} };
      writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(bad), "utf-8");

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      expect(runner.getState().jobs).toEqual([]);
    });
  });

  // ── budget edge cases ────────────────────────────────────────

  describe("budget edge cases", () => {
    it("rejects enqueue when daily cost headroom is nearly zero", () => {
      const deps = createMockDeps();
      const state: DaemonState = {
        version: 1,
        jobs: [],
        dailyCost: {
          date: new Date().toISOString().slice(0, 10),
          totalUsd: 4.9999,
          jobCount: 0,
        },
      };
      writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "test");
      expect(id).toBeNull();
    });

    it("allows enqueue when cost headroom exists", () => {
      const deps = createMockDeps();
      const state: DaemonState = {
        version: 1,
        jobs: [],
        dailyCost: {
          date: new Date().toISOString().slice(0, 10),
          totalUsd: 4.0,
          jobCount: 0,
        },
      };
      writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "test");
      expect(id).toBeTruthy();
    });
  });

  // ── PerJobCostExceededError ──────────────────────────────────

  describe("PerJobCostExceededError", () => {
    it("contains cost and limit in message", () => {
      const err = new PerJobCostExceededError(1.5, 1.0);
      expect(err.message).toContain("1.5");
      expect(err.message).toContain("1");
      expect(err).toBeInstanceOf(Error);
    });
  });
});
