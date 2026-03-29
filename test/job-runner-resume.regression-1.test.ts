/**
 * Regression: ISSUE-001 — abandoned job FailureRecord had retryable: true
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * buildFailureRecord classified "daemon restarted" as retryable via classifyError,
 * but the job itself was abandoned (retryable: false). The audit trail was inconsistent.
 * Fix: override record.retryable = false after buildFailureRecord returns.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig, DaemonState, Job } from "../src/types.js";
import { vi } from "vitest";

const TEST_DIR = join(process.cwd(), ".test-resume-reg1-tmp");

function createTestConfig(): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: { dailyCostLimitUsd: 10, perJobCostLimitUsd: 5, maxJobsPerDay: 20 },
    notifications: { enabled: false, onComplete: false, onError: false, onEscalation: false },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
    logging: { level: "info", retainDays: 7 },
  };
}

function makeAbandonedJob(): Job {
  return {
    id: "job-abandoned-001",
    triggeredBy: "cron",
    triggerDetail: "0 */2 * * *",
    skills: ["prioritize", "implement"],
    projectDir: "/tmp/project",
    status: "running",
    enqueuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    costUsd: 1.0,
    retryCount: 2, // Next restart makes it 3 → abandoned
  };
}

describe("ISSUE-001: abandoned job failure record retryable consistency", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("writes failures.jsonl with retryable: false for abandoned jobs", () => {
    const state: DaemonState = {
      version: 1,
      jobs: [makeAbandonedJob()],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
    };
    mkdirSync(TEST_DIR, { recursive: true });
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");

    const deps = {
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

    createJobRunner(createTestConfig(), TEST_DIR, deps);

    // The job should be marked failed
    const persisted = JSON.parse(readFileSync(join(TEST_DIR, "daemon-state.json"), "utf-8"));
    expect(persisted.jobs[0].status).toBe("failed");
    expect(persisted.jobs[0].retryable).toBe(false);

    // The failures.jsonl should also have retryable: false
    const failuresPath = join(TEST_DIR, "failures.jsonl");
    expect(existsSync(failuresPath)).toBe(true);

    const lines = readFileSync(failuresPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.retryable).toBe(false);
    expect(record.category).toBe("infra-issue");
    expect(record.jobId).toBe("job-abandoned-001");
    expect(record.errorMessage).toContain("abandoned");
  });

  it("Job.retryable and FailureRecord.retryable always agree for abandoned jobs", () => {
    const state: DaemonState = {
      version: 1,
      jobs: [makeAbandonedJob()],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
    };
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");

    const deps = {
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

    createJobRunner(createTestConfig(), TEST_DIR, deps);

    const persisted = JSON.parse(readFileSync(join(TEST_DIR, "daemon-state.json"), "utf-8"));
    const job = persisted.jobs[0];

    const failuresPath = join(TEST_DIR, "failures.jsonl");
    const record = JSON.parse(readFileSync(failuresPath, "utf-8").trim());

    // The invariant: both agree
    expect(job.retryable).toBe(record.retryable);
  });
});
