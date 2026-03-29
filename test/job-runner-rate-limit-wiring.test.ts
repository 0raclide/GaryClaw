/**
 * Rate limit wiring tests — time-gate in processNext, rate limit detection
 * in error handler, rate_limited status in dedup, cross-instance coordination.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import { safeWriteJSON, safeReadJSON } from "../src/safe-json.js";
import type { DaemonConfig, DaemonState, GlobalBudget, GaryClawConfig, OrchestratorCallbacks } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-ratelimit-wiring-tmp");
const PARENT_DIR = join(TEST_DIR, "parent");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
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

describe("Rate limit time-gate in processNext", () => {
  it("blocks job processing when rateLimitResetAt is in the future", async () => {
    // Write state with a rate limit hold 10 minutes in the future
    const futureReset = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const stateData: DaemonState = {
      version: 1,
      jobs: [
        {
          id: "job-held",
          triggeredBy: "manual",
          triggerDetail: "test",
          skills: ["qa"],
          projectDir: "/tmp/project",
          status: "rate_limited",
          enqueuedAt: new Date().toISOString(),
          costUsd: 0,
        },
      ],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      rateLimitResetAt: futureReset,
    };
    safeWriteJSON(join(TEST_DIR, "daemon-state.json"), stateData);

    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    await runner.processNext();

    // Job should NOT have been started
    expect(deps.runSkill).not.toHaveBeenCalled();
    expect(deps.runPipeline).not.toHaveBeenCalled();
  });

  it("clears hold and re-queues rate_limited jobs when reset time passes", async () => {
    // Write state with a rate limit hold in the past
    const pastReset = new Date(Date.now() - 1000).toISOString();
    const stateData: DaemonState = {
      version: 1,
      jobs: [
        {
          id: "job-held",
          triggeredBy: "manual",
          triggerDetail: "test",
          skills: ["qa"],
          projectDir: "/tmp/project",
          status: "rate_limited",
          enqueuedAt: new Date().toISOString(),
          costUsd: 0,
        },
      ],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      rateLimitResetAt: pastReset,
    };
    safeWriteJSON(join(TEST_DIR, "daemon-state.json"), stateData);

    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    // processNext should clear the hold, re-queue, then run
    await runner.processNext();

    // Job should have been started (re-queued from rate_limited → queued → running)
    expect(deps.runSkill).toHaveBeenCalled();

    // State should show hold cleared
    const state = runner.getState();
    expect(state.rateLimitResetAt).toBeUndefined();
  });

  it("sends resume notification when hold expires", async () => {
    const pastReset = new Date(Date.now() - 1000).toISOString();
    const stateData: DaemonState = {
      version: 1,
      jobs: [
        {
          id: "job-held",
          triggeredBy: "manual",
          triggerDetail: "test",
          skills: ["qa"],
          projectDir: "/tmp/project",
          status: "rate_limited",
          enqueuedAt: new Date().toISOString(),
          costUsd: 0,
        },
      ],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      rateLimitResetAt: pastReset,
    };
    safeWriteJSON(join(TEST_DIR, "daemon-state.json"), stateData);

    const deps = createMockDeps();
    createJobRunner(createTestConfig(), TEST_DIR, deps);

    // Resume notification is sent on hold expiry during processNext
    // But the hold check happens at processNext time, not at construction
    // Let's trigger processNext
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    await runner.processNext();

    expect(deps.notifyRateLimitResume).toHaveBeenCalled();
  });
});

describe("Rate limit detection in error handler", () => {
  it("sets rate_limited status on rate limit infra-issue", async () => {
    const deps = createMockDeps();
    // Make runSkill throw a rate limit error
    deps.runSkill.mockRejectedValue(new Error("Rate limit exceeded — try again in 15 minutes"));

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    const job = state.jobs.find(j => j.id !== undefined);
    expect(job).toBeDefined();
    expect(job!.status).toBe("rate_limited");
    expect(state.rateLimitResetAt).toBeDefined();
  });

  it("uses 30-min fallback when reset time is unparseable", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockRejectedValue(new Error("Rate limit exceeded"));

    const beforeMs = Date.now();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    expect(state.rateLimitResetAt).toBeDefined();
    const resetMs = new Date(state.rateLimitResetAt!).getTime();
    // Should be ~30 minutes from now
    expect(resetMs).toBeGreaterThanOrEqual(beforeMs + 29 * 60 * 1000);
    expect(resetMs).toBeLessThanOrEqual(beforeMs + 31 * 60 * 1000);
  });

  it("does not set rate_limited for non-rate-limit errors", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockRejectedValue(new Error("Some other error"));

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    const job = state.jobs[0];
    expect(job.status).toBe("failed");
    expect(state.rateLimitResetAt).toBeUndefined();
  });

  it("sends rate limit hold notification", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockRejectedValue(new Error("HTTP 429 Too Many Requests — try again in 20 minutes"));

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(deps.notifyRateLimitHold).toHaveBeenCalled();
    // Should NOT send normal error notification
    expect(deps.notifyJobError).not.toHaveBeenCalled();
  });
});

describe("rate_limited status in dedup", () => {
  it("rate_limited jobs block re-enqueue of same skills", () => {
    // Pre-populate state with a rate_limited job
    const stateData: DaemonState = {
      version: 1,
      jobs: [
        {
          id: "job-rl",
          triggeredBy: "manual",
          triggerDetail: "test",
          skills: ["qa"],
          projectDir: "/tmp/project",
          status: "rate_limited",
          enqueuedAt: new Date().toISOString(),
          costUsd: 0,
        },
      ],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      rateLimitResetAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    safeWriteJSON(join(TEST_DIR, "daemon-state.json"), stateData);

    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    const id = runner.enqueue(["qa"], "manual", "duplicate");
    expect(id).toBeNull(); // Blocked by dedup
  });
});

describe("Cross-instance rate limit hold via global budget", () => {
  it("blocks processNext when global budget has active rateLimitResetAt", async () => {
    // Write global budget with a future rate limit hold
    const futureReset = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    safeWriteJSON(join(PARENT_DIR, "global-budget.json"), {
      date: new Date().toISOString().slice(0, 10),
      totalUsd: 0,
      jobCount: 0,
      byInstance: {},
      rateLimitResetAt: futureReset,
    } satisfies GlobalBudget);

    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps, "worker-1", PARENT_DIR);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    // Job should NOT have been started
    expect(deps.runSkill).not.toHaveBeenCalled();
  });

  it("propagates rate limit hold to global budget on detection", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockRejectedValue(new Error("Rate limit exceeded — try again in 15 minutes"));

    // Initialize global budget
    safeWriteJSON(join(PARENT_DIR, "global-budget.json"), {
      date: new Date().toISOString().slice(0, 10),
      totalUsd: 0,
      jobCount: 0,
      byInstance: {},
    } satisfies GlobalBudget);

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps, "worker-1", PARENT_DIR);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    // Global budget should now have rateLimitResetAt set
    const budget = safeReadJSON<GlobalBudget>(join(PARENT_DIR, "global-budget.json"));
    expect(budget).not.toBeNull();
    expect(budget!.rateLimitResetAt).toBeDefined();
  });
});

describe("Rate limit hold persists across daemon restart", () => {
  it("rateLimitResetAt survives state reload", () => {
    const futureReset = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const stateData: DaemonState = {
      version: 1,
      jobs: [],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
      rateLimitResetAt: futureReset,
    };
    safeWriteJSON(join(TEST_DIR, "daemon-state.json"), stateData);

    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    const state = runner.getState();
    expect(state.rateLimitResetAt).toBe(futureReset);
  });
});
