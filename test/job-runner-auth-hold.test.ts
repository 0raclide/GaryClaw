/**
 * Auth failure hold + minimum cost guard tests.
 *
 * Verifies that auth failures trigger the rate limit hold mechanism
 * (instead of spinning through 50+ job IDs) and that $0 jobs don't
 * trigger continuous re-enqueue.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner, MIN_COST_FOR_REENQUEUE, RATE_LIMIT_FALLBACK_MS } from "../src/job-runner.js";
import { safeWriteJSON, safeReadJSON } from "../src/safe-json.js";
import type { DaemonState, GlobalBudget } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-auth-hold-tmp");
const PARENT_DIR = join(TEST_DIR, "parent");

function createTestConfig(overrides: Record<string, unknown> = {}) {
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

// ── Auth hold trigger ───────────────────────────────────────────

describe("Auth failure triggers hold mechanism", () => {
  it("sets rate_limited status on auth failure", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockRejectedValue(new Error("Auth verification failed — no session id returned"));

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    const job = state.jobs.find(j => j.status === "rate_limited");
    expect(job).toBeDefined();
    expect(state.rateLimitResetAt).toBeDefined();
  });

  it("uses 30-min fallback hold for auth failures", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockRejectedValue(new Error("Authentication failed"));

    const beforeMs = Date.now();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    expect(state.rateLimitResetAt).toBeDefined();
    const resetMs = new Date(state.rateLimitResetAt!).getTime();
    // Should be ~30 minutes from now (auth errors have no parseable reset time)
    expect(resetMs).toBeGreaterThanOrEqual(beforeMs + RATE_LIMIT_FALLBACK_MS - 1000);
    expect(resetMs).toBeLessThanOrEqual(beforeMs + RATE_LIMIT_FALLBACK_MS + 2000);
  });

  it("sends hold notification instead of error notification for auth failures", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockRejectedValue(new Error("Auth verification failed"));

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    expect(deps.notifyRateLimitHold).toHaveBeenCalled();
    expect(deps.notifyJobError).not.toHaveBeenCalled();
  });

  it("propagates auth hold to global budget for cross-instance coordination", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockRejectedValue(new Error("Auth verification failed — login required"));

    safeWriteJSON(join(PARENT_DIR, "global-budget.json"), {
      date: new Date().toISOString().slice(0, 10),
      totalUsd: 0,
      jobCount: 0,
      byInstance: {},
    } satisfies GlobalBudget);

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps, "worker-1", PARENT_DIR);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const budget = safeReadJSON<GlobalBudget>(join(PARENT_DIR, "global-budget.json"));
    expect(budget).not.toBeNull();
    expect(budget!.rateLimitResetAt).toBeDefined();
  });
});

// ── Rate limit unchanged ────────────────────────────────────────

describe("Existing rate limit behavior unchanged", () => {
  it("rate limit errors still trigger hold (no regression)", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockRejectedValue(new Error("Rate limit exceeded — try again in 15 minutes"));

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    const job = state.jobs.find(j => j.status === "rate_limited");
    expect(job).toBeDefined();
    expect(state.rateLimitResetAt).toBeDefined();
  });

  it("non-auth non-ratelimit errors do NOT trigger hold", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockRejectedValue(new Error("Some random project error"));

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    const job = state.jobs[0];
    expect(job.status).toBe("failed");
    expect(state.rateLimitResetAt).toBeUndefined();
  });
});

// ── MIN_COST_FOR_REENQUEUE ──────────────────────────────────────

describe("MIN_COST_FOR_REENQUEUE constant", () => {
  it("is exported and equals $0.01", () => {
    expect(MIN_COST_FOR_REENQUEUE).toBe(0.01);
  });
});

describe("Minimum cost guard on continuous re-enqueue", () => {
  it("blocks re-enqueue when costUsd is $0 (spin loop prevention)", async () => {
    const deps = createMockDeps();
    // runPipeline completes but at $0 cost (e.g., all TODOs skipped)
    // Signature: (skills, config, callbacks)
    deps.runPipeline.mockImplementation(async () => {
      // Don't emit any cost events — job stays at $0
    });

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    // Original job should be complete
    const completedJobs = state.jobs.filter(j => j.status === "complete");
    expect(completedJobs.length).toBe(1);
    expect(completedJobs[0].costUsd).toBe(0);

    // No re-enqueue should have happened (no queued job)
    const queuedJobs = state.jobs.filter(j => j.status === "queued");
    expect(queuedJobs.length).toBe(0);
  });

  it("allows re-enqueue when costUsd >= $0.01 (normal operation)", async () => {
    const deps = createMockDeps();
    // Signature: (skills, config, callbacks) where callbacks has onEvent
    deps.runPipeline.mockImplementation(async (_skills: unknown, _config: unknown, callbacks: { onEvent?: (e: unknown) => void }) => {
      // Emit a cost_update event to simulate real work (job-runner tracks cost via cost_update events)
      callbacks?.onEvent?.({ type: "cost_update", costUsd: 0.50 });
    });

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    const completedJobs = state.jobs.filter(j => j.status === "complete");
    expect(completedJobs.length).toBe(1);

    // A re-enqueue should have happened (queued job present)
    const queuedJobs = state.jobs.filter(j => j.status === "queued");
    expect(queuedJobs.length).toBe(1);
    expect(queuedJobs[0].triggerDetail).toBe("auto re-enqueue after successful pipeline");
  });

  it("skip-completed re-enqueue fires despite $0 cost", async () => {
    // The skip-completed paths (lines ~753, ~770) call enqueue() without cost checks.
    // If someone adds a cost guard to those paths, this test catches it.
    // Setup: mock TODO state as "merged" so the skip-completed path fires,
    // then verify a new queued job appears even though costUsd is $0.

    const deps = createMockDeps();
    // Pipeline completes at $0 (no cost events emitted)
    deps.runPipeline.mockResolvedValue(undefined);

    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);
    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");

    // Get the job and set claimedTodoTitle to trigger TODO state tracking
    const preState = runner.getState();
    const job = preState.jobs[0];
    job.claimedTodoTitle = "Test Feature";

    // Write a TODOS.md so pre-assignment can parse it
    const { writeFileSync, mkdirSync: mkdirSyncFs } = await import("node:fs");
    writeFileSync(join(TEST_DIR, "TODOS.md"), "## Backlog\n- [ ] Test Feature [P2] [S]\n  A test item\n");

    // Write TODO state as "merged" — this triggers the skip-completed path
    const { writeTodoState } = await import("../src/todo-state.js");
    writeTodoState(TEST_DIR, "test-feature", {
      title: "Test Feature",
      slug: "test-feature",
      state: "merged",
      updatedAt: new Date().toISOString(),
    });

    await runner.processNext();

    // The skip path should have completed the job without running the pipeline
    expect(deps.runPipeline).not.toHaveBeenCalled();

    const postState = runner.getState();
    const completedJob = postState.jobs.find(j => j.id === job.id);
    expect(completedJob?.status).toBe("complete");
    expect(completedJob?.costUsd).toBe(0);

    // Key assertion: a new queued job exists despite $0 cost
    // This proves the skip-completed path is NOT gated by MIN_COST_FOR_REENQUEUE
    const queuedJobs = postState.jobs.filter(j => j.status === "queued");
    expect(queuedJobs.length).toBe(1);
    expect(queuedJobs[0].triggerDetail).toBe("skip-completed re-enqueue");
  });
});
