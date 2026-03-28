/**
 * Worktree regression: merge lock acquire/release edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireMergeLock,
  releaseMergeLock,
} from "../src/worktree.js";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "garyclaw-mergelock-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("acquireMergeLock", () => {
  it("acquires lock when .garyclaw does not exist yet", () => {
    // .garyclaw/ is not pre-created — tryMergeLock should handle it
    const acquired = acquireMergeLock(testDir, 1000);
    expect(acquired).toBe(true);
    expect(existsSync(join(testDir, ".garyclaw", "merge-lock"))).toBe(true);
    releaseMergeLock(testDir);
  });

  it("acquires lock when .garyclaw already exists", () => {
    mkdirSync(join(testDir, ".garyclaw"), { recursive: true });
    const acquired = acquireMergeLock(testDir, 1000);
    expect(acquired).toBe(true);
    releaseMergeLock(testDir);
  });

  it("is reentrant (same process can acquire twice)", () => {
    const first = acquireMergeLock(testDir, 1000);
    expect(first).toBe(true);
    const second = acquireMergeLock(testDir, 1000);
    expect(second).toBe(true);
    releaseMergeLock(testDir);
  });

  it("writes PID to lock file", () => {
    acquireMergeLock(testDir, 1000);
    const pidFile = join(testDir, ".garyclaw", "merge-lock", "pid");
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    expect(pid).toBe(process.pid);
    releaseMergeLock(testDir);
  });

  it("recovers stale lock from dead process", () => {
    // Create a lock with a PID that doesn't exist
    const lockDir = join(testDir, ".garyclaw", "merge-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "pid"), "999999999"); // unlikely to be a real PID

    const acquired = acquireMergeLock(testDir, 2000);
    expect(acquired).toBe(true);
    releaseMergeLock(testDir);
  });
});

describe("releaseMergeLock", () => {
  it("removes lock directory", () => {
    acquireMergeLock(testDir, 1000);
    const lockDir = join(testDir, ".garyclaw", "merge-lock");
    expect(existsSync(lockDir)).toBe(true);

    releaseMergeLock(testDir);
    expect(existsSync(lockDir)).toBe(false);
  });

  it("is safe to call when no lock exists", () => {
    // Should not throw
    releaseMergeLock(testDir);
  });

  it("is safe to call when .garyclaw does not exist", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "garyclaw-nolock-"));
    releaseMergeLock(emptyDir);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
