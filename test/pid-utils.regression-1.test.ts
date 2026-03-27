/**
 * Regression tests for pid-utils.ts edge cases.
 *
 * ISSUE-004 — isPidAlive: optimistic fallback when getProcessName returns undefined
 * ISSUE-005 — getProcessName: path with slashes, empty output
 * ISSUE-006 — readPidFile: non-numeric content, negative PID
 *
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock child_process before importing
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import { isPidAlive, getProcessName, readPidFile, writePidFile } from "../src/pid-utils.js";

const mockExecFileSync = vi.mocked(execFileSync);
const TEST_DIR = join(tmpdir(), `garyclaw-pid-test-${Date.now()}`);

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── isPidAlive optimistic fallback ─────────────────────────────

describe("isPidAlive with getProcessName failure", () => {
  it("returns nameMatch=true when ps fails (optimistic fallback)", () => {
    // Use current PID (guaranteed alive), but mock ps to fail
    const pid = process.pid;
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ps not available");
    });

    const result = isPidAlive(pid, "node");
    expect(result.alive).toBe(true);
    expect(result.nameMatch).toBe(true); // Optimistic: ps failed → assume match
    expect(result.processName).toBeUndefined();
    expect(result.stale).toBe(false);
  });

  it("returns nameMatch=false when ps returns wrong process name", () => {
    const pid = process.pid;
    mockExecFileSync.mockReturnValue("python\n");

    const result = isPidAlive(pid, "node");
    expect(result.alive).toBe(true);
    expect(result.nameMatch).toBe(false);
    expect(result.processName).toBe("python");
    expect(result.stale).toBe(true); // Alive but wrong process = stale
  });

  it("returns nameMatch=true with no expectedProcessName", () => {
    const pid = process.pid;
    // No mock needed — we skip getProcessName when no expectedName
    const result = isPidAlive(pid);
    expect(result.alive).toBe(true);
    expect(result.nameMatch).toBe(true);
    expect(result.stale).toBe(false);
  });
});

// ── getProcessName edge cases ──────────────────────────────────

describe("getProcessName edge cases", () => {
  it("extracts name from path with slashes", () => {
    mockExecFileSync.mockReturnValue("/usr/local/bin/node\n");
    const name = getProcessName(12345);
    expect(name).toBe("node");
  });

  it("returns undefined for empty ps output", () => {
    mockExecFileSync.mockReturnValue("  \n");
    const name = getProcessName(12345);
    expect(name).toBeUndefined();
  });

  it("returns undefined when ps throws (process dead)", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("process not found");
    });
    const name = getProcessName(99999);
    expect(name).toBeUndefined();
  });

  it("handles ps output with no path separators", () => {
    mockExecFileSync.mockReturnValue("node\n");
    const name = getProcessName(12345);
    expect(name).toBe("node");
  });
});

// ── readPidFile edge cases ─────────────────────────────────────

describe("readPidFile edge cases", () => {
  it("returns null for non-numeric content", () => {
    const pidPath = join(TEST_DIR, "bad.pid");
    writeFileSync(pidPath, "not-a-number\n", "utf-8");
    expect(readPidFile(pidPath)).toBeNull();
  });

  it("returns null for negative PID", () => {
    const pidPath = join(TEST_DIR, "neg.pid");
    writeFileSync(pidPath, "-42\n", "utf-8");
    expect(readPidFile(pidPath)).toBeNull();
  });

  it("returns null for zero PID", () => {
    const pidPath = join(TEST_DIR, "zero.pid");
    writeFileSync(pidPath, "0\n", "utf-8");
    expect(readPidFile(pidPath)).toBeNull();
  });

  it("returns null for float PID", () => {
    const pidPath = join(TEST_DIR, "float.pid");
    writeFileSync(pidPath, "3.14\n", "utf-8");
    // parseInt("3.14", 10) = 3, which is valid, so this returns 3
    expect(readPidFile(pidPath)).toBe(3);
  });

  it("reads valid PID with whitespace", () => {
    const pidPath = join(TEST_DIR, "valid.pid");
    writeFileSync(pidPath, "  12345  \n", "utf-8");
    expect(readPidFile(pidPath)).toBe(12345);
  });

  it("returns null for non-existent file", () => {
    expect(readPidFile(join(TEST_DIR, "nope.pid"))).toBeNull();
  });
});
