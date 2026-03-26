/**
 * Job Runner tests — FIFO queue, dedup, budget, state persistence, job lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner, PerJobCostExceededError } from "../src/job-runner.js";
import type { DaemonConfig, DaemonState, GaryClawConfig, OrchestratorCallbacks } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-jobrunner-tmp");

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

describe("Job Runner", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("enqueue", () => {
    it("enqueues a job and returns job ID", () => {
      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      const id = runner.enqueue(["qa"], "manual", "CLI trigger");
      expect(id).toBeTruthy();
      expect(id).toMatch(/^job-/);
    });

    it("persists state after enqueue", () => {
      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      runner.enqueue(["qa"], "manual", "CLI trigger");

      const state = JSON.parse(readFileSync(join(TEST_DIR, "daemon-state.json"), "utf-8"));
      expect(state.jobs).toHaveLength(1);
      expect(state.jobs[0].status).toBe("queued");
      expect(state.jobs[0].skills).toEqual(["qa"]);
    });

    it("deduplicates same skills already queued", () => {
      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      const id1 = runner.enqueue(["qa"], "manual", "trigger1");
      const id2 = runner.enqueue(["qa"], "manual", "trigger2");
      expect(id1).toBeTruthy();
      expect(id2).toBeNull();
    });

    it("allows different skills to be queued", () => {
      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      const id1 = runner.enqueue(["qa"], "manual", "t1");
      const id2 = runner.enqueue(["design-review"], "manual", "t2");
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
    });

    it("rejects when max jobs per day reached", () => {
      const config = createTestConfig({ budget: { dailyCostLimitUsd: 100, perJobCostLimitUsd: 10, maxJobsPerDay: 2 } });
      const runner = createJobRunner(config, TEST_DIR, createMockDeps());

      // Manually set the daily job count to the limit
      const state = runner.getState();
      state.dailyCost.jobCount = 2;

      const id = runner.enqueue(["qa"], "manual", "trigger");
      expect(id).toBeNull();
    });

    it("rejects when daily cost limit reached", () => {
      const config = createTestConfig({ budget: { dailyCostLimitUsd: 1, perJobCostLimitUsd: 0.5, maxJobsPerDay: 100 } });
      const runner = createJobRunner(config, TEST_DIR, createMockDeps());

      const state = runner.getState();
      state.dailyCost.totalUsd = 1.0;

      const id = runner.enqueue(["qa"], "manual", "trigger");
      expect(id).toBeNull();
    });

    it("multi-skill pipeline enqueue", () => {
      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      const id = runner.enqueue(["qa", "design-review", "ship"], "git_poll", "HEAD changed to abc123");
      expect(id).toBeTruthy();

      const state = runner.getState();
      const job = state.jobs.find((j) => j.id === id);
      expect(job!.skills).toEqual(["qa", "design-review", "ship"]);
      expect(job!.triggeredBy).toBe("git_poll");
    });
  });

  describe("processNext", () => {
    it("processes queued job via runSkill for single skill", async () => {
      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "trigger");

      await runner.processNext();

      expect(deps.runSkill).toHaveBeenCalledOnce();
      const config = deps.runSkill.mock.calls[0][0] as GaryClawConfig;
      expect(config.skillName).toBe("qa");
      expect(config.autonomous).toBe(true);
    });

    it("processes queued job via runPipeline for multiple skills", async () => {
      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa", "ship"], "manual", "trigger");

      await runner.processNext();

      expect(deps.runPipeline).toHaveBeenCalledOnce();
      expect(deps.runPipeline.mock.calls[0][0]).toEqual(["qa", "ship"]);
    });

    it("marks job as complete on success", async () => {
      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;

      await runner.processNext();

      const state = runner.getState();
      const job = state.jobs.find((j) => j.id === id)!;
      expect(job.status).toBe("complete");
      expect(job.completedAt).toBeTruthy();
    });

    it("marks job as failed on error", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockRejectedValue(new Error("SDK crash"));
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;

      await runner.processNext();

      const state = runner.getState();
      const job = state.jobs.find((j) => j.id === id)!;
      expect(job.status).toBe("failed");
      expect(job.error).toBe("SDK crash");
    });

    it("calls notifyJobComplete on success", async () => {
      const deps = createMockDeps();
      const config = createTestConfig();
      config.notifications.enabled = true;
      config.notifications.onComplete = true;
      const runner = createJobRunner(config, TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "trigger");

      await runner.processNext();

      expect(deps.notifyJobComplete).toHaveBeenCalledOnce();
    });

    it("calls notifyJobError on failure", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockRejectedValue(new Error("boom"));
      const config = createTestConfig();
      config.notifications.enabled = true;
      config.notifications.onError = true;
      const runner = createJobRunner(config, TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "trigger");

      await runner.processNext();

      expect(deps.notifyJobError).toHaveBeenCalledOnce();
    });

    it("writes summary on completion", async () => {
      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "trigger");

      await runner.processNext();

      expect(deps.writeSummary).toHaveBeenCalledOnce();
    });

    it("does nothing when no jobs queued", async () => {
      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      await runner.processNext();

      expect(deps.runSkill).not.toHaveBeenCalled();
      expect(deps.runPipeline).not.toHaveBeenCalled();
    });

    it("processes jobs in FIFO order", async () => {
      const deps = createMockDeps();
      const order: string[] = [];
      deps.runSkill.mockImplementation(async (config: GaryClawConfig) => {
        order.push(config.skillName);
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "t1");
      runner.enqueue(["design-review"], "manual", "t2");

      await runner.processNext();
      await runner.processNext();

      expect(order).toEqual(["qa", "design-review"]);
    });

    it("does not process concurrently (isRunning guard)", async () => {
      const deps = createMockDeps();
      let resolveRun: (() => void) | null = null;
      deps.runSkill.mockImplementation(() => new Promise<void>((r) => { resolveRun = r; }));

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "t1");
      runner.enqueue(["ship"], "manual", "t2");

      // Start processing first job (won't complete yet)
      const p1 = runner.processNext();
      expect(runner.isRunning()).toBe(true);

      // Try processing second job while first is running
      await runner.processNext();
      expect(deps.runSkill).toHaveBeenCalledTimes(1); // Only the first job

      // Complete first job
      resolveRun!();
      await p1;
      expect(runner.isRunning()).toBe(false);
    });

    it("tracks cost from events", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        cbs.onEvent({ type: "cost_update", costUsd: 0.05, sessionIndex: 0 });
        cbs.onEvent({ type: "skill_complete", totalSessions: 1, totalTurns: 10, costUsd: 0.1 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;

      await runner.processNext();

      const state = runner.getState();
      const job = state.jobs.find((j) => j.id === id)!;
      expect(job.costUsd).toBe(0.1);
    });

    it("fails job when per-job cost limit exceeded", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        // Report cost that exceeds the per-job limit ($1)
        cbs.onEvent({ type: "cost_update", costUsd: 1.5, sessionIndex: 0 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;

      await runner.processNext();

      const state = runner.getState();
      const job = state.jobs.find((j) => j.id === id)!;
      expect(job.status).toBe("failed");
      expect(job.error).toContain("Per-job cost limit exceeded");
    });

    it("updates daily cost after completion", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        cbs.onEvent({ type: "skill_complete", totalSessions: 1, totalTurns: 5, costUsd: 0.25 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "trigger");

      await runner.processNext();

      const state = runner.getState();
      expect(state.dailyCost.totalUsd).toBe(0.25);
      expect(state.dailyCost.jobCount).toBe(1);
    });
  });

  describe("state persistence", () => {
    it("loads existing state on creation", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [
          {
            id: "job-old",
            triggeredBy: "manual",
            triggerDetail: "old",
            skills: ["qa"],
            projectDir: "/tmp",
            status: "complete",
            enqueuedAt: "2026-01-01T00:00:00Z",
            completedAt: "2026-01-01T01:00:00Z",
            costUsd: 0.5,
          },
        ],
        dailyCost: { date: "2026-03-25", totalUsd: 0.5, jobCount: 1 },
      };
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");

      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      expect(runner.getState().jobs).toHaveLength(1);
      expect(runner.getState().jobs[0].id).toBe("job-old");
    });

    it("marks stale running jobs as failed on restart", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [
          {
            id: "job-stale",
            triggeredBy: "manual",
            triggerDetail: "stale",
            skills: ["qa"],
            projectDir: "/tmp",
            status: "running",
            enqueuedAt: "2026-01-01T00:00:00Z",
            startedAt: "2026-01-01T00:00:01Z",
            costUsd: 0,
          },
        ],
        dailyCost: { date: "2026-03-25", totalUsd: 0, jobCount: 0 },
      };
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");

      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      const staleJob = runner.getState().jobs[0];
      expect(staleJob.status).toBe("failed");
      expect(staleJob.error).toContain("restarted");
    });

    it("handles corrupt state file gracefully", () => {
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, "daemon-state.json"), "not json", "utf-8");

      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      expect(runner.getState().jobs).toEqual([]);
    });

    it("starts fresh when no state file exists", () => {
      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      const state = runner.getState();
      expect(state.version).toBe(1);
      expect(state.jobs).toEqual([]);
    });
  });

  describe("updateBudget", () => {
    it("applies new budget limits to subsequent enqueue checks", () => {
      const config = createTestConfig({ budget: { dailyCostLimitUsd: 5, perJobCostLimitUsd: 1, maxJobsPerDay: 1 } });
      const runner = createJobRunner(config, TEST_DIR, createMockDeps());

      // First enqueue succeeds
      const id1 = runner.enqueue(["qa"], "manual", "t1");
      expect(id1).toBeTruthy();

      // Second enqueue blocked by maxJobsPerDay=1
      const state = runner.getState();
      state.dailyCost.jobCount = 1;
      const id2 = runner.enqueue(["ship"], "manual", "t2");
      expect(id2).toBeNull();

      // Update budget to allow more jobs
      runner.updateBudget({ dailyCostLimitUsd: 10, perJobCostLimitUsd: 2, maxJobsPerDay: 5 });
      const id3 = runner.enqueue(["ship"], "manual", "t3");
      expect(id3).toBeTruthy();
    });
  });

  describe("daily reset", () => {
    it("resets daily counters on new day", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [],
        dailyCost: { date: "2026-03-24", totalUsd: 4.5, jobCount: 9 },
      };
      mkdirSync(TEST_DIR, { recursive: true });
      writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");

      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      // Enqueueing triggers a daily check with today's date
      const id = runner.enqueue(["qa"], "manual", "trigger");
      expect(id).toBeTruthy(); // Should succeed because daily counters reset
    });
  });
});
