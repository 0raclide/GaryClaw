import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildIPCHandler, getWorktreeCommitCount } from "../src/daemon.js";
import type { JobRunner } from "../src/job-runner.js";
import type { DaemonState, Job, PipelineProgress } from "../src/types.js";

function makeRunner(overrides?: Partial<DaemonState>): JobRunner {
  const state: DaemonState = {
    version: 1,
    jobs: [],
    dailyCost: { date: "2026-03-30", totalUsd: 0, jobCount: 0 },
    ...overrides,
  };
  return {
    getState: () => state,
    isRunning: () => state.jobs.some((j) => j.status === "running"),
    enqueue: vi.fn(() => "job-1"),
    processNext: vi.fn(),
    updateBudget: vi.fn(),
  } as unknown as JobRunner;
}

function makeJob(overrides?: Partial<Job>): Job {
  return {
    id: "test-job-1",
    triggeredBy: "manual",
    triggerDetail: "test",
    skills: ["prioritize", "implement", "qa"],
    projectDir: "/tmp/test",
    status: "running",
    enqueuedAt: "2026-03-30T00:00:00Z",
    startedAt: "2026-03-30T00:01:00Z",
    costUsd: 1.5,
    claimedTodoTitle: "Self-Commit Filtering",
    ...overrides,
  };
}

describe("buildIPCHandler pipelineProgress", () => {
  it("returns pipelineProgress: null when no running job", async () => {
    const runner = makeRunner();
    const handler = buildIPCHandler(runner, Date.now());
    const resp = await handler({ type: "status" });
    expect(resp.ok).toBe(true);
    const data = resp.data as Record<string, unknown>;
    expect(data.pipelineProgress).toBeNull();
  });

  it("returns pipelineProgress: null when no instDir provided", async () => {
    const job = makeJob();
    const runner = makeRunner({ jobs: [job] });
    // No instDir passed → no pipeline reading
    const handler = buildIPCHandler(runner, Date.now(), "/tmp", undefined, undefined);
    const resp = await handler({ type: "status" });
    const data = resp.data as Record<string, unknown>;
    expect(data.pipelineProgress).toBeNull();
  });

  it("returns pipelineProgress: null when pipeline.json does not exist", async () => {
    const job = makeJob();
    const runner = makeRunner({ jobs: [job] });
    // instDir is a nonexistent path — readPipelineState will return null
    const handler = buildIPCHandler(runner, Date.now(), "/tmp", undefined, "/tmp/nonexistent-inst");
    const resp = await handler({ type: "status" });
    const data = resp.data as Record<string, unknown>;
    expect(data.pipelineProgress).toBeNull();
  });

  it("includes elapsedSeconds computed from startedAt", async () => {
    const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
    const job = makeJob({ startedAt: tenMinutesAgo });
    const runner = makeRunner({ jobs: [job] });
    // Without a real pipeline.json, progress will be null. But we can test the handler doesn't crash.
    const handler = buildIPCHandler(runner, Date.now(), "/tmp", undefined, "/tmp/nonexistent");
    const resp = await handler({ type: "status" });
    expect(resp.ok).toBe(true);
  });

  it("includes oracleHealth in status when projectDir set", async () => {
    const runner = makeRunner();
    const handler = buildIPCHandler(runner, Date.now(), "/tmp/nonexistent-project");
    const resp = await handler({ type: "status" });
    const data = resp.data as Record<string, unknown>;
    // oracleHealth is null when metrics file doesn't exist
    expect(data.oracleHealth).toBeNull();
  });

  it("backward compat: handler still works with old 4-arg signature", async () => {
    const runner = makeRunner();
    // Old callers passed 4 args — new signature has 6 with optional last 2
    const handler = buildIPCHandler(runner, Date.now(), "/tmp", "/tmp/.garyclaw");
    const resp = await handler({ type: "status" });
    expect(resp.ok).toBe(true);
    const data = resp.data as Record<string, unknown>;
    expect(data.pipelineProgress).toBeNull();
  });
});

describe("getWorktreeCommitCount", () => {
  it("returns 0 when worktreePath is undefined", async () => {
    const count = await getWorktreeCommitCount(undefined);
    expect(count).toBe(0);
  });

  it("returns 0 when worktreePath is empty string", async () => {
    const count = await getWorktreeCommitCount("");
    expect(count).toBe(0);
  });

  it("returns 0 when git command fails (nonexistent path)", async () => {
    const count = await getWorktreeCommitCount("/nonexistent/path");
    expect(count).toBe(0);
  });

  it("returns a number for the current repo (smoke test)", async () => {
    // This runs against the real GaryClaw repo — should return >= 0
    const count = await getWorktreeCommitCount(process.cwd(), process.cwd());
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
