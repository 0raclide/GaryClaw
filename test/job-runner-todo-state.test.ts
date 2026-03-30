/**
 * Job Runner TODO State Integration — tests for processNext() with state-aware pipeline trimming.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import { writeTodoState } from "../src/todo-state.js";
import type { DaemonConfig, DaemonState, GaryClawConfig, OrchestratorCallbacks } from "../src/types.js";
import type { TodoState } from "../src/todo-state.js";

// Mock detectArtifacts to prevent git env leak from parent repo.
// TEST_DIR is inside the GaryClaw repo, so without this mock, detectArtifacts
// finds real commits matching "test" / "feature" keywords and infers
// commitsOnMain=true → "merged", which overrides the stored state.
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

const TEST_DIR = join(process.cwd(), ".test-jr-todostate-tmp");
const PARENT_DIR = join(TEST_DIR, "parent");

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

function makeState(overrides: Partial<TodoState> = {}): TodoState {
  return {
    title: "Test Feature",
    slug: "test-feature",
    state: "open",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Job Runner TODO State Integration", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(PARENT_DIR, { recursive: true });
    // Write a minimal TODOS.md for the pre-assignment block
    writeFileSync(join(TEST_DIR, "TODOS.md"), "## Backlog\n- [ ] Test Feature [P2] [S]\n  A test item\n");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("skips pipeline entirely when TODO is already merged", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    // Write state showing this TODO is merged
    writeTodoState(TEST_DIR, "test-feature", makeState({
      title: "Test Feature",
      slug: "test-feature",
      state: "merged",
    }));

    // Enqueue a pipeline job with claimed title
    const jobId = runner.enqueue(
      ["prioritize", "office-hours", "implement", "qa"],
      "manual",
      "test",
    );
    expect(jobId).toBeTruthy();

    // Manually set claimedTodoTitle on the job
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    expect(job).toBeDefined();
    job!.claimedTodoTitle = "Test Feature";

    await runner.processNext();

    // Pipeline should NOT have been called
    expect(deps.runPipeline).not.toHaveBeenCalled();
    expect(deps.runSkill).not.toHaveBeenCalled();

    // Job should be marked complete
    const postState = runner.getState();
    const completedJob = postState.jobs.find(j => j.id === jobId);
    expect(completedJob?.status).toBe("complete");
  });

  it("trims pipeline skills when TODO is at 'designed' state", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    // Write state showing this TODO is designed
    writeTodoState(TEST_DIR, "test-feature", makeState({
      title: "Test Feature",
      slug: "test-feature",
      state: "designed",
      designDocPath: "docs/designs/test-feature.md",
    }));

    const jobId = runner.enqueue(
      ["prioritize", "office-hours", "implement", "qa"],
      "manual",
      "test",
    );
    expect(jobId).toBeTruthy();

    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Test Feature";

    await runner.processNext();

    // Pipeline should have been called (not skipped entirely)
    expect(deps.runPipeline).toHaveBeenCalled();

    // Check that the skills passed to runPipeline start at implement (skip prioritize + office-hours)
    const call = deps.runPipeline.mock.calls[0];
    const skills = call[0] as string[];
    expect(skills).toEqual(["implement", "qa"]);
  });

  it("passes design doc path from state to job", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    writeTodoState(TEST_DIR, "test-feature", makeState({
      title: "Test Feature",
      slug: "test-feature",
      state: "designed",
      designDocPath: "docs/designs/test-feature.md",
    }));

    const jobId = runner.enqueue(
      ["prioritize", "office-hours", "implement", "qa"],
      "manual",
      "test",
    );
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Test Feature";

    await runner.processNext();

    // The job's designDoc should have been set from the state
    expect(job!.designDoc).toBe("docs/designs/test-feature.md");
  });

  it("runs full pipeline when TODO is at 'open' state", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    writeTodoState(TEST_DIR, "test-feature", makeState({
      title: "Test Feature",
      slug: "test-feature",
      state: "open",
    }));

    const jobId = runner.enqueue(
      ["prioritize", "office-hours", "implement", "qa"],
      "manual",
      "test",
    );
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Test Feature";

    await runner.processNext();

    // Full pipeline should run — no trimming
    expect(deps.runPipeline).toHaveBeenCalled();
    const call = deps.runPipeline.mock.calls[0];
    const skills = call[0] as string[];
    expect(skills).toEqual(["prioritize", "office-hours", "implement", "qa"]);
  });

  it("fails open when state tracking throws an error", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    // Write corrupt state file
    mkdirSync(join(TEST_DIR, "todo-state"), { recursive: true });
    writeFileSync(join(TEST_DIR, "todo-state", "test-feature.json"), "corrupt{{{");

    const jobId = runner.enqueue(
      ["prioritize", "office-hours", "implement", "qa"],
      "manual",
      "test",
    );
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Test Feature";

    await runner.processNext();

    // Should still run full pipeline (fail-open)
    expect(deps.runPipeline).toHaveBeenCalled();
    const call = deps.runPipeline.mock.calls[0];
    const skills = call[0] as string[];
    expect(skills).toEqual(["prioritize", "office-hours", "implement", "qa"]);
  });

  it("skips state tracking for single-skill jobs", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    // Even with a merged state, single-skill jobs shouldn't be affected
    writeTodoState(TEST_DIR, "test-feature", makeState({
      title: "Test Feature",
      slug: "test-feature",
      state: "merged",
    }));

    const jobId = runner.enqueue(["qa"], "manual", "test");
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Test Feature";

    await runner.processNext();

    // Single-skill job runs via runSkill, not runPipeline
    expect(deps.runSkill).toHaveBeenCalled();
  });

  it("skips state tracking when no claimedTodoTitle", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    const jobId = runner.enqueue(
      ["prioritize", "office-hours", "implement", "qa"],
      "manual",
      "test",
    );
    // No claimedTodoTitle set

    await runner.processNext();

    // Pipeline should run with all skills (no state trimming)
    expect(deps.runPipeline).toHaveBeenCalled();
    const call = deps.runPipeline.mock.calls[0];
    const skills = call[0] as string[];
    expect(skills).toEqual(["prioritize", "office-hours", "implement", "qa"]);
  });

  it("does not override existing designDoc on the job", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    writeTodoState(TEST_DIR, "test-feature", makeState({
      title: "Test Feature",
      slug: "test-feature",
      state: "designed",
      designDocPath: "docs/designs/from-state.md",
    }));

    const jobId = runner.enqueue(
      ["prioritize", "office-hours", "implement", "qa"],
      "manual",
      "test",
      "docs/designs/explicit.md", // explicit designDoc on enqueue
    );
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Test Feature";

    await runner.processNext();

    // The explicit designDoc should be preserved (not overwritten)
    expect(job!.designDoc).toBe("docs/designs/explicit.md");
  });

  it("skips to qa when state is 'reviewed' and pipeline has no plan-eng-review", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    writeTodoState(TEST_DIR, "test-feature", makeState({
      title: "Test Feature",
      slug: "test-feature",
      state: "reviewed",
    }));

    const jobId = runner.enqueue(
      ["prioritize", "implement", "qa"],
      "manual",
      "test",
    );
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Test Feature";

    await runner.processNext();

    // "reviewed" → getStartSkill returns "qa" → findNextSkill finds qa at index 2
    // Pipeline trimmed to ["qa"] (single skill) → runs via runSkill, not runPipeline
    expect(deps.runSkill).toHaveBeenCalled();
    expect(deps.runPipeline).not.toHaveBeenCalled();
  });

  it("logs skipped skills when trimming pipeline", async () => {
    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    writeTodoState(TEST_DIR, "test-feature", makeState({
      title: "Test Feature",
      slug: "test-feature",
      state: "implemented",
    }));

    const jobId = runner.enqueue(
      ["prioritize", "office-hours", "implement", "plan-eng-review", "qa"],
      "manual",
      "test",
    );
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === jobId);
    job!.claimedTodoTitle = "Test Feature";

    await runner.processNext();

    // Check log was called with skip message
    const logCalls = deps.log.mock.calls;
    const skipLog = logCalls.find(
      (c: string[]) => c[0] === "info" && typeof c[1] === "string" && c[1].includes("skipping ["),
    );
    expect(skipLog).toBeDefined();
    expect(skipLog![1]).toContain("implemented");
  });
});
