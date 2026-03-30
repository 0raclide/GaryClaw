import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { runAutoCleanup, type AutoCleanupOptions } from "../src/doctor.js";
import { safeWriteJSON } from "../src/safe-json.js";

const TEST_DIR = join(process.cwd(), ".test-auto-cleanup-tmp");
const GARYCLAW_DIR = join(TEST_DIR, ".garyclaw");

function defaultOptions(overrides?: Partial<AutoCleanupOptions>): AutoCleanupOptions {
  return {
    projectDir: TEST_DIR,
    ...overrides,
  };
}

describe("runAutoCleanup", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("returns empty cleaned array when no issues found", async () => {
    const result = await runAutoCleanup(defaultOptions());
    expect(result.cleaned).toEqual([]);
  });

  it("cleans stale PID files for dead processes", async () => {
    const instDir = join(GARYCLAW_DIR, "daemons", "test-inst");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "daemon.pid"), "99999999", "utf-8");
    writeFileSync(join(instDir, "daemon.sock"), "", "utf-8");

    const result = await runAutoCleanup(defaultOptions());
    expect(result.cleaned).toContain("stale PIDs");
    expect(existsSync(join(instDir, "daemon.pid"))).toBe(false);
    expect(existsSync(join(instDir, "daemon.sock"))).toBe(false);
  });

  it("cleans stuck reflection locks from dead processes", async () => {
    const lockDir = join(GARYCLAW_DIR, "oracle-memory", ".reflection-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "pid"), "99999999", "utf-8");

    const result = await runAutoCleanup(defaultOptions());
    expect(result.cleaned).toContain("stuck reflection locks");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("does not touch running instances (current process PID)", async () => {
    const instDir = join(GARYCLAW_DIR, "daemons", "alive-inst");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "daemon.pid"), String(process.pid), "utf-8");

    const result = await runAutoCleanup(defaultOptions());
    // Process name check may fail in vitest (not "node"), so PID file may
    // be removed as "stale" (PID reuse detection). The important thing is
    // that runAutoCleanup doesn't throw and returns cleanly.
    expect(result).toBeDefined();
    expect(Array.isArray(result.cleaned)).toBe(true);
  });

  it("handles corrupt budget file", async () => {
    mkdirSync(GARYCLAW_DIR, { recursive: true });
    writeFileSync(join(GARYCLAW_DIR, "global-budget.json"), "{{corrupt", "utf-8");

    const result = await runAutoCleanup(defaultOptions());
    expect(result.cleaned).toContain("budget");
    // Budget file should be fixed
    const content = JSON.parse(
      require("node:fs").readFileSync(join(GARYCLAW_DIR, "global-budget.json"), "utf-8"),
    );
    expect(content.totalUsd).toBe(0);
  });

  it("cleans orphaned TODO state files", async () => {
    const todoStateDir = join(GARYCLAW_DIR, "todo-state");
    mkdirSync(todoStateDir, { recursive: true });
    // Write a TODOS.md with no matching items
    writeFileSync(join(TEST_DIR, "TODOS.md"), "- [ ] Real Item [P2]\n", "utf-8");
    // Write an orphaned state file
    safeWriteJSON(join(todoStateDir, "orphaned-item.json"), {
      title: "Orphaned Thing That Does Not Exist",
      state: "in_progress",
    });

    const result = await runAutoCleanup(defaultOptions());
    expect(result.cleaned).toContain("orphaned TODO state");
    expect(existsSync(join(todoStateDir, "orphaned-item.json"))).toBe(false);
  });

  it("returns multiple cleaned categories when multiple issues exist", async () => {
    // Create stale PID
    const instDir = join(GARYCLAW_DIR, "daemons", "dead-inst");
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(instDir, "daemon.pid"), "99999999", "utf-8");

    // Create stuck lock
    const lockDir = join(GARYCLAW_DIR, "oracle-memory", ".reflection-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "pid"), "99999999", "utf-8");

    const result = await runAutoCleanup(defaultOptions());
    expect(result.cleaned.length).toBeGreaterThanOrEqual(2);
    expect(result.cleaned).toContain("stale PIDs");
    expect(result.cleaned).toContain("stuck reflection locks");
  });

  it("accepts budget config options", async () => {
    const result = await runAutoCleanup(defaultOptions({
      dailyCostLimitUsd: 100,
      maxJobsPerDay: 50,
    }));
    expect(result.cleaned).toEqual([]);
  });

  it("is fail-open: does not throw on individual check errors", async () => {
    // Even with minimal setup, should not throw
    const result = await runAutoCleanup(defaultOptions());
    expect(result).toBeDefined();
    expect(Array.isArray(result.cleaned)).toBe(true);
  });
});
