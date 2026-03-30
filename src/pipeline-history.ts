/**
 * Pipeline History — outcome tracking and skip-risk scoring for Oracle-driven composition.
 *
 * I/O helpers (readPipelineOutcomes, appendPipelineOutcome) are called from job-runner.
 * Core scoring functions are pure — no I/O, fully testable with synthetic data.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PipelineOutcomeRecord } from "./types.js";

// ── I/O helpers ──────────────────────────────────────────────────

/**
 * Read pipeline outcome records from a JSONL file.
 * Returns empty array on missing/corrupt file. Silently skips malformed lines.
 */
export function readPipelineOutcomes(path: string): PipelineOutcomeRecord[] {
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const records: PipelineOutcomeRecord[] = [];
  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PipelineOutcomeRecord;
      // Minimal validation: must have jobId and outcome
      if (parsed.jobId && parsed.outcome) {
        records.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

/** Maximum entries to keep in pipeline-outcomes.jsonl.
 *  Covers 5x the decay half-life (20), so records older than 100
 *  contribute < 3% weight and aren't worth the I/O. */
export const MAX_PIPELINE_OUTCOMES = 100;

/**
 * Append a single pipeline outcome record to a JSONL file.
 * Creates parent directories if needed. Truncates oldest entries
 * when the file exceeds MAX_PIPELINE_OUTCOMES. Best-effort — never throws.
 */
export function appendPipelineOutcome(path: string, record: PipelineOutcomeRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");

    // Truncate oldest entries when file exceeds cap
    truncatePipelineOutcomes(path, MAX_PIPELINE_OUTCOMES);
  } catch {
    // Best-effort — don't crash the job runner if JSONL write fails
  }
}

/**
 * Truncate a JSONL file to keep only the most recent `maxEntries` lines.
 * No-op if file has fewer entries or doesn't exist. Best-effort.
 */
export function truncatePipelineOutcomes(path: string, maxEntries: number): void {
  try {
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length <= maxEntries) return;

    const kept = lines.slice(lines.length - maxEntries);
    writeFileSync(path, kept.join("\n") + "\n", "utf-8");
  } catch {
    // Best-effort — never crash
  }
}

// ── Pure scoring functions ───────────────────────────────────────

/** Default exponential decay half-life in number of jobs. */
export const DEFAULT_DECAY_HALF_LIFE = 20;

/** Minimum number of skips before a risk score is meaningful. */
export const MIN_SKIP_SAMPLES = 3;

/** Default threshold above which Oracle restores a skipped skill. */
export const DEFAULT_SKIP_RISK_THRESHOLD = 0.3;

/** Minimum sample size for circuit breaker evaluation. */
export const DEFAULT_CIRCUIT_BREAKER_MIN_SAMPLES = 10;

/** Margin by which Oracle failure rate must exceed static to trip the breaker. */
export const CIRCUIT_BREAKER_MARGIN = 0.1;

/**
 * Compute skip-risk scores per skill from historical pipeline outcomes.
 *
 * For each skill that was ever skipped:
 *   skipRisk = weightedFailures / weightedTotal
 *   where weight = 0.5 ^ (age_in_jobs / halfLife)
 *
 * Skills with fewer than MIN_SKIP_SAMPLES skips return 0 (insufficient data).
 *
 * @param outcomes - Historical pipeline outcome records (oldest first is fine; ordering doesn't matter)
 * @param decayHalfLife - Number of jobs for weight to halve (default: 20)
 * @returns Map from skill name to risk score (0.0-1.0)
 */
export function computeSkipRiskScores(
  outcomes: PipelineOutcomeRecord[],
  decayHalfLife: number = DEFAULT_DECAY_HALF_LIFE,
): Map<string, number> {
  const scores = new Map<string, number>();
  if (outcomes.length === 0) return scores;

  // Collect all skills that were ever skipped
  const allSkippedSkills = new Set<string>();
  for (const o of outcomes) {
    for (const s of o.skippedSkills) {
      allSkippedSkills.add(s);
    }
  }

  const totalJobs = outcomes.length;

  for (const skill of allSkippedSkills) {
    let weightedFailures = 0;
    let weightedTotal = 0;
    let skipCount = 0;

    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      if (!o.skippedSkills.includes(skill)) continue;

      skipCount++;
      // Age = distance from end of array (most recent = 0)
      const ageInJobs = totalJobs - 1 - i;
      const weight = Math.pow(0.5, ageInJobs / decayHalfLife);

      weightedTotal += weight;
      if (o.outcome !== "success") {
        weightedFailures += weight;
      }
    }

    // Require minimum samples before producing a meaningful score
    if (skipCount < MIN_SKIP_SAMPLES) {
      scores.set(skill, 0);
      continue;
    }

    scores.set(skill, weightedTotal > 0 ? weightedFailures / weightedTotal : 0);
  }

  return scores;
}

/**
 * Determine whether Oracle composition adjustments should be active.
 *
 * Circuit breaker logic:
 *   If Oracle-adjusted jobs have a failure rate > static-only jobs + margin,
 *   AND there are enough Oracle-adjusted samples, return false.
 *
 * Returns true (enable Oracle adjustments) when:
 * - Not enough data to evaluate (< minSampleSize Oracle-adjusted jobs)
 * - Oracle adjustments are performing as well or better than static
 *
 * @param outcomes - Historical pipeline outcome records
 * @param minSampleSize - Minimum Oracle-adjusted jobs before circuit breaker can trip (default: 10)
 * @returns true if Oracle composition should be used
 */
export function shouldUseOracleComposition(
  outcomes: PipelineOutcomeRecord[],
  minSampleSize: number = DEFAULT_CIRCUIT_BREAKER_MIN_SAMPLES,
): boolean {
  const oracleAdjusted = outcomes.filter(o => o.oracleAdjusted);
  const staticOnly = outcomes.filter(o => !o.oracleAdjusted);

  // Not enough Oracle-adjusted data — keep using Oracle (default on)
  if (oracleAdjusted.length < minSampleSize) return true;

  const oracleFailureRate = oracleAdjusted.filter(o => o.outcome !== "success").length / oracleAdjusted.length;
  const staticFailureRate = staticOnly.length > 0
    ? staticOnly.filter(o => o.outcome !== "success").length / staticOnly.length
    : 0;

  // Trip breaker if Oracle is meaningfully worse than static
  return !(oracleFailureRate > staticFailureRate + CIRCUIT_BREAKER_MARGIN);
}

/**
 * Compute failure rates for Oracle-adjusted and static-only jobs.
 * Used by dashboard to display composition intelligence metrics.
 *
 * @returns Object with oracleFailureRate and staticFailureRate as percentages (0-100)
 */
export function computeFailureRates(
  outcomes: PipelineOutcomeRecord[],
): { oracleFailureRate: number; staticFailureRate: number; oracleAdjustedCount: number; staticOnlyCount: number } {
  const oracleAdjusted = outcomes.filter(o => o.oracleAdjusted);
  const staticOnly = outcomes.filter(o => !o.oracleAdjusted);

  const oracleFailureRate = oracleAdjusted.length > 0
    ? (oracleAdjusted.filter(o => o.outcome !== "success").length / oracleAdjusted.length) * 100
    : 0;
  const staticFailureRate = staticOnly.length > 0
    ? (staticOnly.filter(o => o.outcome !== "success").length / staticOnly.length) * 100
    : 0;

  return {
    oracleFailureRate,
    staticFailureRate,
    oracleAdjustedCount: oracleAdjusted.length,
    staticOnlyCount: staticOnly.length,
  };
}

// ── Per-category stats ──────────────────────────────────────────

/** Minimum total outcomes (skipped + included) per (category, skill) pair to include in stats. */
export const MIN_CATEGORY_SAMPLES = 3;

export interface CategorySkillStat {
  category: string;
  skill: string;
  skippedCount: number;
  skippedFailureRate: number;   // 0-100
  includedCount: number;
  includedFailureRate: number;  // 0-100
}

/**
 * Compute per-category, per-skill outcome stats from pipeline history.
 *
 * For each (category, skill) pair across all outcomes:
 *   "skipped"  = skill appears in record.skippedSkills
 *   "included" = skill appears in record.skills
 *
 * Filters to pairs with MIN_CATEGORY_SAMPLES+ total outcomes.
 * Returns sorted by failure rate delta (skippedFailureRate - includedFailureRate), biggest gap first.
 *
 * Pure function — no I/O.
 */
export function computeCategoryStats(
  outcomes: PipelineOutcomeRecord[],
): CategorySkillStat[] {
  if (outcomes.length === 0) return [];

  // Accumulator: Map<"category|skill", { skipped: { total, failures }, included: { total, failures } }>
  const acc = new Map<string, {
    skipped: { total: number; failures: number };
    included: { total: number; failures: number };
  }>();

  for (const o of outcomes) {
    const cat = o.taskCategory ?? "unknown";

    for (const skill of o.skippedSkills) {
      const key = `${cat}|${skill}`;
      if (!acc.has(key)) acc.set(key, { skipped: { total: 0, failures: 0 }, included: { total: 0, failures: 0 } });
      const entry = acc.get(key)!;
      entry.skipped.total++;
      if (o.outcome !== "success") entry.skipped.failures++;
    }

    for (const skill of o.skills) {
      const key = `${cat}|${skill}`;
      if (!acc.has(key)) acc.set(key, { skipped: { total: 0, failures: 0 }, included: { total: 0, failures: 0 } });
      const entry = acc.get(key)!;
      entry.included.total++;
      if (o.outcome !== "success") entry.included.failures++;
    }
  }

  const stats: CategorySkillStat[] = [];
  for (const [key, data] of acc) {
    const totalSamples = data.skipped.total + data.included.total;
    if (totalSamples < MIN_CATEGORY_SAMPLES) continue;

    const [category, skill] = key.split("|");
    const skippedFailureRate = data.skipped.total > 0
      ? (data.skipped.failures / data.skipped.total) * 100
      : 0;
    const includedFailureRate = data.included.total > 0
      ? (data.included.failures / data.included.total) * 100
      : 0;

    stats.push({
      category,
      skill,
      skippedCount: data.skipped.total,
      skippedFailureRate,
      includedCount: data.included.total,
      includedFailureRate,
    });
  }

  // Sort by delta (biggest gap first — where skipping hurts most)
  stats.sort((a, b) => {
    const deltaA = a.skippedFailureRate - a.includedFailureRate;
    const deltaB = b.skippedFailureRate - b.includedFailureRate;
    return deltaB - deltaA;
  });

  return stats;
}
