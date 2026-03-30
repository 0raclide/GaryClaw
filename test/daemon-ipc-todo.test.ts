/**
 * Daemon IPC --todo passthrough tests: todoTitle sets skipComposition + claimedTodoTitle on job.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildIPCHandler } from "../src/daemon.js";
import type { Job } from "../src/types.js";
import type { JobRunner } from "../src/job-runner.js";

const TEST_DIR = join(process.cwd(), ".test-daemon-ipc-todo-tmp");

function createMockRunner(): JobRunner {
  const jobs: Job[] = [];
  return {
    enqueue: vi.fn().mockImplementation((skills: string[]) => {
      const job: Job = {
        id: "job-todo-001",
        triggeredBy: "manual",
        triggerDetail: "CLI trigger",
        skills,
        projectDir: TEST_DIR,
        status: "queued",
        enqueuedAt: new Date().toISOString(),
        costUsd: 0,
      };
      jobs.push(job);
      return "job-todo-001";
    }),
    processNext: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue({
      version: 1,
      jobs,
      dailyCost: { date: "2026-03-30", totalUsd: 0, jobCount: 0 },
    }),
    isRunning: vi.fn().mockReturnValue(false),
  };
}

describe("buildIPCHandler — todoTitle passthrough", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("sets skipComposition and claimedTodoTitle when todoTitle is provided", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({
      type: "trigger",
      skills: ["implement", "qa"],
      todoTitle: "Fix the login bug",
    });

    expect(resp.ok).toBe(true);
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === "job-todo-001");
    expect(job).toBeDefined();
    expect(job!.claimedTodoTitle).toBe("Fix the login bug");
    expect(job!.skipComposition).toBe(true);
  });

  it("does not set skipComposition when todoTitle is absent", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({
      type: "trigger",
      skills: ["implement", "qa"],
    });

    expect(resp.ok).toBe(true);
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === "job-todo-001");
    expect(job).toBeDefined();
    expect(job!.skipComposition).toBeUndefined();
    expect(job!.claimedTodoTitle).toBeUndefined();
  });

  it("todoTitle passthrough works with designDoc", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({
      type: "trigger",
      skills: ["implement"],
      designDoc: "docs/designs/login-fix.md",
      todoTitle: "Fix the login bug",
    });

    expect(resp.ok).toBe(true);
    expect(runner.enqueue).toHaveBeenCalledWith(["implement"], "manual", "CLI trigger", "docs/designs/login-fix.md");
    const state = runner.getState();
    const job = state.jobs.find(j => j.id === "job-todo-001");
    expect(job!.skipComposition).toBe(true);
    expect(job!.claimedTodoTitle).toBe("Fix the login bug");
  });

  it("todoTitle is not set when enqueue returns null (rejected)", async () => {
    const runner = createMockRunner();
    (runner.enqueue as any).mockReturnValue(null);
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({
      type: "trigger",
      skills: ["qa"],
      todoTitle: "Fix the login bug",
    });

    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("rejected");
  });
});
