/**
 * Notifier — macOS notifications and job summary files.
 *
 * Uses osascript for native macOS notifications.
 * Graceful no-op if osascript is unavailable.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Job, DaemonConfig } from "./types.js";
import type { MergeResult } from "./worktree.js";

/**
 * Send a macOS notification for a completed job.
 */
export function notifyJobComplete(job: Job, config: DaemonConfig): void {
  if (!config.notifications.enabled || !config.notifications.onComplete) return;

  const instanceLabel = config.name ? ` [${config.name}]` : "";
  const title = `GaryClaw${instanceLabel} Job Complete`;
  const message = `/${job.skills.join(" → /")} finished ($${job.costUsd.toFixed(3)})`;
  sendNotification(title, message);
}

/**
 * Send a macOS notification for a failed job.
 */
export function notifyJobError(job: Job, config: DaemonConfig): void {
  if (!config.notifications.enabled || !config.notifications.onError) return;

  const instanceLabel = config.name ? ` [${config.name}]` : "";
  const title = `GaryClaw${instanceLabel} Job Failed`;
  const categoryTag = job.failureCategory ? ` [${job.failureCategory}]` : "";
  const message = `/${job.skills.join(" → /")} failed${categoryTag}: ${job.error ?? "unknown error"}`;
  sendNotification(title, message);
}

/**
 * Send a macOS notification when a crashed job is resumed.
 */
export function notifyJobResumed(job: Job, completedSkillCount: number, config: DaemonConfig): void {
  if (!config.notifications.enabled || !config.notifications.onComplete) return;

  const instanceLabel = config.name ? ` [${config.name}]` : "";
  const title = `GaryClaw${instanceLabel} Job Recovered`;
  const message = `Resuming /${job.skills.join(" → /")} from skill ${completedSkillCount + 1}/${job.skills.length} (attempt ${job.retryCount ?? 1}/2)`;
  sendNotification(title, message);
}

/**
 * Send a macOS notification when a merge is blocked (test failure or rebase conflict).
 * Follows the same pattern as notifyJobError — gated by notifications.onError.
 */
export function notifyMergeBlocked(job: Job, result: MergeResult, config: DaemonConfig): void {
  if (!config.notifications.enabled || !config.notifications.onError) return;

  const instanceLabel = config.name ? ` [${config.name}]` : "";
  const title = `GaryClaw${instanceLabel} Merge Blocked`;
  const reason = result.testsPassed === false
    ? "pre-merge tests failed"
    : result.reason ?? "unknown reason";
  const message = `/${job.skills.join(" → /")} completed but merge blocked: ${reason}`;
  sendNotification(title, message);
}

/**
 * Send a macOS notification when a rate limit hold begins.
 */
export function notifyRateLimitHold(resetAt: Date, instanceName: string, config: DaemonConfig): void {
  if (!config.notifications.enabled || !config.notifications.onError) return;

  const instanceLabel = instanceName && instanceName !== "default" ? ` [${instanceName}]` : "";
  const title = `GaryClaw${instanceLabel} Rate Limited`;
  const message = `Holding all jobs until ${resetAt.toLocaleTimeString()}`;
  sendNotification(title, message);
}

/**
 * Send a macOS notification when a rate limit hold expires.
 */
export function notifyRateLimitResume(instanceName: string, config: DaemonConfig): void {
  if (!config.notifications.enabled || !config.notifications.onComplete) return;

  const instanceLabel = instanceName && instanceName !== "default" ? ` [${instanceName}]` : "";
  const title = `GaryClaw${instanceLabel} Resumed`;
  const message = "Rate limit hold expired — jobs resuming";
  sendNotification(title, message);
}

/**
 * Send a macOS notification for an escalated decision.
 */
export function notifyEscalation(question: string, config: DaemonConfig): void {
  if (!config.notifications.enabled || !config.notifications.onEscalation) return;

  const title = "GaryClaw Escalation";
  const message = question.slice(0, 200);
  sendNotification(title, message);
}

/**
 * Write a summary.md file for a completed/failed job.
 */
export function writeSummary(job: Job, jobDir: string): void {
  mkdirSync(jobDir, { recursive: true });

  const lines: string[] = [];
  lines.push(`# Job Summary — ${job.id}`);
  lines.push("");
  lines.push(`**Status:** ${job.status}`);
  lines.push(`**Skills:** ${job.skills.map((s) => `/${s}`).join(" → ")}`);
  lines.push(`**Triggered by:** ${job.triggeredBy} (${job.triggerDetail})`);
  lines.push(`**Enqueued:** ${job.enqueuedAt}`);
  if (job.startedAt) lines.push(`**Started:** ${job.startedAt}`);
  if (job.completedAt) lines.push(`**Completed:** ${job.completedAt}`);
  lines.push(`**Cost:** $${job.costUsd.toFixed(3)}`);

  if (job.error) {
    lines.push("");
    lines.push(`## Error`);
    if (job.failureCategory) lines.push(`**Category:** ${job.failureCategory}${job.retryable ? " (retryable)" : ""}`);
    lines.push(job.error);
  }

  if (job.reportPath) {
    lines.push("");
    lines.push(`## Report`);
    lines.push(`See: ${job.reportPath}`);
  }

  lines.push("");
  lines.push("---");
  lines.push("*Generated by GaryClaw Daemon*");

  writeFileSync(join(jobDir, "summary.md"), lines.join("\n"), "utf-8");
}

/**
 * Escape a string for embedding in an AppleScript double-quoted string.
 * AppleScript requires escaping backslashes and double quotes.
 */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Send a macOS notification via osascript. No-op if unavailable.
 * Uses execFileSync to avoid shell interpretation (no shell injection).
 */
export function sendNotification(title: string, message: string): boolean {
  try {
    const escapedTitle = escapeAppleScript(title);
    const escapedMessage = escapeAppleScript(message);
    execFileSync(
      "osascript",
      ["-e", `display notification "${escapedMessage}" with title "${escapedTitle}"`],
      { timeout: 5000, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}
