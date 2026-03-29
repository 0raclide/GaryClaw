/**
 * Regression: ISSUE-003 — costUsd not reset when re-queuing rate-limited jobs.
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * When a rate-limited job's hold expired, the job was re-queued with its old costUsd,
 * causing double-counting when the job ran again. The crash recovery path already
 * reset costUsd = 0 (line 161), but the rate-limit path didn't.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeWriteJSON } from "../src/safe-json.js";
import type { DaemonState, DaemonConfig } from "../src/types.js";
import { createJobRunner } from "../src/job-runner.js";

const BASE = join(tmpdir(), `garyclaw-ratelimit-cost-${Date.now()}`);

function makeConfig(): DaemonConfig {
  return {
    version: 1,
    projectDir: BASE,
    triggers: [],
    budget: { dailyCostLimitUsd: 100, perJobCostLimitUsd: 50, maxJobsPerDay: 100 },
    notifications: { enabled: false, onComplete: false, onError: false, onEscalation: false },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
    logging: { level: "info", retainDays: 7 },
  };
}

beforeEach(() => mkdirSync(BASE, { recursive: true }));
afterEach(() => rmSync(BASE, { recursive: true, force: true }));

describe("rate-limit re-queue costUsd reset", () => {
  it("resets costUsd to 0 when hold expires and job is re-queued", async () => {
    // Seed state: one rate_limited job with $5 cost, hold already expired
    const pastReset = new Date(Date.now() - 1000).toISOString();
    const state = {
      version: 1,
      instanceName: "default",
      status: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      jobs: [{
        id: "job-rate-001",
        triggeredBy: "manual",
        triggerDetail: "test",
        skills: ["qa"],
        projectDir: BASE,
        status: "rate_limited",
        enqueuedAt: new Date(Date.now() - 60000).toISOString(),
        startedAt: new Date(Date.now() - 30000).toISOString(),
        costUsd: 5.0,
      }],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 5.0, jobCount: 1 },
      rateLimitResetAt: pastReset,
    };

    safeWriteJSON(join(BASE, "daemon-state.json"), state);

    const logs: string[] = [];
    // Make runSkill hang so processNext reaches rate-limit recovery but doesn't finish the job
    let resolveJob: () => void;
    const jobPromise = new Promise<void>((r) => { resolveJob = r; });
    const runSkill = vi.fn().mockImplementation(() => jobPromise.then(() => ({ sessions: [], totalCostUsd: 1.0 })));

    const runner = createJobRunner(makeConfig(), BASE, {
      runPipeline: vi.fn(),
      resumePipeline: vi.fn(),
      runSkill,
      buildSdkEnv: vi.fn().mockReturnValue({}),
      notifyJobComplete: vi.fn(),
      notifyJobError: vi.fn(),
      notifyJobResumed: vi.fn(),
      writeSummary: vi.fn(),
      log: (_level: string, msg: string) => logs.push(msg),
    });

    // Start processNext (will clear rate limit, re-queue, then start running the job)
    const processPromise = runner.processNext();

    // The rate limit hold should be cleared and job re-queued before runSkill is called
    // Wait a tick for the sync portion to complete
    await new Promise((r) => setTimeout(r, 10));

    // Verify rate limit was cleared
    expect(logs.some((l) => l.includes("Rate limit hold expired"))).toBe(true);
    expect(logs.some((l) => l.includes("Re-queued rate-limited job"))).toBe(true);

    // Now let the job finish so processNext completes
    resolveJob!();
    await processPromise;

    // After the job completed, check final state
    const finalState = runner.getState();
    const job = finalState.jobs.find((j) => j.id === "job-rate-001");
    // costUsd was reset to 0 before re-run; the mock doesn't fire cost callbacks,
    // so it stays at 0 (not the original $5). The key assertion: NOT the pre-rate-limit $5.
    expect(job?.costUsd).toBe(0);
    expect(job?.status).toBe("complete");

    // No cleanup needed — runner has no stop method
  });

});
