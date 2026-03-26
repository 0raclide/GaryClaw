import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  readPidFile,
  isPidAlive,
  writePidFile,
  removePidFile,
  getProcessName,
} from "../src/pid-utils.js";

const TEST_DIR = join(process.cwd(), ".test-pid-utils-tmp");

describe("pid-utils", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  // ── readPidFile ────────────────────────────────────────────────

  describe("readPidFile", () => {
    it("returns null when file does not exist", () => {
      expect(readPidFile(join(TEST_DIR, "nonexistent.pid"))).toBeNull();
    });

    it("reads a valid PID", () => {
      const pidPath = join(TEST_DIR, "daemon.pid");
      writeFileSync(pidPath, "12345", "utf-8");
      expect(readPidFile(pidPath)).toBe(12345);
    });

    it("reads PID with whitespace padding", () => {
      const pidPath = join(TEST_DIR, "daemon.pid");
      writeFileSync(pidPath, "  42  \n", "utf-8");
      expect(readPidFile(pidPath)).toBe(42);
    });

    it("returns null for non-numeric content", () => {
      const pidPath = join(TEST_DIR, "daemon.pid");
      writeFileSync(pidPath, "not-a-pid", "utf-8");
      expect(readPidFile(pidPath)).toBeNull();
    });

    it("returns null for empty file", () => {
      const pidPath = join(TEST_DIR, "daemon.pid");
      writeFileSync(pidPath, "", "utf-8");
      expect(readPidFile(pidPath)).toBeNull();
    });

    it("returns null for zero", () => {
      const pidPath = join(TEST_DIR, "daemon.pid");
      writeFileSync(pidPath, "0", "utf-8");
      expect(readPidFile(pidPath)).toBeNull();
    });

    it("returns null for negative PID", () => {
      const pidPath = join(TEST_DIR, "daemon.pid");
      writeFileSync(pidPath, "-1", "utf-8");
      expect(readPidFile(pidPath)).toBeNull();
    });

    it("returns null for Infinity", () => {
      const pidPath = join(TEST_DIR, "daemon.pid");
      writeFileSync(pidPath, "Infinity", "utf-8");
      expect(readPidFile(pidPath)).toBeNull();
    });
  });

  // ── isPidAlive ─────────────────────────────────────────────────

  describe("isPidAlive", () => {
    it("detects current process as alive (no expected name)", () => {
      const result = isPidAlive(process.pid);
      expect(result.alive).toBe(true);
      expect(result.nameMatch).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.pid).toBe(process.pid);
    });

    it("detects dead process", () => {
      // PID 99999999 is almost certainly not running
      const result = isPidAlive(99999999);
      expect(result.alive).toBe(false);
      expect(result.stale).toBe(true);
      expect(result.pid).toBe(99999999);
    });

    it("detects current process with correct process name", () => {
      // Get the actual process name first, then verify it matches
      const actualName = getProcessName(process.pid);
      expect(actualName).toBeDefined();
      const result = isPidAlive(process.pid, actualName!);
      expect(result.alive).toBe(true);
      expect(result.nameMatch).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.expectedName).toBe(actualName);
    });

    it("detects PID reuse (alive process with wrong name)", () => {
      // process.pid is alive but is "node", not "Safari"
      const result = isPidAlive(process.pid, "ThisProcessDoesNotExistXYZ123");
      expect(result.alive).toBe(true);
      expect(result.nameMatch).toBe(false);
      expect(result.stale).toBe(true);
      expect(result.expectedName).toBe("ThisProcessDoesNotExistXYZ123");
    });

    it("dead process always returns stale regardless of expected name", () => {
      const result = isPidAlive(99999999, "node");
      expect(result.alive).toBe(false);
      expect(result.stale).toBe(true);
      expect(result.expectedName).toBe("node");
    });
  });

  // ── writePidFile ───────────────────────────────────────────────

  describe("writePidFile", () => {
    it("writes PID to file", () => {
      const pidPath = join(TEST_DIR, "daemon.pid");
      writePidFile(pidPath, 42);
      expect(readFileSync(pidPath, "utf-8")).toBe("42");
    });

    it("creates parent directories", () => {
      const pidPath = join(TEST_DIR, "nested", "dir", "daemon.pid");
      writePidFile(pidPath, 123);
      expect(readFileSync(pidPath, "utf-8")).toBe("123");
    });

    it("overwrites existing PID file", () => {
      const pidPath = join(TEST_DIR, "daemon.pid");
      writePidFile(pidPath, 100);
      writePidFile(pidPath, 200);
      expect(readFileSync(pidPath, "utf-8")).toBe("200");
    });
  });

  // ── removePidFile ──────────────────────────────────────────────

  describe("removePidFile", () => {
    it("removes existing PID file", () => {
      const pidPath = join(TEST_DIR, "daemon.pid");
      writeFileSync(pidPath, "42", "utf-8");
      removePidFile(pidPath);
      expect(existsSync(pidPath)).toBe(false);
    });

    it("does nothing for nonexistent file", () => {
      // Should not throw
      removePidFile(join(TEST_DIR, "nonexistent.pid"));
    });
  });

  // ── getProcessName ─────────────────────────────────────────────

  describe("getProcessName", () => {
    it("returns process name for current process", () => {
      const name = getProcessName(process.pid);
      expect(name).toBeDefined();
      expect(typeof name).toBe("string");
      expect(name!.length).toBeGreaterThan(0);
    });

    it("returns undefined for dead PID", () => {
      const name = getProcessName(99999999);
      expect(name).toBeUndefined();
    });
  });
});
