// Regression: ISSUE-001 — ENOENT on rename during parallel cold-start I/O
// Found by /qa on 2026-03-28
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28-run3.md

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// vi.hoisted runs before vi.mock hoisting — safe place for shared state
const { mockRenameSync, realRenameSyncHolder } = vi.hoisted(() => {
  const mockRenameSync = vi.fn();
  const realRenameSyncHolder: { fn: any } = { fn: null };
  return { mockRenameSync, realRenameSyncHolder };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  realRenameSyncHolder.fn = actual.renameSync;
  return {
    ...actual,
    renameSync: (...args: any[]) => mockRenameSync(...args),
  };
});

// Import AFTER mock setup
import { safeWriteJSON, safeWriteText } from "../src/safe-json.js";

const TEST_DIR = join(tmpdir(), `garyclaw-safe-json-regression-${process.pid}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mockRenameSync.mockReset();
  // Default: pass through to real renameSync
  mockRenameSync.mockImplementation((...args: any[]) => realRenameSyncHolder.fn(...args));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("safeWriteJSON ENOENT retry", () => {
  it("retries rename on ENOENT and succeeds on second attempt", () => {
    let callCount = 0;
    mockRenameSync.mockImplementation((src: string, dest: string) => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return realRenameSyncHolder.fn(src, dest);
    });

    const path = join(TEST_DIR, "retry-test.json");
    safeWriteJSON(path, { retried: true });

    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, "utf-8"));
    expect(data).toEqual({ retried: true });
    // Called twice: first ENOENT, second success
    expect(callCount).toBe(2);
  });

  it("throws non-ENOENT errors without retry", () => {
    mockRenameSync.mockImplementation(() => {
      const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });

    const path = join(TEST_DIR, "no-retry.json");
    expect(() => safeWriteJSON(path, { fail: true })).toThrow("EACCES");
    // Only called once — no retry for non-ENOENT
    expect(mockRenameSync).toHaveBeenCalledTimes(1);
  });

  it("still works normally when rename succeeds first try", () => {
    const path = join(TEST_DIR, "normal.json");
    safeWriteJSON(path, { normal: true });

    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, "utf-8"));
    expect(data).toEqual({ normal: true });
    // Called exactly once — no retry needed
    expect(mockRenameSync).toHaveBeenCalledTimes(1);
  });
});

describe("safeWriteText ENOENT retry", () => {
  it("retries rename on ENOENT and succeeds on second attempt", () => {
    let callCount = 0;
    mockRenameSync.mockImplementation((src: string, dest: string) => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return realRenameSyncHolder.fn(src, dest);
    });

    const path = join(TEST_DIR, "retry-text.txt");
    safeWriteText(path, "hello retry");

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("hello retry");
    expect(callCount).toBe(2);
  });

  it("throws non-ENOENT errors without retry", () => {
    mockRenameSync.mockImplementation(() => {
      const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });

    const path = join(TEST_DIR, "no-retry.txt");
    expect(() => safeWriteText(path, "fail")).toThrow("EPERM");
    expect(mockRenameSync).toHaveBeenCalledTimes(1);
  });
});
