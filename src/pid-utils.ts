/**
 * Shared PID liveness utility — used by daemon.ts, daemon-registry.ts, and doctor.ts.
 *
 * Provides PID file read/write, liveness checking with process-name verification
 * to prevent PID reuse false positives, and best-effort cleanup.
 *
 * Zero dependencies on other GaryClaw modules.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface PidCheckResult {
  alive: boolean;
  pid: number;
  processName?: string;       // actual process name (if alive)
  expectedName?: string;      // expected process name (e.g., "node")
  nameMatch: boolean;         // true if processName matches expectedName (or no expected name)
  stale: boolean;             // true if PID file exists but process is dead or name mismatch
}

/**
 * Read PID from a PID file.
 * Returns null if file doesn't exist or is unparseable.
 */
export function readPidFile(pidPath: string): number | null {
  if (!existsSync(pidPath)) return null;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Check if a PID is alive AND optionally verify process name.
 * Process-name check prevents PID reuse false positives —
 * if PID 12345 was our daemon but now it's a completely different process,
 * we detect that.
 */
export function isPidAlive(pid: number, expectedProcessName?: string): PidCheckResult {
  try {
    process.kill(pid, 0);
  } catch {
    // Process is dead
    return {
      alive: false,
      pid,
      expectedName: expectedProcessName,
      nameMatch: false,
      stale: true,
    };
  }

  // Process is alive — optionally verify name
  if (!expectedProcessName) {
    return {
      alive: true,
      pid,
      nameMatch: true,
      stale: false,
    };
  }

  const processName = getProcessName(pid);
  const nameMatch = processName === undefined
    ? true // Optimistic fallback — don't block on ps failure
    : processName === expectedProcessName;

  return {
    alive: true,
    pid,
    processName,
    expectedName: expectedProcessName,
    nameMatch,
    stale: !nameMatch, // alive but wrong process = stale (PID reuse)
  };
}

/**
 * Write PID to file atomically (write to .tmp, rename).
 */
export function writePidFile(pidPath: string, pid: number): void {
  const dir = dirname(pidPath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${pidPath}.tmp.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, String(pid), "utf-8");
  renameSync(tmpPath, pidPath);
}

/**
 * Remove a PID file. Best-effort, never throws.
 */
export function removePidFile(pidPath: string): void {
  try {
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {
    // Best-effort — ignore errors
  }
}

/**
 * Get process name for a PID.
 * Uses `ps -p <pid> -o comm=` on macOS/Linux.
 * Returns undefined if process not found or ps fails.
 */
export function getProcessName(pid: number): string | undefined {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    // ps returns the base name of the executable
    // On some systems it may include path, extract just the name
    const name = output.split("/").pop()?.trim();
    return name && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}
