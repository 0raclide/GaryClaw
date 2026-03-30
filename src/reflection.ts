/**
 * Post-Job Reflection — compares decisions against job outcomes,
 * tracks quality metrics, and updates oracle memory files.
 *
 * Reflection flow:
 * 1. Read the job's decisions from decisions.jsonl
 * 2. Read the job's issues from the final checkpoint or report
 * 3. For each decision, determine outcome:
 *    - fixed → success (issue mentioned in decision was fixed)
 *    - skipped/deferred → neutral
 *    - reopened → failure (same filePath + similar description reappears)
 * 4. Update decision-outcomes.md with rolling window of ~50 entries
 * 5. Update metrics.json with accuracy, confidence trends
 *
 * Reopened detection uses normalized Levenshtein distance:
 *   edit_distance / max(len_a, len_b) < 0.3 means 70%+ similar
 */

import { resolveWarnFn } from "./types.js";
import type {
  Decision,
  Issue,
  DecisionOutcome,
  OracleMemoryConfig,
  OracleMetrics,
  WarnFn,
} from "./types.js";
import {
  readMetrics,
  writeMetrics,
  updateMetricsWithOutcome,
  readDecisionOutcomes,
  writeDecisionOutcomesRolling,
  defaultMemoryConfig,
} from "./oracle-memory.js";
import { safeReadText } from "./safe-json.js";
import { acquireReflectionLock, releaseReflectionLock } from "./reflection-lock.js";

// ── Levenshtein distance ────────────────────────────────────────

/**
 * Maximum string length for Levenshtein comparison.
 * Strings longer than this are considered "not similar" (returns max length)
 * to prevent O(m*n) memory allocation with pathologically long inputs.
 */
const MAX_LEVENSHTEIN_LENGTH = 500;

/**
 * Compute Levenshtein edit distance between two strings.
 * Standard dynamic programming approach, O(m*n) time and space.
 * Bails out for strings > 500 chars to prevent OOM on corrupt data.
 */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  // Length guard: prevent OOM on pathologically long strings (e.g., stack traces)
  if (m > MAX_LEVENSHTEIN_LENGTH || n > MAX_LEVENSHTEIN_LENGTH) {
    return Math.max(m, n);
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost, // substitution
      );
    }
  }

  return dp[m][n];
}

/**
 * Normalized Levenshtein distance: edit_distance / max(len_a, len_b).
 * Returns a value between 0 (identical) and 1 (completely different).
 */
export function normalizedLevenshtein(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 0;
  const maxLen = Math.max(a.length, b.length);
  return levenshteinDistance(a, b) / maxLen;
}

// ── Reopened issue detection ────────────────────────────────────

/**
 * Check if a new issue matches a previously-resolved issue (reopened).
 * An issue is considered reopened when:
 * - Same filePath (both non-empty)
 * - Similar description (normalized Levenshtein distance < 0.3, i.e. 70%+ similar)
 */
export function isReopenedIssue(
  newIssue: Issue,
  previousIssue: Issue,
  threshold: number = 0.3,
): boolean {
  // Both must have filePath
  if (!newIssue.filePath || !previousIssue.filePath) return false;

  // File paths must match
  if (newIssue.filePath !== previousIssue.filePath) return false;

  // Descriptions must be similar (70%+ by default)
  const distance = normalizedLevenshtein(
    newIssue.description.toLowerCase(),
    previousIssue.description.toLowerCase(),
  );

  return distance < threshold;
}

/**
 * Find reopened issues by comparing current job's issues against
 * previously-resolved outcomes in decision-outcomes.md.
 *
 * Returns a set of decision IDs that were reopened.
 */
export function findReopenedDecisions(
  currentIssues: Issue[],
  previousOutcomes: DecisionOutcome[],
): Set<string> {
  const reopened = new Set<string>();

  // Only check outcomes that were previously marked as success
  const successOutcomes = previousOutcomes.filter(
    (o) => o.outcome === "success" && o.relatedFilePath,
  );

  for (const outcome of successOutcomes) {
    for (const issue of currentIssues) {
      if (
        issue.filePath &&
        outcome.relatedFilePath === issue.filePath &&
        normalizedLevenshtein(
          issue.description.toLowerCase(),
          outcome.question.toLowerCase(),
        ) < 0.3
      ) {
        reopened.add(outcome.decisionId);
      }
    }
  }

  return reopened;
}

// ── Decision outcome mapping ────────────────────────────────────

/**
 * Map a decision to its outcome based on the job's issues.
 *
 * Outcome rules:
 * - If the decision's question relates to an issue that was fixed → success
 * - If the issue was skipped/deferred → neutral
 * - If reopened (detected by findReopenedDecisions) → failure
 * - Otherwise → neutral (no clear signal)
 */
export function mapDecisionToOutcome(
  decision: Decision,
  issues: Issue[],
  reopenedDecisionIds: Set<string>,
  jobId?: string,
  index?: number,
): DecisionOutcome {
  // Append index to avoid collisions when multiple decisions share the same timestamp
  const baseId = `d-${decision.timestamp.replace(/[:.]/g, "-")}`;
  const decisionId = index != null ? `${baseId}-${index}` : baseId;

  // Check if any issue relates to this decision's question
  const relatedIssue = findRelatedIssue(decision, issues);

  let outcome: DecisionOutcome["outcome"] = "neutral";
  let outcomeDetail: string | undefined;

  if (reopenedDecisionIds.has(decisionId)) {
    outcome = "failure";
    outcomeDetail = "Issue reopened — same file + similar description in a later job";
  } else if (relatedIssue) {
    switch (relatedIssue.status) {
      case "fixed":
        outcome = "success";
        outcomeDetail = `Fixed: ${relatedIssue.id}`;
        break;
      case "skipped":
      case "deferred":
        outcome = "neutral";
        outcomeDetail = `${relatedIssue.status}: ${relatedIssue.id}`;
        break;
      case "open":
        outcome = "neutral";
        outcomeDetail = `Still open: ${relatedIssue.id}`;
        break;
    }
  }

  return {
    decisionId,
    timestamp: decision.timestamp,
    question: decision.question,
    chosen: decision.chosen,
    confidence: decision.confidence,
    principle: decision.principle,
    outcome,
    outcomeDetail,
    relatedFilePath: relatedIssue?.filePath,
    jobId,
  };
}

/**
 * Find an issue related to a decision by keyword matching.
 * Checks if the decision question or chosen answer mentions the issue ID,
 * file path, or overlapping description keywords.
 */
export function findRelatedIssue(
  decision: Decision,
  issues: Issue[],
): Issue | null {
  const decisionText = `${decision.question} ${decision.chosen}`.toLowerCase();

  // Check for direct issue ID mention
  for (const issue of issues) {
    if (decisionText.includes(issue.id.toLowerCase())) {
      return issue;
    }
  }

  // Check for file path mention
  for (const issue of issues) {
    if (issue.filePath && decisionText.includes(issue.filePath.toLowerCase())) {
      return issue;
    }
  }

  // Check for description keyword overlap (at least 3 words matching)
  for (const issue of issues) {
    if (!issue.description) continue; // Guard against corrupt/missing description
    // Cap description to prevent excessive memory from malformed checkpoint data
    const descText = issue.description.length > 2000 ? issue.description.slice(0, 2000) : issue.description;
    const issueWords = new Set(
      descText.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
    );
    const decisionWords = decisionText.split(/\s+/).filter((w) => w.length > 3);
    const matches = decisionWords.filter((w) => issueWords.has(w)).length;
    if (matches >= 3) {
      return issue;
    }
  }

  return null;
}

// ── Reflection runner ───────────────────────────────────────────

export interface ReflectionInput {
  decisions: Decision[];
  issues: Issue[];
  jobId?: string;
  projectDir: string;
  memoryConfig?: OracleMemoryConfig;
  onWarn?: WarnFn;
  /** Callback to invalidate a cached Oracle decision (e.g., on failure outcome). */
  onCacheInvalidate?: (question: string, options: { label: string }[]) => void;
}

export interface ReflectionResult {
  outcomes: DecisionOutcome[];
  metrics: OracleMetrics;
  reopenedCount: number;
}

/**
 * Run post-job reflection: map decisions to outcomes, detect reopened issues,
 * update decision-outcomes.md, and update metrics.json.
 *
 * Pre-existing decisions (from before Phase 5b, with no outcome data) are
 * excluded from quality metrics — only post-reflection entries contribute.
 */
export function runReflection(input: ReflectionInput): ReflectionResult {
  const memConfig = input.memoryConfig ?? defaultMemoryConfig(input.projectDir);
  const warn = resolveWarnFn(input.onWarn);

  // Acquire lock before reading+writing oracle memory (prevents concurrent clobber)
  const lockAcquired = acquireReflectionLock(memConfig.projectDir);
  if (!lockAcquired) {
    warn("[GaryClaw] Could not acquire reflection lock (timeout) — skipping reflection writes");
    // Still compute outcomes for the return value, but don't write to disk
    const existingOutcomes = readDecisionOutcomes(memConfig);
    const reopenedIds = findReopenedDecisions(input.issues, existingOutcomes);
    const newOutcomes: DecisionOutcome[] = input.decisions.map((d, i) =>
      mapDecisionToOutcome(d, input.issues, reopenedIds, input.jobId, i),
    );
    return {
      outcomes: newOutcomes,
      metrics: readMetrics(memConfig),
      reopenedCount: reopenedIds.size,
    };
  }

  try {
    // Read existing outcomes for reopened detection
    const existingOutcomes = readDecisionOutcomes(memConfig);

    // Find reopened decisions
    const reopenedIds = findReopenedDecisions(input.issues, existingOutcomes);

    // Map each decision to an outcome
    const newOutcomes: DecisionOutcome[] = input.decisions.map((d, i) =>
      mapDecisionToOutcome(d, input.issues, reopenedIds, input.jobId, i),
    );

    // Merge with existing outcomes
    const allOutcomes = [...existingOutcomes, ...newOutcomes];

    // Write updated outcomes (rolling window of ~50)
    try {
      writeDecisionOutcomesRolling(memConfig, allOutcomes);
    } catch (err) {
      warn(`[GaryClaw] Failed to write decision outcomes: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Update metrics
    let metrics = readMetrics(memConfig);
    for (const outcome of newOutcomes) {
      metrics = updateMetricsWithOutcome(metrics, outcome);
    }
    metrics.lastReflectionTimestamp = new Date().toISOString();
    try {
      writeMetrics(memConfig, metrics);
    } catch (err) {
      warn(`[GaryClaw] Failed to write metrics: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      outcomes: newOutcomes,
      metrics,
      reopenedCount: reopenedIds.size,
    };
  } finally {
    releaseReflectionLock(memConfig.projectDir);
  }
}

// ── Read decisions from JSONL ───────────────────────────────────

/**
 * Read decisions from a decisions.jsonl file.
 * Returns an empty array if the file doesn't exist or is empty.
 */
export function readDecisionsFromLog(decisionLogPath: string, onWarn?: WarnFn): Decision[] {
  const content = safeReadText(decisionLogPath);
  if (!content) return [];

  const warn = resolveWarnFn(onWarn);
  const decisions: Decision[] = [];
  for (const line of content.split("\n").filter(Boolean)) {
    try {
      const d = JSON.parse(line);
      if (d.question && d.chosen) {
        decisions.push(d as Decision);
      }
    } catch {
      // Log warning for corrupt lines so silent data loss is visible
      warn(`[reflection] Skipped corrupt JSONL line: ${line.slice(0, 120)}`);
    }
  }
  return decisions;
}

// NOTE: Design deviation — the original design called for a sandboxed SDK query()
// call with createReflectionCanUseTool(). The algorithmic approach in runReflection()
// is better: deterministic, no API cost, no latency. The sandboxed canUseTool was
// built and tested but never wired into production, so it was removed as dead code.

// ── Pipeline outcome tracking (for Oracle-driven composition) ────

/**
 * Build a human-readable pipeline outcome summary line for decision-outcomes.md.
 *
 * Outcome classification:
 * - "success": 0 QA issues
 * - "acceptable": 1-2 QA issues (minor, not worth restoring skipped skills)
 * - "failure": 3+ QA issues (skipping a skill likely caused problems)
 */
export function buildPipelineOutcome(
  job: { skills: string[]; composedFrom?: string[]; compositionMethod?: string },
  qaIssueCount: number,
  totalCostUsd: number,
): string {
  const skippedSkills = (job.composedFrom ?? []).filter(s => !job.skills.includes(s));
  const outcome = qaIssueCount === 0 ? "success" : qaIssueCount <= 2 ? "acceptable" : "failure";

  return [
    `Pipeline: [${job.skills.join(" -> ")}]`,
    skippedSkills.length > 0 ? `Skipped: [${skippedSkills.join(", ")}]` : null,
    `Method: ${job.compositionMethod ?? "none"}`,
    `QA issues: ${qaIssueCount}`,
    `Cost: $${totalCostUsd.toFixed(2)}`,
    `Outcome: ${outcome}`,
  ].filter(Boolean).join(" | ");
}

/**
 * Count pipeline outcome entries in decision-outcomes.md content.
 * Used for the cold-start gate: oracle recommendations require 10+ outcomes.
 *
 * Pipeline outcomes are identified by lines starting with "Pipeline: [".
 */
export function countPipelineOutcomes(decisionOutcomes: string | null): number {
  if (!decisionOutcomes) return 0;
  return (decisionOutcomes.match(/^Pipeline: \[/gm) || []).length;
}
