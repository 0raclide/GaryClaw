/**
 * Auto-Fix Coordinator — immediate fix attempts after post-merge revert.
 *
 * When post-merge verification catches a regression and auto-reverts,
 * this module enqueues an `implement -> qa` job to fix it immediately
 * instead of waiting for the next prioritize cycle.
 *
 * Retry cap (MAX_AUTO_FIX_RETRIES) prevents infinite revert-fix loops.
 * Budget cap (AUTO_FIX_BUDGET_MULTIPLIER x original job cost) prevents
 * runaway spending. State persisted to survive daemon restarts.
 *
 * Locking: mkdir-based advisory lock around state read/write prevents
 * corruption from parallel instances.
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { safeReadJSON, safeWriteJSON } from "./safe-json.js";
import type { Job } from "./types.js";

// ── Types ──────────────────────────────────────────────────────

export interface AutoFixState {
  /** Key: original merge SHA. Value: retry metadata. */
  entries: Record<string, AutoFixEntry>;
}

export interface AutoFixEntry {
  originalMergeSha: string;
  originalJobId: string;
  originalJobCost: number;
  bugTodoTitle: string;      // the P2 bug TODO title, used to claim the TODO for the auto-fix job
  retryCount: number;        // 0, 1, or 2
  totalAutoFixCost: number;  // accumulated across retries
  createdAt: string;         // ISO timestamp
  lastAttemptAt?: string;
}

// ── Constants ──────────────────────────────────────────────────

export const MAX_AUTO_FIX_RETRIES = 2;
export const AUTO_FIX_BUDGET_MULTIPLIER = 2;  // 2x original job cost
const AUTO_FIX_STATE_FILE = "auto-fix-state.json";
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;  // 24 hours
export const AUTO_FIX_LOCK_DIR = "auto-fix-lock";
const LOCK_TIMEOUT_MS = 500;
const LOCK_POLL_MS = 50;

// ── Locking (same mkdir pattern as budget-lock.ts) ─────────────

/**
 * Acquire the auto-fix state lock. Returns true on success, false on timeout.
 * Lock dir: {checkpointDir}/auto-fix-lock/
 */
export function acquireAutoFixLock(checkpointDir: string, timeoutMs: number = LOCK_TIMEOUT_MS): boolean {
  const lockDir = join(checkpointDir, AUTO_FIX_LOCK_DIR);
  const pidFile = join(lockDir, "pid");

  if (tryCreateLock(lockDir, pidFile)) return true;
  if (isOwnLock(pidFile)) return true;

  const deadline = Date.now() + timeoutMs;
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    Atomics.wait(sleepBuf, 0, 0, LOCK_POLL_MS);
    if (tryCreateLock(lockDir, pidFile)) return true;
    if (isStaleLock(pidFile)) {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race */ }
      if (tryCreateLock(lockDir, pidFile)) return true;
    }
  }
  return false;
}

/** Release the auto-fix state lock. Safe to call even if not held. */
export function releaseAutoFixLock(checkpointDir: string): void {
  const lockDir = join(checkpointDir, AUTO_FIX_LOCK_DIR);
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

function tryCreateLock(lockDir: string, pidFile: string): boolean {
  try {
    mkdirSync(lockDir, { recursive: false });
    try { writeFileSync(pidFile, String(process.pid), "utf-8"); } catch { /* non-fatal */ }
    return true;
  } catch {
    return false;
  }
}

function isOwnLock(pidFile: string): boolean {
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    return pid === process.pid;
  } catch {
    return false;
  }
}

function isStaleLock(pidFile: string): boolean {
  let pid: number;
  try {
    pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  } catch {
    return true;
  }
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      return (err as { code: string }).code !== "EPERM";
    }
    return true;
  }
}

// ── State persistence ──────────────────────────────────────────

function isAutoFixState(data: unknown): data is AutoFixState {
  return typeof data === "object" && data !== null && typeof (data as AutoFixState).entries === "object";
}

export function readAutoFixState(checkpointDir: string): AutoFixState {
  const filePath = join(checkpointDir, AUTO_FIX_STATE_FILE);
  const state = safeReadJSON<AutoFixState>(filePath, isAutoFixState);
  if (!state) return { entries: {} };

  // Prune entries older than 24h
  const now = Date.now();
  const pruned: Record<string, AutoFixEntry> = {};
  for (const [sha, entry] of Object.entries(state.entries)) {
    const createdAt = new Date(entry.createdAt).getTime();
    if (now - createdAt < PRUNE_AGE_MS) {
      pruned[sha] = entry;
    }
  }
  state.entries = pruned;
  return state;
}

export function writeAutoFixState(checkpointDir: string, state: AutoFixState): void {
  const filePath = join(checkpointDir, AUTO_FIX_STATE_FILE);
  safeWriteJSON(filePath, state);
}

// ── Context file (for implement skill discovery) ────────────────

/**
 * Write auto-fix context to disk for the implement skill to discover.
 * File: {projectDir}/.garyclaw/auto-fix-context/{sha-prefix}.md
 */
export function writeAutoFixContext(ctx: {
  projectDir: string;
  mergeSha: string;
  jobId: string;
  instanceName: string;
  revertSha?: string;
  testOutput?: string;
}): void {
  const contextDir = join(ctx.projectDir, ".garyclaw", "auto-fix-context");
  mkdirSync(contextDir, { recursive: true });
  const contextFile = join(contextDir, `${ctx.mergeSha.slice(0, 12)}.md`);
  writeFileSync(contextFile, [
    `# Auto-Fix Context for ${ctx.mergeSha.slice(0, 8)}`,
    "",
    `**Original job:** ${ctx.jobId}`,
    `**Branch:** garyclaw/${ctx.instanceName}`,
    `**Revert SHA:** ${ctx.revertSha ?? "unknown"}`,
    "",
    "## Test Output",
    "```",
    (ctx.testOutput ?? "no test output captured").slice(0, 3000),
    "```",
  ].join("\n"), "utf-8");
}

// ── Core function ──────────────────────────────────────────────

export interface MaybeEnqueueAutoFixContext {
  projectDir: string;
  checkpointDir: string;
  mergeSha: string;
  jobId: string;
  jobCost: number;
  instanceName: string;
  skills: string[];
  testOutput?: string;
  revertSha?: string;
  bugTodoTitle: string;
  enqueue: (skills: string[], triggeredBy: Job["triggeredBy"], detail: string) => string | null;
  log: (level: string, msg: string) => void;
  config: { autoFixOnRevert?: boolean };
}

export interface AutoFixResult {
  enqueued: boolean;
  reason: string;
}

/**
 * Attempt to enqueue an auto-fix job after a post-merge revert.
 *
 * Checks: config gate, retry cap, budget cap.
 * IMPORTANT: enqueues BEFORE persisting state, so a failed enqueue
 * (dedup, budget) does not consume a retry slot.
 */
export function maybeEnqueueAutoFix(ctx: MaybeEnqueueAutoFixContext): AutoFixResult {
  // 1. Gate: config check
  if (!ctx.config.autoFixOnRevert) {
    return { enqueued: false, reason: "autoFixOnRevert disabled" };
  }

  // 2. Read state (under lock for parallel safety)
  let lockAcquired = false;
  try {
    lockAcquired = acquireAutoFixLock(ctx.checkpointDir);
    if (!lockAcquired) {
      ctx.log("warn", "Auto-fix lock acquisition timed out, proceeding without lock");
    }
  } catch (lockErr) {
    ctx.log("warn", `Auto-fix lock acquisition failed: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`);
  }

  try {
    const state = readAutoFixState(ctx.checkpointDir);

    // 3. Check retry cap
    const entry = state.entries[ctx.mergeSha];
    if (entry && entry.retryCount >= MAX_AUTO_FIX_RETRIES) {
      ctx.log("info", `Auto-fix retry cap reached for ${ctx.mergeSha} (${entry.retryCount}/${MAX_AUTO_FIX_RETRIES})`);
      return { enqueued: false, reason: "retry_cap_reached" };
    }

    // 4. Check budget cap
    const budgetCap = ctx.jobCost * AUTO_FIX_BUDGET_MULTIPLIER;
    const spent = entry?.totalAutoFixCost ?? 0;
    if (spent >= budgetCap) {
      ctx.log("info", `Auto-fix budget cap reached for ${ctx.mergeSha} ($${spent.toFixed(2)}/$${budgetCap.toFixed(2)})`);
      return { enqueued: false, reason: "budget_cap_reached" };
    }

    // 5. Build enqueue detail
    const nextRetry = (entry?.retryCount ?? 0) + 1;
    const detail = [
      `auto-fix attempt ${nextRetry}/${MAX_AUTO_FIX_RETRIES}`,
      `for revert of ${ctx.mergeSha.slice(0, 8)}`,
      ctx.testOutput ? `\nTest output:\n${ctx.testOutput.slice(0, 1500)}` : "",
    ].join(" ");

    // 6. Enqueue BEFORE persisting state — if enqueue fails (dedup, budget),
    //    we don't consume a retry slot.
    const jobId = ctx.enqueue(
      ["implement", "qa"],
      "post-merge-revert",
      detail,
    );

    if (!jobId) {
      return { enqueued: false, reason: "enqueue_failed" };
    }

    // 7. Persist state ONLY after successful enqueue
    const newEntry: AutoFixEntry = {
      originalMergeSha: ctx.mergeSha,
      originalJobId: ctx.jobId,
      originalJobCost: ctx.jobCost,
      bugTodoTitle: ctx.bugTodoTitle,
      retryCount: nextRetry,
      totalAutoFixCost: spent,
      createdAt: entry?.createdAt ?? new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
    };
    state.entries[ctx.mergeSha] = newEntry;
    writeAutoFixState(ctx.checkpointDir, state);

    // 8. Write context file for implement skill discovery
    try {
      writeAutoFixContext({
        projectDir: ctx.projectDir,
        mergeSha: ctx.mergeSha,
        jobId: ctx.jobId,
        instanceName: ctx.instanceName,
        revertSha: ctx.revertSha,
        testOutput: ctx.testOutput,
      });
    } catch (ctxErr) {
      ctx.log("warn", `Auto-fix context write failed: ${ctxErr instanceof Error ? ctxErr.message : String(ctxErr)}`);
    }

    ctx.log("info", `Auto-fix enqueued: job ${jobId}, attempt ${nextRetry}`);
    return { enqueued: true, reason: "enqueued" };
  } finally {
    if (lockAcquired) {
      releaseAutoFixLock(ctx.checkpointDir);
    }
  }
}

/**
 * Update auto-fix state with cost from a completed auto-fix job.
 *
 * Call this when a job with triggeredBy === "post-merge-revert" completes.
 * Uses autoFixMergeSha from the Job if available, falls back to
 * parsing triggerDetail for backwards compatibility.
 */
export function updateAutoFixCost(
  checkpointDir: string,
  mergeShaOrDetail: string,
  costUsd: number,
  isDirectSha?: boolean,
): void {
  let shaPrefix: string | null = null;

  if (isDirectSha) {
    // Direct SHA from job.autoFixMergeSha — use first 8 chars for prefix match
    shaPrefix = mergeShaOrDetail.slice(0, 8);
  } else {
    // Parse merge SHA from trigger detail: "auto-fix attempt N/M for revert of XXXXXXXX ..."
    const match = mergeShaOrDetail.match(/for revert of ([a-f0-9]{8})/);
    if (!match) return;
    shaPrefix = match[1];
  }

  let lockAcquired = false;
  try {
    lockAcquired = acquireAutoFixLock(checkpointDir);
  } catch { /* fail-open */ }

  try {
    const state = readAutoFixState(checkpointDir);

    // Find the entry by SHA prefix match
    for (const [sha, entry] of Object.entries(state.entries)) {
      if (sha.startsWith(shaPrefix!)) {
        entry.totalAutoFixCost += costUsd;
        writeAutoFixState(checkpointDir, state);
        return;
      }
    }
  } finally {
    if (lockAcquired) {
      releaseAutoFixLock(checkpointDir);
    }
  }
}
