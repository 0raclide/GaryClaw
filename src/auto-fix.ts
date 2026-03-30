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
 */

import { join } from "node:path";
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
 * If all checks pass, updates state and enqueues `implement -> qa`.
 */
export function maybeEnqueueAutoFix(ctx: MaybeEnqueueAutoFixContext): AutoFixResult {
  // 1. Gate: config check
  if (!ctx.config.autoFixOnRevert) {
    return { enqueued: false, reason: "autoFixOnRevert disabled" };
  }

  // 2. Read state
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

  // 5. Update state
  const newEntry: AutoFixEntry = {
    originalMergeSha: ctx.mergeSha,
    originalJobId: ctx.jobId,
    originalJobCost: ctx.jobCost,
    retryCount: (entry?.retryCount ?? 0) + 1,
    totalAutoFixCost: spent,
    createdAt: entry?.createdAt ?? new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
  };
  state.entries[ctx.mergeSha] = newEntry;
  writeAutoFixState(ctx.checkpointDir, state);

  // 6. Enqueue implement -> qa with context
  const detail = [
    `auto-fix attempt ${newEntry.retryCount}/${MAX_AUTO_FIX_RETRIES}`,
    `for revert of ${ctx.mergeSha.slice(0, 8)}`,
    ctx.testOutput ? `\nTest output:\n${ctx.testOutput.slice(0, 1500)}` : "",
  ].join(" ");

  const jobId = ctx.enqueue(
    ["implement", "qa"],
    "post-merge-revert",
    detail,
  );

  if (jobId) {
    ctx.log("info", `Auto-fix enqueued: job ${jobId}, attempt ${newEntry.retryCount}`);
    return { enqueued: true, reason: "enqueued" };
  }

  return { enqueued: false, reason: "enqueue_failed" };
}

/**
 * Update auto-fix state with cost from a completed auto-fix job.
 *
 * Call this when a job with triggeredBy === "post-merge-revert" completes.
 * Parses the original mergeSha from triggerDetail.
 */
export function updateAutoFixCost(
  checkpointDir: string,
  triggerDetail: string,
  costUsd: number,
): void {
  // Parse merge SHA from trigger detail: "auto-fix attempt N/M for revert of XXXXXXXX ..."
  const match = triggerDetail.match(/for revert of ([a-f0-9]{8})/);
  if (!match) return;

  const shaPrefix = match[1];
  const state = readAutoFixState(checkpointDir);

  // Find the entry by SHA prefix match
  for (const [sha, entry] of Object.entries(state.entries)) {
    if (sha.startsWith(shaPrefix)) {
      entry.totalAutoFixCost += costUsd;
      writeAutoFixState(checkpointDir, state);
      return;
    }
  }
}
