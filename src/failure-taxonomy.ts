/**
 * Failure Taxonomy — classify job errors into actionable categories.
 *
 * Table-driven heuristic matching. Rules are evaluated top-to-bottom;
 * first match wins. "unknown" is the conservative fallback.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FailureCategory, FailureRecord } from "./types.js";

// ── Classification rules ─────────────────────────────────────────

interface ClassificationRule {
  category: FailureCategory;
  retryable: boolean;
  suggestion: string;
  /** Match against error class name (exact match). */
  errorNames?: string[];
  /** Match against error message (case-insensitive substring). */
  messagePatterns?: string[];
  /** Match against stack trace first 5 lines (case-insensitive substring). */
  stackPatterns?: string[];
}

/**
 * Rules evaluated top-to-bottom — first match wins.
 * Priority: Budget > Auth > Infra > SDK > GaryClaw > Project > Skill.
 */
export const RULES: readonly ClassificationRule[] = [
  // ── Budget (highest priority — known typed error) ──
  {
    category: "budget-exceeded",
    retryable: false,
    suggestion: "Increase budget in daemon config or wait for daily reset",
    errorNames: ["PerJobCostExceededError"],
  },

  // ── Auth issues ──
  {
    category: "auth-issue",
    retryable: true,
    suggestion: "Re-authenticate: run 'claude' CLI to refresh login",
    messagePatterns: [
      "auth verification failed",
      "no session id returned",
      "unauthorized",
      "authentication",
      "token expired",
      "login required",
      "AUTH_TIMEOUT",
    ],
  },

  // ── Infrastructure / transient ──
  {
    category: "infra-issue",
    retryable: true,
    suggestion: "Transient failure — safe to retry",
    messagePatterns: [
      "ENOSPC",
      "ENOMEM",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "EPIPE",
      "EAI_AGAIN",
      "socket hang up",
      "network error",
      "rate limit",
      "429",
      "503",
      "502",
      "overloaded",
      "capacity",
    ],
  },

  // ── SDK bugs (Agent SDK issues) ──
  {
    category: "sdk-bug",
    retryable: true,
    suggestion: "SDK issue — check @anthropic-ai/claude-agent-sdk version",
    messagePatterns: [
      "protocol error",
      "unexpected message type",
      "invalid json",
      "stream error",
      "chunk parsing",
    ],
    stackPatterns: [
      "claude-agent-sdk",
      "node_modules/@anthropic-ai",
    ],
  },

  // ── Daemon restart (transient — job was interrupted, safe to retry) ──
  {
    category: "infra-issue",
    retryable: true,
    suggestion: "Daemon was restarted — job can be re-enqueued",
    messagePatterns: [
      "daemon restarted",
    ],
  },

  // ── GaryClaw bugs (our code) ──
  {
    category: "garyclaw-bug",
    retryable: false,
    suggestion: "GaryClaw internal error — file a bug",
    stackPatterns: [
      "src/orchestrator.ts",
      "src/pipeline.ts",
      "src/relay.ts",
      "src/checkpoint.ts",
      "src/token-monitor.ts",
      "src/ask-handler.ts",
      "src/oracle.ts",
      "src/reflection.ts",
      "src/job-runner.ts",
      "src/daemon",
      "src/worktree.ts",
    ],
  },

  // ── Project bugs (target project issues) ──
  {
    category: "project-bug",
    retryable: false,
    suggestion: "Fix the issue in the target project",
    messagePatterns: [
      "test failed",
      "tests failed",
      "lint error",
      "eslint",
      "tsc error",
      "type error",
      "compilation failed",
      "build failed",
      "merge conflict",
      "CONFLICT",
    ],
  },

  // ── Skill bugs (gstack skill misbehavior) ──
  {
    category: "skill-bug",
    retryable: false,
    suggestion: "Skill produced an error — check skill SKILL.md",
    messagePatterns: [
      "skill failed",
      "skill error",
      "SKILL.md not found",
    ],
    stackPatterns: [
      ".claude/skills/",
    ],
  },
];

// ── Public API ──────────────────────────────────────────────────

/**
 * Classify an error into a failure category.
 * Returns the first matching rule, or "unknown" if no rule matches.
 */
export function classifyError(err: unknown): {
  category: FailureCategory;
  retryable: boolean;
  suggestion: string;
} {
  const errName = err instanceof Error ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err ?? "");
  const stack = getStackLines(err);
  const messageLower = message.toLowerCase();
  const stackLower = stack.toLowerCase();

  for (const rule of RULES) {
    let matched = false;

    // Check errorNames (exact match)
    if (rule.errorNames && errName) {
      if (rule.errorNames.includes(errName)) {
        matched = true;
      }
    }

    // Check messagePatterns (case-insensitive substring)
    if (!matched && rule.messagePatterns) {
      for (const pattern of rule.messagePatterns) {
        if (messageLower.includes(pattern.toLowerCase())) {
          matched = true;
          break;
        }
      }
    }

    // Check stackPatterns (case-insensitive substring)
    if (!matched && rule.stackPatterns) {
      for (const pattern of rule.stackPatterns) {
        if (stackLower.includes(pattern.toLowerCase())) {
          matched = true;
          break;
        }
      }
    }

    if (matched) {
      return {
        category: rule.category,
        retryable: rule.retryable,
        suggestion: rule.suggestion,
      };
    }
  }

  return {
    category: "unknown",
    retryable: false,
    suggestion: "Unclassified error — check daemon logs for details",
  };
}

/**
 * Build a complete FailureRecord from an error and job context.
 */
export function buildFailureRecord(
  err: unknown,
  jobId: string,
  skills: string[],
  instanceName?: string,
): FailureRecord {
  const classification = classifyError(err);
  const message = err instanceof Error ? err.message : String(err ?? "");
  const errName = err instanceof Error ? err.name : undefined;
  const stack = getStackLines(err) || undefined;

  return {
    timestamp: new Date().toISOString(),
    jobId,
    skills,
    category: classification.category,
    retryable: classification.retryable,
    errorMessage: message,
    errorName: errName,
    stackTrace: stack || undefined,
    instanceName,
    suggestion: classification.suggestion,
  };
}

/**
 * Append a FailureRecord to failures.jsonl in the checkpoint directory.
 * Wraps in try/catch — classification on Job object still succeeds
 * even if the JSONL write fails (disk full, etc).
 */
export function appendFailureRecord(
  record: FailureRecord,
  checkpointDir: string,
): void {
  try {
    mkdirSync(checkpointDir, { recursive: true });
    const filePath = join(checkpointDir, "failures.jsonl");
    appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // Best-effort — don't crash the job runner if JSONL write fails
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Extract first 5 lines of stack trace from an error.
 */
function getStackLines(err: unknown): string {
  if (!(err instanceof Error) || !err.stack) return "";
  const lines = err.stack.split("\n");
  return lines.slice(0, 5).join("\n");
}
