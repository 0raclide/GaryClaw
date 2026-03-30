/**
 * Reflection Lock — file-based advisory lock for oracle-memory writes.
 *
 * Prevents concurrent reflection runs (from parallel daemon instances)
 * from corrupting decision-outcomes.md and metrics.json.
 *
 * Uses mkdir (atomic on POSIX — succeeds or fails, no partial state)
 * as the locking primitive. A PID file inside the lock directory enables
 * reentrant detection from the same process.
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const REFLECTION_LOCK_DIR_NAME = ".reflection-lock";
const PID_FILE_NAME = "pid";
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

/**
 * Acquire the reflection lock for the given oracle-memory directory.
 *
 * Creates {oracleMemoryDir}/.reflection-lock/ directory atomically.
 * If already held by this process (reentrant), returns true immediately.
 * If held by another process, polls until timeout.
 *
 * @returns true if acquired, false on timeout
 */
export function acquireReflectionLock(
  oracleMemoryDir: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): boolean {
  const lockDir = join(oracleMemoryDir, REFLECTION_LOCK_DIR_NAME);
  const pidFile = join(lockDir, PID_FILE_NAME);

  // Try to create lock dir atomically
  if (tryCreateLockDir(lockDir, pidFile)) {
    return true;
  }

  // Lock exists — check if reentrant (same process)
  if (isOwnLock(pidFile)) {
    return true;
  }

  // Poll until timeout — synchronous sleep via Atomics.wait to avoid CPU spin
  const deadline = Date.now() + timeoutMs;
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    Atomics.wait(sleepBuf, 0, 0, POLL_INTERVAL_MS);

    if (tryCreateLockDir(lockDir, pidFile)) {
      return true;
    }

    // Check if the holding process died (stale lock)
    if (isStaleLock(pidFile)) {
      // Try to clean up stale lock and re-acquire
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Another process may have cleaned it up
      }
      if (tryCreateLockDir(lockDir, pidFile)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Release the reflection lock. Safe to call even if not held.
 */
export function releaseReflectionLock(oracleMemoryDir: string): void {
  const lockDir = join(oracleMemoryDir, REFLECTION_LOCK_DIR_NAME);
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Check if the reflection lock is currently held (by any process).
 */
export function isReflectionLocked(oracleMemoryDir: string): boolean {
  const lockDir = join(oracleMemoryDir, REFLECTION_LOCK_DIR_NAME);
  return existsSync(lockDir);
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Attempt to create the lock directory atomically.
 * On success, writes the current PID inside the lock dir.
 */
function tryCreateLockDir(lockDir: string, pidFile: string): boolean {
  try {
    mkdirSync(lockDir, { recursive: false });
    // Lock acquired — write PID for reentrant detection + stale detection
    try {
      writeFileSync(pidFile, String(process.pid), "utf-8");
    } catch {
      // PID write failure is non-fatal — lock is still held
    }
    return true;
  } catch {
    // EEXIST or other error — lock not acquired
    return false;
  }
}

/**
 * Check if the lock is held by the current process (reentrant).
 */
function isOwnLock(pidFile: string): boolean {
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    return pid === process.pid;
  } catch {
    return false;
  }
}

/**
 * Check if the lock is stale (held by a dead process).
 */
function isStaleLock(pidFile: string): boolean {
  let pid: number;
  try {
    pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  } catch {
    // Can't read PID file → treat as stale
    return true;
  }

  if (!Number.isFinite(pid) || pid <= 0) return true;

  try {
    // Check if process is alive (signal 0 = no signal, just check existence)
    process.kill(pid, 0);
    return false; // Process is alive
  } catch (err: unknown) {
    // ESRCH = process doesn't exist → stale
    // EPERM = process exists but we can't signal it → not stale
    if (err && typeof err === "object" && "code" in err) {
      return (err as { code: string }).code !== "EPERM";
    }
    return true;
  }
}
