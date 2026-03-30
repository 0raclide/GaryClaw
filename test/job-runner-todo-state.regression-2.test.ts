/**
 * Regression: ISSUE-001 — default instance (no worktree) never promoted qa-complete → complete
 * Found by /qa on 2026-03-30
 *
 * The auto-merge path only runs for named instances with worktrees. The default
 * instance commits directly to main, so there's no merge step. Without the fix,
 * TODOs stuck at "qa-complete" forever on default instance.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import { writeTodoState, readTodoState, slugify } from "../src/todo-state.js";
import type { DaemonConfig } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-jr-todostate-reg2-tmp");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: TEST_DIR,
    triggers: [],
    budget: {
      dailyCostLimitUsd: 50,
      perJobCostLimitUsd: 10,
      maxJobsPerDay: 20,
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
    writeSummary: vi.fn(),
    log: vi.fn(),
  };
}

describe("Default instance qa-complete → complete promotion", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "TODOS.md"), "## Backlog\n- [ ] Fix Login Bug [P2] [S]\n  Login fails on mobile\n");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("promotes qa-complete to complete when no worktree (default instance)", async () => {
    const deps = createMockDeps();
    // No worktreePath in config = default instance
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    // Pre-seed TODO state at qa-complete (as if QA skill just finished)
    writeTodoState(TEST_DIR, "fix-login-bug", {
      title: "Fix Login Bug",
      slug: "fix-login-bug",
      state: "qa-complete",
      updatedAt: new Date().toISOString(),
    });

    const jobId = runner.enqueue(["implement", "qa"], "manual", "test");
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Fix Login Bug";

    await runner.processNext();

    // After job completes, state should be promoted to "complete"
    const finalState = readTodoState(TEST_DIR, "fix-login-bug");
    expect(finalState).toBeDefined();
    expect(finalState!.state).toBe("complete");
    expect(finalState!.lastJobId).toBe(jobId);
  });

  it("does NOT promote when state is not qa-complete", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    // State is "implementing", not "qa-complete"
    writeTodoState(TEST_DIR, "fix-login-bug", {
      title: "Fix Login Bug",
      slug: "fix-login-bug",
      state: "implementing",
      updatedAt: new Date().toISOString(),
    });

    const jobId = runner.enqueue(["implement", "qa"], "manual", "test");
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Fix Login Bug";

    await runner.processNext();

    // State should remain "implementing"
    const finalState = readTodoState(TEST_DIR, "fix-login-bug");
    expect(finalState).toBeDefined();
    expect(finalState!.state).toBe("implementing");
  });

  it("auto-marks TODOS.md on promotion", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    writeTodoState(TEST_DIR, "fix-login-bug", {
      title: "Fix Login Bug",
      slug: "fix-login-bug",
      state: "qa-complete",
      updatedAt: new Date().toISOString(),
    });

    const jobId = runner.enqueue(["implement", "qa"], "manual", "test");
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Fix Login Bug";

    await runner.processNext();

    // TODOS.md should have the item marked complete (strikethrough)
    const todosContent = readFileSync(join(TEST_DIR, "TODOS.md"), "utf-8");
    expect(todosContent).toContain("~~");
  });

  it("fails open when TODO state read throws", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    // Write corrupt state file
    const stateDir = join(TEST_DIR, "todo-state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "fix-login-bug.json"), "not-json{{{");

    const jobId = runner.enqueue(["implement", "qa"], "manual", "test");
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Fix Login Bug";

    await runner.processNext();

    // Job should still complete successfully (fail-open)
    const postState = runner.getState();
    const completedJob = postState.jobs.find(j => j.id === jobId);
    expect(completedJob?.status).toBe("complete");
  });
});
