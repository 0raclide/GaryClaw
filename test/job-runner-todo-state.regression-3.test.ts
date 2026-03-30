/**
 * Regression: ISSUE-001 — markTodoCompleteInFile called for pr-created state
 * Found by /qa on 2026-03-30
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
 *
 * The /implement refactor moved the auto-mark call outside the qa-complete guard,
 * so pr-created items got falsely marked ~~COMPLETE~~ in TODOS.md even though
 * the PR hasn't merged yet. Fix: only call markTodoCompleteInFile for terminal
 * states (complete, merged).
 *
 * Also: pre-assignment filter didn't skip pr-created items, allowing the daemon
 * to re-assign a TODO that already has an open PR.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import { writeTodoState, readTodoState } from "../src/todo-state.js";
import type { DaemonConfig } from "../src/types.js";

// Mock detectArtifacts to prevent git env leak from parent repo
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

const TEST_DIR = join(process.cwd(), ".test-jr-todostate-reg3-tmp");

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

describe("pr-created state: TODOS.md and pre-assignment guards", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(
      join(TEST_DIR, "TODOS.md"),
      "# TODOS\n\n## Fix Login Bug\nLogin fails on mobile\n\n## Add Dark Mode\nUser requested dark theme\n",
    );
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("does NOT mark TODOS.md heading as ~~complete~~ when state is pr-created", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    // Pre-seed as pr-created (PR opened, waiting for review)
    writeTodoState(TEST_DIR, "fix-login-bug", {
      title: "Fix Login Bug",
      slug: "fix-login-bug",
      state: "pr-created",
      updatedAt: new Date().toISOString(),
    });

    const jobId = runner.enqueue(["implement", "qa"], "manual", "test");
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Fix Login Bug";

    await runner.processNext();

    // TODOS.md should NOT have strikethrough for pr-created items
    const todosContent = readFileSync(join(TEST_DIR, "TODOS.md"), "utf-8");
    expect(todosContent).toContain("## Fix Login Bug");
    expect(todosContent).not.toContain("~~Fix Login Bug~~");
  });

  it("preserves pr-created state in state file (no promotion)", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    writeTodoState(TEST_DIR, "fix-login-bug", {
      title: "Fix Login Bug",
      slug: "fix-login-bug",
      state: "pr-created",
      updatedAt: new Date().toISOString(),
    });

    const jobId = runner.enqueue(["implement", "qa"], "manual", "test");
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Fix Login Bug";

    await runner.processNext();

    // State should stay pr-created (not promoted to complete)
    const finalState = readTodoState(TEST_DIR, "fix-login-bug");
    expect(finalState).toBeDefined();
    expect(finalState!.state).toBe("pr-created");
  });

  it("DOES mark TODOS.md for merged state (terminal)", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    writeTodoState(TEST_DIR, "fix-login-bug", {
      title: "Fix Login Bug",
      slug: "fix-login-bug",
      state: "merged",
      updatedAt: new Date().toISOString(),
    });

    const jobId = runner.enqueue(["implement", "qa"], "manual", "test");
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Fix Login Bug";

    await runner.processNext();

    // Merged IS terminal, so TODOS.md should be marked
    const todosContent = readFileSync(join(TEST_DIR, "TODOS.md"), "utf-8");
    expect(todosContent).toContain("~~");
  });
});
