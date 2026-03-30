/**
 * Regression: ISSUE-001 — default instance (no worktree) never promoted qa-complete → complete
 * Found by /qa on 2026-03-30
 *
 * The auto-merge path only runs for named instances with worktrees. The default
 * instance commits directly to main, so there's no merge step. Without the fix,
 * TODOs stuck at "qa-complete" forever on default instance because getStartSkill
 * returns "skip" for qa-complete, causing early return before any promotion code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import { writeTodoState, readTodoState, slugify } from "../src/todo-state.js";
import type { DaemonConfig } from "../src/types.js";

// Mock detectArtifacts to prevent git env leak from parent repo.
// TEST_DIR is inside the GaryClaw repo, so without this mock, detectArtifacts
// finds real commits matching "fix" / "login" / "bug" keywords and infers
// commitsOnMain=true → "merged", which overrides the stored qa-complete state.
vi.mock("../src/todo-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/todo-state.js")>();
  return {
    ...actual,
    detectArtifacts: vi.fn().mockReturnValue({
      branchExists: false,
      branchCommitCount: 0,
      commitsOnMain: false,
    }),
  };
});

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
    // markTodoCompleteInFile matches ## headings (not list items).
    // Use the heading format that the production TODOS.md actually uses.
    writeFileSync(join(TEST_DIR, "TODOS.md"), "# TODOS\n\n## Fix Login Bug\nLogin fails on mobile\n");
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

    // After skip-path fires, state should be promoted to "complete"
    const finalState = readTodoState(TEST_DIR, "fix-login-bug");
    expect(finalState).toBeDefined();
    expect(finalState!.state).toBe("complete");
    expect(finalState!.lastJobId).toBe(jobId);

    // Pipeline should NOT run (skip early return)
    expect(deps.runPipeline).not.toHaveBeenCalled();
  });

  it("promotes merged to complete (merged is not terminal)", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    // State is "merged" — branch merged but not yet marked complete
    writeTodoState(TEST_DIR, "fix-login-bug", {
      title: "Fix Login Bug",
      slug: "fix-login-bug",
      state: "merged",
      updatedAt: new Date().toISOString(),
    });

    // Verify the state file round-trips before processNext
    const preState = readTodoState(TEST_DIR, "fix-login-bug");
    expect(preState!.state).toBe("merged");

    const jobId = runner.enqueue(["implement", "qa"], "manual", "test");
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Fix Login Bug";

    await runner.processNext();

    // State should be promoted to "complete" (merged → complete is natural lifecycle)
    const finalState = readTodoState(TEST_DIR, "fix-login-bug");
    expect(finalState).toBeDefined();
    expect(finalState!.state).toBe("complete");
  });

  it("auto-marks TODOS.md on promotion", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    // claimedTodoTitle must match the TODOS.md heading text (after stripping ##)
    // so that markTodoCompleteInFile's slugify comparison succeeds.
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

  it("does NOT promote when worktreePath is set (named instance)", async () => {
    const deps = createMockDeps();
    // worktreePath set = named instance, promotion should NOT happen here
    // (it goes through auto-merge path instead)
    const runner = createJobRunner(
      createTestConfig({ worktreePath: "/tmp/worktree" } as Partial<DaemonConfig> & Record<string, unknown>),
      TEST_DIR,
      deps,
    );

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

    // State should remain qa-complete (named instance promotion handled by auto-merge)
    const finalState = readTodoState(TEST_DIR, "fix-login-bug");
    expect(finalState).toBeDefined();
    expect(finalState!.state).toBe("qa-complete");
  });

  it("fails open when TODO state write throws", async () => {
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
    // When state is corrupt, findTodoState returns null, reconcileState defaults
    // to "open", and the pipeline runs normally
    expect(completedJob?.status).toBe("complete");
  });
});
