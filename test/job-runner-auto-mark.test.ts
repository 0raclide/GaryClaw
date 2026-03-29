import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { catchUpCompletedTodos } from "../src/job-runner.js";
import { safeWriteJSON } from "../src/safe-json.js";
import { slugify, writeTodoState } from "../src/todo-state.js";

const BASE_DIR = join(tmpdir(), `garyclaw-automark-job-${Date.now()}`);
const PROJECT_DIR = join(BASE_DIR, "project");
const CHECKPOINT_DIR = join(BASE_DIR, "checkpoint");
const TODOS_PATH = join(PROJECT_DIR, "TODOS.md");

function writeTodos(content: string): void {
  mkdirSync(PROJECT_DIR, { recursive: true });
  writeFileSync(TODOS_PATH, content, "utf-8");
}

function readTodos(): string {
  return readFileSync(TODOS_PATH, "utf-8");
}

function writeState(title: string, state: string, extras: Record<string, unknown> = {}): void {
  const slug = slugify(title);
  const dir = join(CHECKPOINT_DIR, "todo-state");
  mkdirSync(dir, { recursive: true });
  safeWriteJSON(join(dir, `${slug}.json`), {
    title,
    slug,
    state,
    updatedAt: new Date().toISOString(),
    ...extras,
  });
}

const mockLog = { log: vi.fn() };

beforeEach(() => {
  mkdirSync(BASE_DIR, { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  mockLog.log.mockClear();
});

afterEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

// ── catchUpCompletedTodos ─────────────────────────────────────────

describe("catchUpCompletedTodos", () => {
  it("marks merged items as complete in TODOS.md", () => {
    writeTodos([
      "# TODOS",
      "",
      "## P2: Feature Alpha",
      "Description A.",
      "",
      "## P3: Feature Beta",
      "Description B.",
    ].join("\n"));

    writeState("P2: Feature Alpha", "merged", { instanceName: "worker-1", lastJobId: "job-123" });

    const count = catchUpCompletedTodos(CHECKPOINT_DIR, PROJECT_DIR, "default", undefined, mockLog);
    expect(count).toBe(1);

    const todos = readTodos();
    expect(todos).toContain("~~P2: Feature Alpha~~");
    expect(todos).toContain("COMPLETE");
    expect(todos).toContain("Completed by worker-1, job job-123.");
    // Beta unchanged
    expect(todos).toContain("## P3: Feature Beta");
    expect(todos).not.toContain("~~P3: Feature Beta~~");
  });

  it("marks 'complete' state items too", () => {
    writeTodos([
      "# TODOS",
      "",
      "## P2: Done Item",
      "Details.",
    ].join("\n"));

    writeState("P2: Done Item", "complete");

    const count = catchUpCompletedTodos(CHECKPOINT_DIR, PROJECT_DIR, "default", undefined, mockLog);
    expect(count).toBe(1);

    const todos = readTodos();
    expect(todos).toContain("~~P2: Done Item~~");
  });

  it("skips items in 'open' or 'implemented' state", () => {
    writeTodos([
      "# TODOS",
      "",
      "## P2: Open Item",
      "Still open.",
      "",
      "## P3: Implemented Item",
      "In progress.",
    ].join("\n"));

    writeState("P2: Open Item", "open");
    writeState("P3: Implemented Item", "implemented");

    const count = catchUpCompletedTodos(CHECKPOINT_DIR, PROJECT_DIR, "default", undefined, mockLog);
    expect(count).toBe(0);
  });

  it("returns 0 when todo-state directory is missing", () => {
    writeTodos("# TODOS\n\n## P2: Something\nDetails.\n");

    const count = catchUpCompletedTodos(CHECKPOINT_DIR, PROJECT_DIR, "default", undefined, mockLog);
    expect(count).toBe(0);
  });

  it("handles multiple merged items in one pass", () => {
    writeTodos([
      "# TODOS",
      "",
      "## P2: Item A",
      "A.",
      "",
      "## P3: Item B",
      "B.",
      "",
      "## P4: Item C",
      "C.",
    ].join("\n"));

    writeState("P2: Item A", "merged", { instanceName: "w1" });
    writeState("P3: Item B", "merged", { instanceName: "w2" });
    // Item C is not merged

    const count = catchUpCompletedTodos(CHECKPOINT_DIR, PROJECT_DIR, "default", undefined, mockLog);
    expect(count).toBe(2);

    const todos = readTodos();
    expect(todos).toContain("~~P2: Item A~~");
    expect(todos).toContain("~~P3: Item B~~");
    expect(todos).toContain("## P4: Item C"); // unchanged
  });

  it("skips items already marked complete in TODOS.md", () => {
    writeTodos([
      "# TODOS",
      "",
      "## ~~P2: Already Done~~ — COMPLETE (2026-03-28)",
      "Summary.",
    ].join("\n"));

    writeState("P2: Already Done", "merged");

    const count = catchUpCompletedTodos(CHECKPOINT_DIR, PROJECT_DIR, "default", undefined, mockLog);
    expect(count).toBe(0);
  });

  it("provides generic summary when instanceName is missing", () => {
    writeTodos([
      "# TODOS",
      "",
      "## P2: No Instance",
      "Details.",
    ].join("\n"));

    writeState("P2: No Instance", "merged");

    const count = catchUpCompletedTodos(CHECKPOINT_DIR, PROJECT_DIR, "default", undefined, mockLog);
    expect(count).toBe(1);

    const todos = readTodos();
    expect(todos).toContain("Completed.");
  });

  it("skips items claimed by running instances (guard)", () => {
    // Set up parent checkpoint dir with a running instance claiming a title
    const parentDir = join(BASE_DIR, "parent");
    mkdirSync(join(parentDir, "daemons", "worker-1"), { recursive: true });
    // Write a PID file (needed by getClaimedTodoTitles)
    writeFileSync(join(parentDir, "daemons", "worker-1", "daemon.pid"), "99999");
    // Write daemon state with a running job claiming the title
    safeWriteJSON(join(parentDir, "daemons", "worker-1", "daemon-state.json"), {
      version: 1,
      jobs: [{
        id: "job-running",
        status: "running",
        skills: ["implement"],
        claimedTodoTitle: "P2: In Progress Item",
        triggeredBy: "manual",
        triggerDetail: "test",
        projectDir: PROJECT_DIR,
        enqueuedAt: new Date().toISOString(),
        costUsd: 0,
      }],
      dailyCost: { date: "2026-03-29", totalUsd: 0, jobCount: 0 },
    });

    writeTodos([
      "# TODOS",
      "",
      "## P2: In Progress Item",
      "Being worked on.",
    ].join("\n"));

    // Also write merged state for this item
    const stateDir = join(parentDir, "todo-state");
    mkdirSync(stateDir, { recursive: true });
    safeWriteJSON(join(stateDir, `${slugify("P2: In Progress Item")}.json`), {
      title: "P2: In Progress Item",
      slug: slugify("P2: In Progress Item"),
      state: "merged",
      updatedAt: new Date().toISOString(),
    });

    const count = catchUpCompletedTodos(parentDir, PROJECT_DIR, "default", parentDir, mockLog);
    expect(count).toBe(0);
    // TODOS.md unchanged
    expect(readTodos()).toContain("## P2: In Progress Item");
    expect(readTodos()).not.toContain("~~");
  });

  it("is fail-open on corrupt state files", () => {
    writeTodos([
      "# TODOS",
      "",
      "## P2: Good Item",
      "Details.",
    ].join("\n"));

    writeState("P2: Good Item", "merged", { instanceName: "w1" });

    // Write a corrupt state file alongside
    const corruptDir = join(CHECKPOINT_DIR, "todo-state");
    writeFileSync(join(corruptDir, "corrupt.json"), "NOT JSON", "utf-8");

    const count = catchUpCompletedTodos(CHECKPOINT_DIR, PROJECT_DIR, "default", undefined, mockLog);
    expect(count).toBe(1); // Good item still gets marked
  });
});
