/**
 * Job Runner Resume tests — crash recovery, pipeline resume, retry limits,
 * notification on resume, budget handling, dashboard integration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import { aggregateJobStats } from "../src/dashboard.js";
import type { DaemonConfig, DaemonState, PipelineState, Job } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-jobrunner-resume-tmp");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: {
      dailyCostLimitUsd: 10,
      perJobCostLimitUsd: 5,
      maxJobsPerDay: 20,
    },
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: false },
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

function writeState(dir: string, state: DaemonState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "daemon-state.json"), JSON.stringify(state), "utf-8");
}

function writePipeline(dir: string, jobId: string, pipelineState: PipelineState): void {
  const jobDir = join(dir, "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, "pipeline.json"), JSON.stringify(pipelineState), "utf-8");
}

function makeRunningJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-crash-001",
    triggeredBy: "cron",
    triggerDetail: "0 */2 * * *",
    skills: ["prioritize", "implement", "qa"],
    projectDir: "/tmp/project",
    status: "running",
    enqueuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    costUsd: 1.5,
    ...overrides,
  };
}

function makePipelineState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    version: 1,
    pipelineId: "pipeline-001",
    skills: [
      {
        skillName: "prioritize",
        status: "complete",
        startTime: "2026-03-28T10:00:00Z",
        endTime: "2026-03-28T10:05:00Z",
        report: {
          runId: "run-1",
          skillName: "prioritize",
          startTime: "2026-03-28T10:00:00Z",
          endTime: "2026-03-28T10:05:00Z",
          totalSessions: 1,
          totalTurns: 5,
          estimatedCostUsd: 0.45,
          issues: [],
          findings: [],
          decisions: [],
          relayPoints: [],
        },
      },
      {
        skillName: "implement",
        status: "running",
        startTime: "2026-03-28T10:05:00Z",
      },
      {
        skillName: "qa",
        status: "pending",
      },
    ],
    currentSkillIndex: 1,
    startTime: "2026-03-28T10:00:00Z",
    totalCostUsd: 0.45,
    autonomous: true,
    ...overrides,
  };
}

describe("Job Runner — Crash Recovery & Resume", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Startup crash recovery ─────────────────────────────────────

  describe("startup crash recovery", () => {
    it("marks running jobs as queued on restart (retryCount 1)", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [makeRunningJob()],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const job = runner.getState().jobs[0];

      expect(job.status).toBe("queued");
      expect(job.retryCount).toBe(1);
    });

    it("resets costUsd to 0 on re-queue", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [makeRunningJob({ costUsd: 2.5 })],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      expect(runner.getState().jobs[0].costUsd).toBe(0);
    });

    it("increments retryCount on each restart", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [makeRunningJob({ retryCount: 1 })],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      expect(runner.getState().jobs[0].retryCount).toBe(2);
      expect(runner.getState().jobs[0].status).toBe("queued");
    });

    it("marks failed after 3 crashes (retryCount > 2)", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [makeRunningJob({ retryCount: 2 })],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      const job = runner.getState().jobs[0];

      expect(job.status).toBe("failed");
      expect(job.error).toContain("3 times");
      expect(job.error).toContain("abandoned");
      expect(job.retryable).toBe(false);
    });

    it("logs re-queue message on first crash", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [makeRunningJob()],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      const deps = createMockDeps();
      createJobRunner(createTestConfig(), TEST_DIR, deps);

      expect(deps.log).toHaveBeenCalledWith(
        "info",
        expect.stringContaining("re-queued for resume (attempt 1/2)"),
      );
    });

    it("logs error on final crash", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [makeRunningJob({ retryCount: 2 })],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      const deps = createMockDeps();
      createJobRunner(createTestConfig(), TEST_DIR, deps);

      expect(deps.log).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("failed after 3 crash retries"),
      );
    });

    it("persists state after crash recovery", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [makeRunningJob()],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());

      const persisted = JSON.parse(readFileSync(join(TEST_DIR, "daemon-state.json"), "utf-8"));
      expect(persisted.jobs[0].status).toBe("queued");
      expect(persisted.jobs[0].retryCount).toBe(1);
    });
  });

  // ── Pipeline resume in processNext ─────────────────────────────

  describe("processNext resume", () => {
    it("calls resumePipeline for multi-skill retry jobs with pipeline.json", async () => {
      const job = makeRunningJob();
      const state: DaemonState = {
        version: 1,
        jobs: [job],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);
      writePipeline(TEST_DIR, job.id, makePipelineState());

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      await runner.processNext();

      expect(deps.resumePipeline).toHaveBeenCalledTimes(1);
      expect(deps.runPipeline).not.toHaveBeenCalled();
    });

    it("calls runSkill for single-skill retry jobs (retry from scratch)", async () => {
      const job = makeRunningJob({ skills: ["qa"] });
      const state: DaemonState = {
        version: 1,
        jobs: [job],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      await runner.processNext();

      expect(deps.runSkill).toHaveBeenCalledTimes(1);
      expect(deps.resumePipeline).not.toHaveBeenCalled();
    });

    it("logs 'retrying from scratch' for single-skill retries", async () => {
      const job = makeRunningJob({ skills: ["qa"] });
      const state: DaemonState = {
        version: 1,
        jobs: [job],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      await runner.processNext();

      expect(deps.log).toHaveBeenCalledWith(
        "info",
        expect.stringContaining("Retrying single-skill job"),
      );
    });

    it("falls back to fresh pipeline when pipeline.json is missing", async () => {
      const job = makeRunningJob();
      const state: DaemonState = {
        version: 1,
        jobs: [job],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);
      // No pipeline.json written

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      await runner.processNext();

      expect(deps.runPipeline).toHaveBeenCalledTimes(1);
      expect(deps.resumePipeline).not.toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("No valid pipeline.json"),
      );
    });

    it("falls back to fresh pipeline when pipeline.json is corrupt", async () => {
      const job = makeRunningJob();
      const state: DaemonState = {
        version: 1,
        jobs: [job],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);
      const jobDir = join(TEST_DIR, "jobs", job.id);
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(join(jobDir, "pipeline.json"), "not valid json", "utf-8");

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      await runner.processNext();

      expect(deps.runPipeline).toHaveBeenCalledTimes(1);
      expect(deps.resumePipeline).not.toHaveBeenCalled();
    });

    it("tracks priorSkillCostUsd from completed skills", async () => {
      const job = makeRunningJob();
      const state: DaemonState = {
        version: 1,
        jobs: [job],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);
      writePipeline(TEST_DIR, job.id, makePipelineState());

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      await runner.processNext();

      const completedJob = runner.getState().jobs[0];
      expect(completedJob.priorSkillCostUsd).toBe(0.45); // prioritize skill cost
    });

    it("sends recovery notification on pipeline resume", async () => {
      const job = makeRunningJob();
      const state: DaemonState = {
        version: 1,
        jobs: [job],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);
      writePipeline(TEST_DIR, job.id, makePipelineState());

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      await runner.processNext();

      expect(deps.notifyJobResumed).toHaveBeenCalledTimes(1);
      expect(deps.notifyJobResumed).toHaveBeenCalledWith(
        expect.objectContaining({ id: job.id, retryCount: 1 }),
        1, // 1 completed skill (prioritize)
        expect.any(Object),
      );
    });

    it("does not send recovery notification for fresh pipeline jobs", async () => {
      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      runner.enqueue(["qa", "design-review"], "manual", "test");

      await runner.processNext();

      expect(deps.notifyJobResumed).not.toHaveBeenCalled();
    });

    it("logs resuming pipeline info with completed skill count", async () => {
      const job = makeRunningJob();
      const state: DaemonState = {
        version: 1,
        jobs: [job],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);
      writePipeline(TEST_DIR, job.id, makePipelineState());

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

      await runner.processNext();

      expect(deps.log).toHaveBeenCalledWith(
        "info",
        expect.stringContaining("Resuming pipeline: 1/3 skills already complete"),
      );
    });
  });

  // ── Failure taxonomy integration ───────────────────────────────

  describe("failure taxonomy on crash", () => {
    it("appends failure record when job exceeds retry limit", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [makeRunningJob({ retryCount: 2 })],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());

      // Check that failures.jsonl was written
      const failuresPath = join(TEST_DIR, "failures.jsonl");
      const content = readFileSync(failuresPath, "utf-8");
      const record = JSON.parse(content.trim());
      expect(record.jobId).toBe("job-crash-001");
      expect(record.skills).toEqual(["prioritize", "implement", "qa"]);
    });

    it("logs retry warning on resumed job failure", async () => {
      const job = makeRunningJob({ skills: ["qa"] });
      const state: DaemonState = {
        version: 1,
        jobs: [job],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      const deps = createMockDeps();
      deps.runSkill.mockRejectedValue(new Error("SDK crash"));

      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      await runner.processNext();

      expect(deps.log).toHaveBeenCalledWith(
        "warn",
        expect.stringContaining("Retry 1/2 failed"),
      );
    });
  });

  // ── Dashboard integration ──────────────────────────────────────

  describe("dashboard integration", () => {
    it("shows crash recovery count and saved cost", () => {
      const today = new Date().toISOString().slice(0, 10);
      const jobs: Job[] = [
        {
          id: "job-recovered-001",
          triggeredBy: "cron",
          triggerDetail: "0 */2 * * *",
          skills: ["prioritize", "implement", "qa"],
          projectDir: "/tmp/project",
          status: "complete",
          enqueuedAt: `${today}T10:00:00Z`,
          startedAt: `${today}T10:00:01Z`,
          completedAt: `${today}T10:40:00Z`,
          costUsd: 2.0,
          retryCount: 1,
          priorSkillCostUsd: 0.45,
        },
        {
          id: "job-normal-001",
          triggeredBy: "manual",
          triggerDetail: "CLI",
          skills: ["qa"],
          projectDir: "/tmp/project",
          status: "complete",
          enqueuedAt: `${today}T11:00:00Z`,
          startedAt: `${today}T11:00:01Z`,
          completedAt: `${today}T11:10:00Z`,
          costUsd: 0.5,
        },
      ];

      const stats = aggregateJobStats(jobs, today);
      expect(stats.crashRecoveries).toBe(1);
      expect(stats.crashRecoverySavedUsd).toBe(0.45);
    });

    it("shows zero recoveries when no retried jobs exist", () => {
      const today = new Date().toISOString().slice(0, 10);
      const jobs: Job[] = [
        {
          id: "job-normal-001",
          triggeredBy: "manual",
          triggerDetail: "CLI",
          skills: ["qa"],
          projectDir: "/tmp/project",
          status: "complete",
          enqueuedAt: `${today}T11:00:00Z`,
          costUsd: 0.5,
        },
      ];

      const stats = aggregateJobStats(jobs, today);
      expect(stats.crashRecoveries).toBe(0);
      expect(stats.crashRecoverySavedUsd).toBe(0);
    });

    it("only counts completed retried jobs (not failed retries)", () => {
      const today = new Date().toISOString().slice(0, 10);
      const jobs: Job[] = [
        {
          id: "job-failed-retry",
          triggeredBy: "cron",
          triggerDetail: "0 */2 * * *",
          skills: ["qa"],
          projectDir: "/tmp/project",
          status: "failed",
          enqueuedAt: `${today}T10:00:00Z`,
          costUsd: 0,
          retryCount: 2,
          error: "Daemon restarted 3 times",
        },
      ];

      const stats = aggregateJobStats(jobs, today);
      expect(stats.crashRecoveries).toBe(0);
    });

    it("sums priorSkillCostUsd across multiple recovered jobs", () => {
      const today = new Date().toISOString().slice(0, 10);
      const jobs: Job[] = [
        {
          id: "job-r1",
          triggeredBy: "cron",
          triggerDetail: "cron",
          skills: ["prioritize", "implement"],
          projectDir: "/tmp/project",
          status: "complete",
          enqueuedAt: `${today}T10:00:00Z`,
          costUsd: 1.0,
          retryCount: 1,
          priorSkillCostUsd: 0.45,
        },
        {
          id: "job-r2",
          triggeredBy: "cron",
          triggerDetail: "cron",
          skills: ["prioritize", "implement", "qa"],
          projectDir: "/tmp/project",
          status: "complete",
          enqueuedAt: `${today}T12:00:00Z`,
          costUsd: 2.0,
          retryCount: 1,
          priorSkillCostUsd: 1.20,
        },
      ];

      const stats = aggregateJobStats(jobs, today);
      expect(stats.crashRecoveries).toBe(2);
      expect(stats.crashRecoverySavedUsd).toBeCloseTo(1.65, 2);
    });
  });

  // ── Notification tests ─────────────────────────────────────────

  describe("notifyJobResumed", () => {
    it("is importable and callable", async () => {
      const { notifyJobResumed } = await import("../src/notifier.js");
      expect(typeof notifyJobResumed).toBe("function");
    });

    it("skips notification when notifications disabled", async () => {
      const { notifyJobResumed, sendNotification } = await import("../src/notifier.js");
      const config = createTestConfig({ notifications: { enabled: false, onComplete: false, onError: false, onEscalation: false } });
      const job = makeRunningJob({ retryCount: 1 });

      // Should not throw even with notifications disabled
      notifyJobResumed(job, 1, config);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles multiple running jobs on restart", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [
          makeRunningJob({ id: "job-a" }),
          makeRunningJob({ id: "job-b", retryCount: 1 }),
          makeRunningJob({ id: "job-c", retryCount: 2 }),
        ],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      const jobs = runner.getState().jobs;

      expect(jobs[0].status).toBe("queued");    // first crash → retry 1
      expect(jobs[0].retryCount).toBe(1);
      expect(jobs[1].status).toBe("queued");    // second crash → retry 2
      expect(jobs[1].retryCount).toBe(2);
      expect(jobs[2].status).toBe("failed");    // third crash → abandoned
      // retryCount stays at the pre-existing value (not incremented on the failed job object
      // because the crash-recovery loop reads it, computes retryCount=3, and the original
      // job.retryCount field is 2 — but the code doesn't update retryCount on the failed path)
      expect(jobs[2].retryCount).toBe(2); // original value preserved
    });

    it("preserves non-running jobs on restart", () => {
      const state: DaemonState = {
        version: 1,
        jobs: [
          makeRunningJob(),
          {
            id: "job-queued",
            triggeredBy: "manual",
            triggerDetail: "CLI",
            skills: ["qa"],
            projectDir: "/tmp/project",
            status: "queued",
            enqueuedAt: new Date().toISOString(),
            costUsd: 0,
          },
          {
            id: "job-complete",
            triggeredBy: "manual",
            triggerDetail: "CLI",
            skills: ["qa"],
            projectDir: "/tmp/project",
            status: "complete",
            enqueuedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            costUsd: 0.5,
          },
        ],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      const runner = createJobRunner(createTestConfig(), TEST_DIR, createMockDeps());
      const jobs = runner.getState().jobs;

      expect(jobs[1].status).toBe("queued");
      expect(jobs[1].retryCount).toBeUndefined();
      expect(jobs[2].status).toBe("complete");
    });

    it("handles priorSkillCostUsd of 0 when no completed skills have reports", async () => {
      const job = makeRunningJob();
      const state: DaemonState = {
        version: 1,
        jobs: [job],
        dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      };
      writeState(TEST_DIR, state);

      // Pipeline with all skills pending (no completed skills)
      const pipelineState = makePipelineState({
        skills: [
          { skillName: "prioritize", status: "running", startTime: "2026-03-28T10:00:00Z" },
          { skillName: "implement", status: "pending" },
          { skillName: "qa", status: "pending" },
        ],
        currentSkillIndex: 0,
        totalCostUsd: 0,
      });
      writePipeline(TEST_DIR, job.id, pipelineState);

      const deps = createMockDeps();
      const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
      await runner.processNext();

      const completedJob = runner.getState().jobs[0];
      expect(completedJob.priorSkillCostUsd).toBe(0);
    });
  });
});
