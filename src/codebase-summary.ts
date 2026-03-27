/**
 * Codebase Summary — extracts, deduplicates, and formats codebase
 * observations from assistant messages for relay prompt injection.
 *
 * Passive extraction: mines existing assistant text for observations
 * about naming conventions, failed approaches, key utilities, etc.
 * No extra SDK calls — zero overhead on the checkpoint/relay hot path.
 */

import { normalizedLevenshtein } from "./reflection.js";
import { estimateTokens } from "./checkpoint.js";
import type { CodebaseSummary } from "./types.js";

// ── Constants ────────────────────────────────────────────────────

/** Signal words that indicate a codebase observation (case-insensitive match). */
const SIGNAL_WORDS = [
  "convention",
  "pattern",
  "uses",
  "avoid",
  "failed",
  "tried",
  "always",
  "never",
  "don't",
  "instead",
  "already exists",
  "naming",
  "structure",
  "architecture",
  "organized",
];

/** Negative patterns — narration, not observations. Case-insensitive. */
const NEGATIVE_PATTERNS = [
  /\bi don't see\b/i,
  /\bi'll try\b/i,
  /\blet me try\b/i,
  /\bi always check\b/i,
  /\bi tried running\b/i,
  /\blet me check\b/i,
];

/** Code anchor: file path or function call. */
const CODE_ANCHOR_RE = /[a-zA-Z][\w.-]+\.\w+|[a-zA-Z]\w+\(\)/;

/** Token budgets for summary sections. */
const FAILED_APPROACHES_TOKEN_BUDGET = 500;
const OBSERVATIONS_TOKEN_BUDGET = 1_500;

// ── Extraction ───────────────────────────────────────────────────

/**
 * Split text into candidate sentences.
 * Split on newlines, then on ". " (period-space) within lines.
 * Discard sentences shorter than 20 chars or longer than 300 chars.
 */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const parts = line.split(". ");
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length >= 20 && trimmed.length <= 300) {
        sentences.push(trimmed);
      }
    }
  }
  return sentences;
}

/**
 * Count how many signal words appear in a sentence (case-insensitive).
 */
function countSignalWords(sentence: string): number {
  const lower = sentence.toLowerCase();
  let count = 0;
  for (const word of SIGNAL_WORDS) {
    if (lower.includes(word)) count++;
  }
  return count;
}

/**
 * Check if a sentence matches any negative pattern.
 */
function matchesNegativePattern(sentence: string): boolean {
  return NEGATIVE_PATTERNS.some((re) => re.test(sentence));
}

/**
 * Check if a sentence contains a code anchor (file path or function call).
 */
function hasCodeAnchor(sentence: string): boolean {
  return CODE_ANCHOR_RE.test(sentence);
}

/**
 * Extract candidate observation sentences from assistant text.
 *
 * Requires 2+ signal words to pass, unless the sentence contains a
 * code anchor (file path or function call), in which case 1 signal word suffices.
 * Sentences matching negative patterns are excluded.
 */
export function extractObservations(text: string): string[] {
  const sentences = splitSentences(text);
  const results: string[] = [];

  for (const sentence of sentences) {
    if (matchesNegativePattern(sentence)) continue;

    const signalCount = countSignalWords(sentence);
    const codeAnchored = hasCodeAnchor(sentence);

    // 2+ signal words required, or 1+ with code anchor
    if (signalCount >= 2 || (signalCount >= 1 && codeAnchored)) {
      results.push(sentence);
    }
  }

  return results;
}

/**
 * Extract "tried X but Y" patterns — highest-value observations for
 * preventing re-exploration of failed approaches.
 *
 * Match sentences containing ("tried" or "attempted") AND
 * ("but" or "however" or "failed" or "doesn't work" or "broke").
 */
export function extractFailedApproaches(text: string): string[] {
  const sentences = splitSentences(text);
  const results: string[] = [];

  const tryWords = ["tried", "attempted"];
  const failWords = ["but", "however", "failed", "doesn't work", "broke"];

  for (const sentence of sentences) {
    // Skip narration
    if (matchesNegativePattern(sentence)) continue;

    const lower = sentence.toLowerCase();
    const hasTry = tryWords.some((w) => lower.includes(w));
    const hasFail = failWords.some((w) => lower.includes(w));

    if (hasTry && hasFail) {
      results.push(sentence);
    }
  }

  return results;
}

// ── Deduplication ────────────────────────────────────────────────

/**
 * Remove near-duplicate observations using normalized Levenshtein distance.
 * threshold defaults to 0.3 (matching reflection.ts convention: < 0.3 = similar).
 * Keeps the first occurrence of each near-duplicate group.
 */
export function deduplicateObservations(
  observations: string[],
  threshold: number = 0.3,
): string[] {
  const result: string[] = [];

  for (const obs of observations) {
    const isDuplicate = result.some(
      (existing) => normalizedLevenshtein(existing, obs) < threshold,
    );
    if (!isDuplicate) {
      result.push(obs);
    }
  }

  return result;
}

// ── Token budget ─────────────────────────────────────────────────

/**
 * Drop oldest entries (from the front) until total estimated tokens
 * are under budget. Returns a new array.
 */
export function truncateToTokenBudget(entries: string[], maxTokens: number): string[] {
  let total = entries.reduce((sum, e) => sum + estimateTokens(e), 0);
  let startIdx = 0;

  while (total > maxTokens && startIdx < entries.length) {
    total -= estimateTokens(entries[startIdx]);
    startIdx++;
  }

  return entries.slice(startIdx);
}

// ── Build summary ────────────────────────────────────────────────

/**
 * Merge previous summary with new observations, deduplicate, and enforce
 * token budget. Previous observations come first (newer appended), so
 * truncation drops oldest when budget is tight.
 */
export function buildCodebaseSummary(
  current: CodebaseSummary | undefined,
  newObservations: string[],
  newFailed: string[],
  sessionIndex: number,
): CodebaseSummary {
  // Merge: previous first, then new
  const mergedObservations = [
    ...(current?.observations ?? []),
    ...newObservations,
  ];
  const mergedFailed = [
    ...(current?.failedApproaches ?? []),
    ...newFailed,
  ];

  // Deduplicate
  const dedupedObservations = deduplicateObservations(mergedObservations);
  const dedupedFailed = deduplicateObservations(mergedFailed);

  // Enforce token budgets independently
  const truncatedObservations = truncateToTokenBudget(
    dedupedObservations,
    OBSERVATIONS_TOKEN_BUDGET,
  );
  const truncatedFailed = truncateToTokenBudget(
    dedupedFailed,
    FAILED_APPROACHES_TOKEN_BUDGET,
  );

  return {
    observations: truncatedObservations,
    failedApproaches: truncatedFailed,
    lastSessionIndex: sessionIndex,
  };
}

// ── Formatting ───────────────────────────────────────────────────

/**
 * Format codebase summary as a markdown section for the relay prompt.
 * Returns empty string if both arrays are empty.
 */
export function formatCodebaseSummaryForRelay(summary: CodebaseSummary): string {
  if (summary.observations.length === 0 && summary.failedApproaches.length === 0) {
    return "";
  }

  let text = `\n## Codebase Context (carried from sessions 0-${summary.lastSessionIndex})\n`;

  if (summary.failedApproaches.length > 0) {
    text += "\n**Approaches that failed (don't retry):**\n";
    for (const approach of summary.failedApproaches) {
      text += `- ${approach}\n`;
    }
  }

  if (summary.observations.length > 0) {
    text += "\n**Observations:**\n";
    for (const obs of summary.observations) {
      text += `- ${obs}\n`;
    }
  }

  return text;
}
