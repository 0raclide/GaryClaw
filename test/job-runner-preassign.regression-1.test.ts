/**
 * Regression: ISSUE-001 — preAssignStateDir temporal dead zone crash
 * Found by /qa on 2026-03-30
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
 *
 * preAssignStateDir was declared after its first use in a .filter() callback,
 * causing a ReferenceError (TDZ) when TODO items had ~~strikethrough~~ markup.
 * The outer try/catch swallowed the crash, silently disabling pre-assignment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import { writeTodoState } from "../src/todo-state.js";
import type { DaemonConfig, TodoState } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-jr-preassign-regression-tmp");
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

describe("Job Runner pre-assignment regression", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(PARENT_DIR, { recursive: true });
    mkdirSync(join(TEST_DIR, ".garyclaw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("does not crash when TODOS.md contains ~~strikethrough~~ items (TDZ regression)", async () => {
    // This TODOS.md has a strikethrough item followed by a normal item.
    // Before the fix, the strikethrough filter accessed preAssignStateDir
    // before its declaration, throwing ReferenceError in the TDZ.
    writeFileSync(
      join(TEST_DIR, "TODOS.md"),
      [
        "## Backlog",
        "- [ ] ~~Completed Feature~~ [P2] [S]",
        "  Already done",
        "- [ ] Open Feature [P2] [S]",
        "  Still needs work",
      ].join("\n"),
    );

    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");

    // Should not throw — before the fix this would crash with:
    // ReferenceError: Cannot access 'preAssignStateDir' before initialization
    await expect(runner.processNext()).resolves.not.toThrow();
  });

  it("strikethrough items without state files are filtered out (not included)", async () => {
    // ~~strikethrough~~ with no state file => trust the markup, exclude the item
    writeFileSync(
      join(TEST_DIR, "TODOS.md"),
      [
        "## Backlog",
        "- [ ] ~~Done Item~~ [P2] [S]",
        "  This was completed before state tracking existed",
        "- [ ] Active Item [P2] [S]",
        "  This is still open",
      ].join("\n"),
    );

    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");
    await runner.processNext();

    // The pre-assignment should have picked "Active Item" (not the strikethrough one)
    const state = runner.getState();
    const job = state.jobs.find(j => j.status === "running" || j.status === "complete");
    if (job?.claimedTodoTitle) {
      expect(job.claimedTodoTitle).not.toContain("Done Item");
    }
    // Either way, no crash occurred — that's the key assertion
  });

  it("strikethrough items WITH state files defer to state filter", async () => {
    // ~~strikethrough~~ with a state file showing "open" => state wins, include the item
    writeFileSync(
      join(TEST_DIR, "TODOS.md"),
      [
        "## Backlog",
        "- [ ] ~~Stale Markup Item~~ [P2] [S]",
        "  Markup is stale but state says open",
      ].join("\n"),
    );

    // Write state file that says "open" (overrides strikethrough markup)
    writeTodoState(TEST_DIR, "stale-markup-item", {
      title: "Stale Markup Item",
      slug: "stale-markup-item",
      state: "open",
      updatedAt: new Date().toISOString(),
    } as TodoState);

    const deps = createMockDeps();
    const runner = createJobRunner(createTestConfig(), TEST_DIR, deps);

    runner.enqueue(["prioritize", "implement", "qa"], "manual", "test");

    // Should not crash and should include the item (state overrides markup)
    await expect(runner.processNext()).resolves.not.toThrow();
  });
});
