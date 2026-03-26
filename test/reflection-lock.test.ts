/**
 * Reflection Lock tests — acquire, release, reentrant, stale, locked check.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireReflectionLock,
  releaseReflectionLock,
  isReflectionLocked,
} from "../src/reflection-lock.js";

const BASE_DIR = join(tmpdir(), `garyclaw-reflock-${Date.now()}`);

beforeEach(() => mkdirSync(BASE_DIR, { recursive: true }));
afterEach(() => rmSync(BASE_DIR, { recursive: true, force: true }));

describe("acquireReflectionLock", () => {
  it("acquires lock on empty directory", () => {
    const dir = join(BASE_DIR, "test1");
    mkdirSync(dir, { recursive: true });

    const result = acquireReflectionLock(dir);
    expect(result).toBe(true);
    expect(existsSync(join(dir, ".reflection-lock"))).toBe(true);
  });

  it("writes PID file inside lock directory", () => {
    const dir = join(BASE_DIR, "test2");
    mkdirSync(dir, { recursive: true });

    acquireReflectionLock(dir);

    const pidFile = join(dir, ".reflection-lock", "pid");
    expect(existsSync(pidFile)).toBe(true);
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    expect(pid).toBe(process.pid);
  });

  it("is reentrant — same process acquires twice", () => {
    const dir = join(BASE_DIR, "test3");
    mkdirSync(dir, { recursive: true });

    const first = acquireReflectionLock(dir);
    const second = acquireReflectionLock(dir);
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it("times out when lock held by another process (simulated)", () => {
    const dir = join(BASE_DIR, "test4");
    mkdirSync(dir, { recursive: true });

    // Simulate another process holding the lock
    const lockDir = join(dir, ".reflection-lock");
    mkdirSync(lockDir, { recursive: true });
    // Write PID 1 (init process — always alive, never us)
    writeFileSync(join(lockDir, "pid"), "1", "utf-8");

    // Very short timeout to avoid slow test
    const result = acquireReflectionLock(dir, 100);
    expect(result).toBe(false);
  });

  it("recovers from stale lock (dead PID)", () => {
    const dir = join(BASE_DIR, "test5");
    mkdirSync(dir, { recursive: true });

    // Simulate stale lock with a definitely-dead PID
    const lockDir = join(dir, ".reflection-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "pid"), "999999999", "utf-8");

    const result = acquireReflectionLock(dir, 2000);
    expect(result).toBe(true);
  });

  it("recovers from stale lock with invalid PID content", () => {
    const dir = join(BASE_DIR, "test6");
    mkdirSync(dir, { recursive: true });

    const lockDir = join(dir, ".reflection-lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "pid"), "not-a-pid", "utf-8");

    const result = acquireReflectionLock(dir, 2000);
    expect(result).toBe(true);
  });

  it("recovers from stale lock with no PID file", () => {
    const dir = join(BASE_DIR, "test7");
    mkdirSync(dir, { recursive: true });

    // Lock dir exists but no PID file inside
    const lockDir = join(dir, ".reflection-lock");
    mkdirSync(lockDir, { recursive: true });

    const result = acquireReflectionLock(dir, 2000);
    expect(result).toBe(true);
  });
});

describe("releaseReflectionLock", () => {
  it("removes lock directory", () => {
    const dir = join(BASE_DIR, "release1");
    mkdirSync(dir, { recursive: true });

    acquireReflectionLock(dir);
    expect(existsSync(join(dir, ".reflection-lock"))).toBe(true);

    releaseReflectionLock(dir);
    expect(existsSync(join(dir, ".reflection-lock"))).toBe(false);
  });

  it("is safe to call when not held (no-op)", () => {
    const dir = join(BASE_DIR, "release2");
    mkdirSync(dir, { recursive: true });

    // Should not throw
    releaseReflectionLock(dir);
    expect(existsSync(join(dir, ".reflection-lock"))).toBe(false);
  });
});

describe("isReflectionLocked", () => {
  it("returns false when no lock", () => {
    const dir = join(BASE_DIR, "locked1");
    mkdirSync(dir, { recursive: true });

    expect(isReflectionLocked(dir)).toBe(false);
  });

  it("returns true when locked", () => {
    const dir = join(BASE_DIR, "locked2");
    mkdirSync(dir, { recursive: true });

    acquireReflectionLock(dir);
    expect(isReflectionLocked(dir)).toBe(true);
  });

  it("returns false after release", () => {
    const dir = join(BASE_DIR, "locked3");
    mkdirSync(dir, { recursive: true });

    acquireReflectionLock(dir);
    releaseReflectionLock(dir);
    expect(isReflectionLocked(dir)).toBe(false);
  });
});
