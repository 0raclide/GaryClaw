/**
 * Job Runner file conflict integration tests — pre-assignment skips conflicting items,
 * falls through to next, fail-open, custom dep map, claimedFiles persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import type { DaemonConfig, DaemonState, Job } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-jr-fileconflict-tmp");
const PARENT_DIR = join(TEST_DIR, "parent");
const INSTANCE_DIR = join(PARENT_DIR, "daemons", "worker-1");
const PROJECT_DIR = join(TEST_DIR, "project");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: PROJECT_DIR,
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

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-001",
    triggeredBy: "manual",
    triggerDetail: "test",
    skills: ["design-review"],  // Different from worker-1's pipeline to avoid cross-instance dedup
    projectDir: PROJECT_DIR,
    status: "running",
    enqueuedAt: new Date().toISOString(),
    costUsd: 0,
    ...overrides,
  };
}

function writeInstanceState(instanceName: string, state: DaemonState): void {
  const dir = join(PARENT_DIR, "daemons", instanceName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "daemon-state.json"), JSON.stringify(state), "utf-8");
}

function writeTodos(content: string): void {
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(join(PROJECT_DIR, "TODOS.md"), content, "utf-8");
}

const TODOS_WITH_FILES = `# TODOS

## P2: Add file conflict prevention
**Effort:** S
**Depends on:** Nothing
**Design doc:** \`docs/designs/file-conflict.md\`

Modify \`src/job-runner.ts\` and \`src/daemon-registry.ts\` to detect file overlaps.

## P3: Improve dashboard colors
**Effort:** S
**Depends on:** Nothing

Update \`src/dashboard.ts\` with better color scheme.

## P4: Refactor CLI help text
**Effort:** XS
**Depends on:** Nothing

Update \`src/cli.ts\` help strings.
`;

describe("Job Runner — file conflict prevention", () => {
  beforeEach(() => {
    mkdirSync(INSTANCE_DIR, { recursive: true });
    mkdirSync(PROJECT_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("skips TODO item that conflicts with another instance's claimed files", async () => {
    writeTodos(TODOS_WITH_FILES);

    // worker-2 is already working on something that touches types.ts and daemon-registry.ts
    writeInstanceState("worker-2", {
      version: 1,
      jobs: [makeJob({
        id: "job-other",
        status: "running",
        claimedFiles: ["types.ts", "daemon-registry.ts", "job-runner.ts"],
        claimedTodoTitle: "Some other feature",
      })],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
    });

    const deps = createMockDeps();
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
      "worker-1",
      PARENT_DIR,
    );

    // Enqueue a pipeline with prioritize
    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    // The first TODO ("Add file conflict prevention") mentions job-runner.ts and daemon-registry.ts
    // which conflict with worker-2's claimed files. It should fall through to the second item.
    const logCalls = deps.log.mock.calls.map((c: string[]) => c[1]);
    const skipLog = logCalls.find((msg: string) => msg.includes("Skipped TODO"));
    expect(skipLog).toBeTruthy();
    expect(skipLog).toContain("file conflict");
  });

  it("picks first non-conflicting item when first item conflicts", async () => {
    writeTodos(TODOS_WITH_FILES);

    // worker-2 claims files that conflict with P2 item (job-runner.ts -> types.ts, daemon-registry.ts)
    writeInstanceState("worker-2", {
      version: 1,
      jobs: [makeJob({
        id: "job-other",
        status: "running",
        claimedFiles: ["job-runner.ts", "types.ts", "daemon-registry.ts"],
        claimedTodoTitle: "Another feature",
      })],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
    });

    const deps = createMockDeps();
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
      "worker-1",
      PARENT_DIR,
    );

    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    // Should have pre-assigned the dashboard or CLI item instead
    const state = runner.getState();
    const runningJob = state.jobs.find((j) => j.status !== "queued");
    if (runningJob?.claimedTodoTitle) {
      // Should NOT be the file-conflict item since it conflicts
      expect(runningJob.claimedTodoTitle).not.toBe("Add file conflict prevention");
    }
  });

  it("fail-open: claims item when no file paths detected", async () => {
    const todosNoFiles = `# TODOS

## P2: Improve documentation
**Effort:** S
**Depends on:** Nothing

Write better docs for the project. No specific files mentioned.
`;
    writeTodos(todosNoFiles);

    writeInstanceState("worker-2", {
      version: 1,
      jobs: [makeJob({
        id: "job-other",
        status: "running",
        claimedFiles: ["types.ts"],
        claimedTodoTitle: "Other work",
      })],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
    });

    const deps = createMockDeps();
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
      "worker-1",
      PARENT_DIR,
    );

    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    // Should claim despite no files detected (fail-open)
    const state = runner.getState();
    const job = state.jobs[0];
    expect(job.claimedTodoTitle).toBe("Improve documentation");
    // claimedFiles should be undefined (no files detected)
    expect(job.claimedFiles).toBeUndefined();
  });

  it("persists claimedFiles on Job in state", async () => {
    const todosSimple = `# TODOS

## P2: Update oracle prompt
**Effort:** S
**Depends on:** Nothing

Modify \`src/oracle.ts\` to improve prompt quality.
`;
    writeTodos(todosSimple);

    const deps = createMockDeps();
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
      "worker-1",
      PARENT_DIR,
    );

    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    // Read persisted state
    const stateRaw = readFileSync(join(INSTANCE_DIR, "daemon-state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as DaemonState;
    const job = state.jobs[0];
    expect(job.claimedFiles).toBeDefined();
    expect(job.claimedFiles).toContain("oracle.ts");
    // Should also have expanded deps (types.ts, oracle-memory.ts)
    expect(job.claimedFiles).toContain("types.ts");
    expect(job.claimedFiles).toContain("oracle-memory.ts");
  });

  it("loads custom dep map from .garyclaw/file-deps.json", async () => {
    const todosSimple = `# TODOS

## P2: Update foo module
**Effort:** S
**Depends on:** Nothing

Modify \`src/foo.ts\` for new behavior.
`;
    writeTodos(todosSimple);

    // Write custom dep map
    const customMap = { "foo.ts": ["bar.ts", "baz.ts"] };
    writeFileSync(join(PARENT_DIR, "file-deps.json"), JSON.stringify(customMap), "utf-8");

    const deps = createMockDeps();
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
      "worker-1",
      PARENT_DIR,
    );

    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    const job = state.jobs[0];
    expect(job.claimedFiles).toContain("foo.ts");
    expect(job.claimedFiles).toContain("bar.ts");
    expect(job.claimedFiles).toContain("baz.ts");
  });

  it("idles when all actionable items conflict", async () => {
    const todosAllConflict = `# TODOS

## P2: Update oracle
**Effort:** S
**Depends on:** Nothing

Modify \`src/oracle.ts\` for new feature.

## P3: Update dashboard
**Effort:** S
**Depends on:** Nothing

Modify \`src/dashboard.ts\` for new stats.
`;
    writeTodos(todosAllConflict);

    // Worker-2 claims types.ts (both oracle.ts and dashboard.ts expand to include types.ts)
    writeInstanceState("worker-2", {
      version: 1,
      jobs: [makeJob({
        id: "job-other",
        status: "running",
        claimedFiles: ["types.ts"],
        claimedTodoTitle: "Other work",
      })],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
    });

    const deps = createMockDeps();
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
      "worker-1",
      PARENT_DIR,
    );

    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    const logCalls = deps.log.mock.calls.map((c: string[]) => c[1]);
    const idleLog = logCalls.find((msg: string) => msg.includes("blocked by file conflicts"));
    expect(idleLog).toBeTruthy();
  });

  it("no conflict check without parentCheckpointDir (single instance)", async () => {
    const todosSimple = `# TODOS

## P2: Update oracle
**Effort:** S
**Depends on:** Nothing

Modify \`src/oracle.ts\` for new feature.
`;
    writeTodos(todosSimple);

    const deps = createMockDeps();
    // No parentCheckpointDir — single instance mode
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
    );

    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    // Should still claim the item (no cross-instance check)
    const state = runner.getState();
    const job = state.jobs[0];
    expect(job.claimedTodoTitle).toBe("Update oracle");
  });

  it("only checks running/queued jobs for file conflicts, not completed", async () => {
    const todosSimple = `# TODOS

## P2: Update oracle
**Effort:** S
**Depends on:** Nothing

Modify \`src/oracle.ts\` for new feature.
`;
    writeTodos(todosSimple);

    // Worker-2 has a completed job with claimedFiles (should be ignored)
    writeInstanceState("worker-2", {
      version: 1,
      jobs: [makeJob({
        id: "job-done",
        status: "complete",
        claimedFiles: ["oracle.ts", "types.ts", "oracle-memory.ts"],
        claimedTodoTitle: "Old work",
      })],
      dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
    });

    const deps = createMockDeps();
    const runner = createJobRunner(
      createTestConfig(),
      INSTANCE_DIR,
      deps,
      "worker-1",
      PARENT_DIR,
    );

    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    // Should claim oracle.ts item — completed job's files don't block
    const state = runner.getState();
    const job = state.jobs[0];
    expect(job.claimedTodoTitle).toBe("Update oracle");
    expect(job.claimedFiles).toContain("oracle.ts");
  });
});
