/**
 * Regression: ISSUE-002 — rate_limited jobs not handled in crash-resume loop.
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * On daemon restart, only 'running' jobs were recovered. If the daemon crashed
 * with rate_limited jobs AND rateLimitResetAt was lost, those jobs sat permanently.
 * Now the startup loop re-queues rate_limited jobs as a safety net.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig, DaemonState, Job } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-resume-ratelimited-tmp");

function createTestConfig(): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: { dailyCostLimitUsd: 100, perJobCostLimitUsd: 50, maxJobsPerDay: 100 },
    notifications: { enabled: false, onComplete: false, onError: false, onEscalation: false },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
    logging: { level: "info", retainDays: 7 },
  };
}

function writeState(state: DaemonState): void {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, "daemon-state.json"), JSON.stringify(state), "utf-8");
}

function readState(): DaemonState {
  return JSON.parse(readFileSync(join(TEST_DIR, "daemon-state.json"), "utf-8"));
}

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("crash-resume recovers rate_limited jobs", () => {
  it("re-queues rate_limited jobs on startup", () => {
    const rateLimitedJob: Job = {
      id: "job-rl-001",
      triggeredBy: "cron",
      triggerDetail: "test",
      skills: ["qa"],
      projectDir: "/tmp/project",
      status: "rate_limited",
      enqueuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      costUsd: 2.5,
    };

    writeState({
      version: 1,
      instanceName: "default",
      status: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      jobs: [rateLimitedJob],
      // rateLimitResetAt intentionally missing — simulates corruption
    });

    const logMessages: string[] = [];
    createJobRunner(createTestConfig(), TEST_DIR, {
      log: (_level: string, msg: string) => logMessages.push(msg),
    });

    const state = readState();
    const recovered = state.jobs.find((j: Job) => j.id === "job-rl-001");
    expect(recovered?.status).toBe("queued");
    expect(recovered?.costUsd).toBe(0);
    expect(logMessages.some((m: string) => m.includes("rate_limited") && m.includes("re-queued"))).toBe(true);
  });

  it("resets costUsd to 0 on rate_limited recovery", () => {
    writeState({
      version: 1,
      instanceName: "default",
      status: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      jobs: [{
        id: "job-rl-002",
        triggeredBy: "manual",
        triggerDetail: "test",
        skills: ["implement"],
        projectDir: "/tmp/project",
        status: "rate_limited",
        enqueuedAt: new Date().toISOString(),
        costUsd: 4.2,
      }],
    });

    createJobRunner(createTestConfig(), TEST_DIR);

    const state = readState();
    expect(state.jobs[0].costUsd).toBe(0);
  });
});
