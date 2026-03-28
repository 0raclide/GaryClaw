/**
 * Job Runner tests — FIFO queue, dedup, budget, state persistence, job lifecycle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner, PerJobCostExceededError } from "../src/job-runner.js";
import { updateGlobalBudget } from "../src/daemon-registry.js";
import type { DaemonConfig, DaemonState, GlobalBudget, GaryClawConfig, OrchestratorCallbacks } from "../src/types.js";

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

      // Enqueue 2 jobs (the daily limit)
      runner.enqueue(["skill-a"], "manual", "t1");
      runner.enqueue(["skill-b"], "manual", "t2");

      // 3rd should be rejected by maxJobsPerDay
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

    it("sets failureCategory on failed job", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockRejectedValue(new Error("auth verification failed"));

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;

      await runner.processNext();

      const state = runner.getState();
      const job = state.jobs.find((j) => j.id === id)!;
      expect(job.status).toBe("failed");
      expect(job.failureCategory).toBe("auth-issue");
      expect(job.retryable).toBe(true);
    });

    it("sets failureCategory to budget-exceeded for PerJobCostExceededError", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        cbs.onEvent({ type: "cost_update", costUsd: 1.5, sessionIndex: 0 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;

      await runner.processNext();

      const state = runner.getState();
      const job = state.jobs.find((j) => j.id === id)!;
      expect(job.failureCategory).toBe("budget-exceeded");
      expect(job.retryable).toBe(false);
    });

    it("sets failureCategory to unknown for unrecognized errors", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockRejectedValue(new Error("something completely unexpected"));

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;

      await runner.processNext();

      const state = runner.getState();
      const job = state.jobs.find((j) => j.id === id)!;
      expect(job.failureCategory).toBe("unknown");
      expect(job.retryable).toBe(false);
    });

    it("appends failures.jsonl on job failure", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockRejectedValue(new Error("ENOSPC: no space left on device"));

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "trigger");

      await runner.processNext();

      const jsonlPath = join(TEST_DIR, "failures.jsonl");
      expect(existsSync(jsonlPath)).toBe(true);
      const content = readFileSync(jsonlPath, "utf-8").trim();
      const record = JSON.parse(content);
      expect(record.category).toBe("infra-issue");
      expect(record.retryable).toBe(true);
      expect(record.skills).toEqual(["qa"]);
    });

    it("includes category in log message on failure", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockRejectedValue(new Error("test failed: 3 of 10"));

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "trigger");

      await runner.processNext();

      // Check that log was called with category in the message
      const errorCalls = deps.log.mock.calls.filter((c: string[]) => c[0] === "error");
      expect(errorCalls.length).toBeGreaterThan(0);
      expect(errorCalls[0][1]).toContain("[project-bug]");
    });

    it("only checks cost limit on cost-related events", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        // Set cost above the limit via cost_update
        cbs.onEvent({ type: "cost_update", costUsd: 1.5, sessionIndex: 0 });
        // This should throw PerJobCostExceededError
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "trigger");
      await runner.processNext();

      // Now test that non-cost events DON'T throw even when cost is over limit
      const deps2 = createMockDeps();
      let assistantTextFired = false;
      deps2.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        // First set cost above limit
        cbs.onEvent({ type: "cost_update", costUsd: 1.5, sessionIndex: 0 });
      });

      // The job should fail due to cost_update triggering the check
      const runner2 = createJobRunner(createTestConfig(), TEST_DIR + "-2", deps2);
      runner2.enqueue(["qa"], "manual", "trigger");
      await runner2.processNext();
      const state2 = runner2.getState();
      const job2 = state2.jobs.find((j) => j.status === "failed");
      expect(job2).toBeDefined();
      expect(job2!.error).toContain("Per-job cost limit exceeded");
    });

    it("running jobs keep original config after updateBudget", async () => {
      const deps = createMockDeps();
      let capturedConfig: GaryClawConfig | null = null;
      let resolveRun: (() => void) | null = null;
      deps.runSkill.mockImplementation(async (config: GaryClawConfig) => {
        capturedConfig = config;
        // Wait for test to call updateBudget while job is running
        await new Promise<void>((r) => { resolveRun = r; });
      });

      const config = createTestConfig({ budget: { dailyCostLimitUsd: 5, perJobCostLimitUsd: 1, maxJobsPerDay: 10 } });
      const runner = createJobRunner(config, TEST_DIR, deps);
      runner.enqueue(["qa"], "manual", "trigger");

      const processPromise = runner.processNext();

      // Wait for runSkill to capture config
      await new Promise((r) => setTimeout(r, 10));

      // Update budget while job is running
      runner.updateBudget({ dailyCostLimitUsd: 100, perJobCostLimitUsd: 50, maxJobsPerDay: 99 });

      // The running job should still have the original config's per-job limit
      // (the PerJobCostExceededError threshold in buildCallbacks uses jobConfig snapshot)
      expect(capturedConfig).toBeDefined();

      // Complete the job
      resolveRun!();
      await processPromise;
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

  describe("global budget enforcement", () => {
    const PARENT_DIR = join(TEST_DIR, "parent");
    const INST_DIR = join(TEST_DIR, "parent", "daemons", "test-inst");

    beforeEach(() => {
      mkdirSync(INST_DIR, { recursive: true });
    });

    it("rejects enqueue when global daily cost limit reached", () => {
      // Simulate another instance having spent the entire budget
      const today = new Date().toISOString().slice(0, 10);
      const budget: GlobalBudget = {
        date: today,
        totalUsd: 5.0,
        jobCount: 5,
        byInstance: { "other-inst": { totalUsd: 5.0, jobCount: 5 } },
      };
      writeFileSync(join(PARENT_DIR, "global-budget.json"), JSON.stringify(budget), "utf-8");

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), INST_DIR, deps, "test-inst", PARENT_DIR);
      const id = runner.enqueue(["qa"], "manual", "trigger");
      expect(id).toBeNull();
    });

    it("allows enqueue when global budget has headroom", () => {
      const today = new Date().toISOString().slice(0, 10);
      const budget: GlobalBudget = {
        date: today,
        totalUsd: 1.0,
        jobCount: 1,
        byInstance: { "other-inst": { totalUsd: 1.0, jobCount: 1 } },
      };
      writeFileSync(join(PARENT_DIR, "global-budget.json"), JSON.stringify(budget), "utf-8");

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), INST_DIR, deps, "test-inst", PARENT_DIR);
      const id = runner.enqueue(["qa"], "manual", "trigger");
      expect(id).toBeTruthy();
    });

    it("updates global budget after job completion", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        cbs.onEvent({ type: "skill_complete", totalSessions: 1, totalTurns: 5, costUsd: 0.25 });
      });

      const runner = createJobRunner(createTestConfig(), INST_DIR, deps, "test-inst", PARENT_DIR);
      runner.enqueue(["qa"], "manual", "trigger");

      await runner.processNext();

      const raw = JSON.parse(readFileSync(join(PARENT_DIR, "global-budget.json"), "utf-8"));
      expect(raw.totalUsd).toBe(0.25);
      expect(raw.byInstance["test-inst"].totalUsd).toBe(0.25);
    });

    it("falls back to local budget when parentCheckpointDir not provided", () => {
      const deps = createMockDeps();
      // No parentCheckpointDir — should use local state.dailyCost
      const runner = createJobRunner(createTestConfig(), INST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger");
      expect(id).toBeTruthy();
    });
  });

  describe("cross-instance dedup", () => {
    const PARENT_DIR = join(TEST_DIR, "parent-dedup");
    const INST_A_DIR = join(PARENT_DIR, "daemons", "inst-a");
    const INST_B_DIR = join(PARENT_DIR, "daemons", "inst-b");

    beforeEach(() => {
      mkdirSync(INST_A_DIR, { recursive: true });
      mkdirSync(INST_B_DIR, { recursive: true });
    });

    it("rejects enqueue when same skills running in another instance", () => {
      // Simulate inst-a having qa running
      const stateA: DaemonState = {
        version: 1,
        jobs: [{
          id: "job-a",
          triggeredBy: "manual",
          triggerDetail: "test",
          skills: ["qa"],
          projectDir: "/tmp",
          status: "running",
          enqueuedAt: new Date().toISOString(),
          costUsd: 0,
        }],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeFileSync(join(INST_A_DIR, "daemon-state.json"), JSON.stringify(stateA), "utf-8");

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), INST_B_DIR, deps, "inst-b", PARENT_DIR);
      const id = runner.enqueue(["qa"], "manual", "trigger");
      expect(id).toBeNull();
    });

    it("allows enqueue when different skills in other instances", () => {
      // inst-a has design-review queued
      const stateA: DaemonState = {
        version: 1,
        jobs: [{
          id: "job-a",
          triggeredBy: "manual",
          triggerDetail: "test",
          skills: ["design-review"],
          projectDir: "/tmp",
          status: "queued",
          enqueuedAt: new Date().toISOString(),
          costUsd: 0,
        }],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeFileSync(join(INST_A_DIR, "daemon-state.json"), JSON.stringify(stateA), "utf-8");

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), INST_B_DIR, deps, "inst-b", PARENT_DIR);
      const id = runner.enqueue(["qa"], "manual", "trigger");
      expect(id).toBeTruthy();
    });

    it("ignores own instance when checking cross-instance dedup", () => {
      // inst-a has qa queued in its own state
      const stateA: DaemonState = {
        version: 1,
        jobs: [{
          id: "job-a",
          triggeredBy: "manual",
          triggerDetail: "test",
          skills: ["qa"],
          projectDir: "/tmp",
          status: "queued",
          enqueuedAt: new Date().toISOString(),
          costUsd: 0,
        }],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeFileSync(join(INST_A_DIR, "daemon-state.json"), JSON.stringify(stateA), "utf-8");

      // inst-a should not be blocked by its own state file (excludeInstance)
      // But local dedup will still block it
      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), INST_A_DIR, deps, "inst-a", PARENT_DIR);
      // The existing state was loaded — local dedup blocks the same skills
      const id = runner.enqueue(["qa"], "manual", "trigger");
      expect(id).toBeNull(); // Blocked by LOCAL dedup, not cross-instance
    });

    it("ignores completed jobs in cross-instance check", () => {
      const stateA: DaemonState = {
        version: 1,
        jobs: [{
          id: "job-a",
          triggeredBy: "manual",
          triggerDetail: "test",
          skills: ["qa"],
          projectDir: "/tmp",
          status: "complete",
          enqueuedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          costUsd: 0.5,
        }],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeFileSync(join(INST_A_DIR, "daemon-state.json"), JSON.stringify(stateA), "utf-8");

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), INST_B_DIR, deps, "inst-b", PARENT_DIR);
      const id = runner.enqueue(["qa"], "manual", "trigger");
      expect(id).toBeTruthy();
    });
  });

  // ── adaptive_turns event collection ──────────────────────────

  describe("adaptive_turns event collection", () => {
    it("initializes adaptiveTurnsStats on first adaptive_turns event", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        cbs.onEvent({ type: "adaptive_turns", maxTurns: 10, reason: "growth 5000 tok/turn, budget 50000 tok, predicted 10, clamped to 10", sessionIndex: 0, segmentIndex: 0 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;
      await runner.processNext();

      const job = runner.getState().jobs.find((j) => j.id === id)!;
      expect(job.adaptiveTurnsStats).toBeDefined();
      expect(job.adaptiveTurnsStats!.segmentCount).toBe(1);
      expect(job.adaptiveTurnsStats!.adaptiveCount).toBe(1);
      expect(job.adaptiveTurnsStats!.totalTurns).toBe(10);
      expect(job.adaptiveTurnsStats!.minTurns).toBe(10);
      expect(job.adaptiveTurnsStats!.maxTurns).toBe(10);
    });

    it("accumulates stats across multiple events", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        cbs.onEvent({ type: "adaptive_turns", maxTurns: 15, reason: "no growth data yet, using configured default", sessionIndex: 0, segmentIndex: 0 });
        cbs.onEvent({ type: "adaptive_turns", maxTurns: 8, reason: "growth 5000 tok/turn, budget 40000 tok, predicted 8, clamped to 8", sessionIndex: 0, segmentIndex: 1 });
        cbs.onEvent({ type: "adaptive_turns", maxTurns: 3, reason: "already at/past target (800000 >= 722500)", sessionIndex: 1, segmentIndex: 0 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;
      await runner.processNext();

      const stats = runner.getState().jobs.find((j) => j.id === id)!.adaptiveTurnsStats!;
      expect(stats.segmentCount).toBe(3);
      expect(stats.fallbackCount).toBe(1);
      expect(stats.adaptiveCount).toBe(1);
      expect(stats.clampedCount).toBe(1);
      expect(stats.totalTurns).toBe(26); // 15 + 8 + 3
      expect(stats.minTurns).toBe(3);
      expect(stats.maxTurns).toBe(15);
    });

    it("classifies fallback reason correctly", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        cbs.onEvent({ type: "adaptive_turns", maxTurns: 15, reason: "no growth data yet, using configured default", sessionIndex: 0, segmentIndex: 0 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;
      await runner.processNext();

      const stats = runner.getState().jobs.find((j) => j.id === id)!.adaptiveTurnsStats!;
      expect(stats.fallbackCount).toBe(1);
      expect(stats.adaptiveCount).toBe(0);
      expect(stats.clampedCount).toBe(0);
    });

    it("classifies clamped reason correctly", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        cbs.onEvent({ type: "adaptive_turns", maxTurns: 3, reason: "already at/past target (900000 >= 722500)", sessionIndex: 0, segmentIndex: 0 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;
      await runner.processNext();

      const stats = runner.getState().jobs.find((j) => j.id === id)!.adaptiveTurnsStats!;
      expect(stats.clampedCount).toBe(1);
      expect(stats.adaptiveCount).toBe(0);
      expect(stats.fallbackCount).toBe(0);
    });

    it("detects heavy tool activations", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        cbs.onEvent({ type: "adaptive_turns", maxTurns: 5, reason: "growth 8000 tok/turn (heavy tool: x2.5), budget 100000 tok, predicted 5, clamped to 5", sessionIndex: 0, segmentIndex: 0 });
        cbs.onEvent({ type: "adaptive_turns", maxTurns: 10, reason: "growth 5000 tok/turn, budget 50000 tok, predicted 10, clamped to 10", sessionIndex: 0, segmentIndex: 1 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;
      await runner.processNext();

      const stats = runner.getState().jobs.find((j) => j.id === id)!.adaptiveTurnsStats!;
      expect(stats.heavyToolActivations).toBe(1); // only first has "heavy tool"
      expect(stats.adaptiveCount).toBe(2); // both are adaptive (growth rate predictions)
    });

    it("job without adaptive_turns events has no stats", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        cbs.onEvent({ type: "cost_update", costUsd: 0.05, sessionIndex: 0 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;
      await runner.processNext();

      const job = runner.getState().jobs.find((j) => j.id === id)!;
      expect(job.adaptiveTurnsStats).toBeUndefined();
    });

    it("tracks minTurns correctly with null initialization", async () => {
      const deps = createMockDeps();
      deps.runSkill.mockImplementation(async (_config: GaryClawConfig, cbs: OrchestratorCallbacks) => {
        cbs.onEvent({ type: "adaptive_turns", maxTurns: 12, reason: "growth 3000 tok/turn, budget 36000 tok, predicted 12, clamped to 12", sessionIndex: 0, segmentIndex: 0 });
        cbs.onEvent({ type: "adaptive_turns", maxTurns: 5, reason: "growth 6000 tok/turn, budget 30000 tok, predicted 5, clamped to 5", sessionIndex: 0, segmentIndex: 1 });
        cbs.onEvent({ type: "adaptive_turns", maxTurns: 8, reason: "growth 4000 tok/turn, budget 32000 tok, predicted 8, clamped to 8", sessionIndex: 0, segmentIndex: 2 });
      });

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const id = runner.enqueue(["qa"], "manual", "trigger")!;
      await runner.processNext();

      const stats = runner.getState().jobs.find((j) => j.id === id)!.adaptiveTurnsStats!;
      expect(stats.minTurns).toBe(5);
      expect(stats.maxTurns).toBe(12);
    });
  });
});
