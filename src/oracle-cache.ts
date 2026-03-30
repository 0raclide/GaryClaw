/**
 * Oracle Decision Cache — sticky answers for repeated questions.
 *
 * When the Oracle answers the same question identically N+ times (default: 5),
 * the cache short-circuits future calls at zero cost. Questions are normalized
 * by stripping variable tokens (file paths, numbers, timestamps, branch names,
 * quoted strings) and reducing to a sorted keyword bag.
 *
 * Cache lifecycle:
 * 1. Warm from decision-outcomes.md at startup (pre-populate known patterns)
 * 2. Record every Oracle answer at runtime (accumulate hit counts)
 * 3. Promote to cache when a key+answer pair reaches minHits
 * 4. Invalidate on reflection failure (cached answer produced bad outcome)
 *
 * Integration points:
 * - ask-handler.ts: lookup before Oracle call, record after
 * - orchestrator.ts: initialize + warm per skill
 * - reflection.ts: invalidate on failure outcome
 */

import type { DecisionOutcome } from "./types.js";

// ── Normalization ────────────────────────────────────────────────

/** Filler words stripped during normalization. */
const FILLER_WORDS = new Set([
  "the", "a", "an", "is", "are", "on", "in", "for", "to", "with",
  "and", "or", "your", "this", "that", "it", "of", "do", "does",
  "should", "would", "could", "can", "will", "be", "been", "being",
  "have", "has", "had", "not", "no", "yes", "i", "we", "you", "my",
  "what", "how", "when", "where", "which", "why", "who", "whom",
  "there", "here", "from", "about", "into", "through", "during",
  "before", "after", "above", "below", "between", "but", "if", "then",
  "than", "so", "at", "by", "up", "out", "off", "over", "under",
]);

/** Patterns stripped before keyword extraction. */
const STRIP_PATTERNS = [
  // File paths: /foo/bar/baz.ts or ./foo/bar (must have at least 2 path segments)
  /(?:\.?\/[\w.-]+\/[\w./-]+)/g,
  // Backtick-quoted strings longer than 20 chars
  /`[^`]{21,}`/g,
  // Double-quoted strings longer than 20 chars
  /"[^"]{21,}"/g,
  // Single-quoted strings longer than 20 chars
  /'[^']{21,}'/g,
  // ISO timestamps: 2026-03-30T12:34:56.789Z
  /\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g,
  // Dates: 2026-03-30
  /\d{4}-\d{2}-\d{2}/g,
  // Numbers with commas or standalone: 2,978 or 184
  /\b[\d,]+\b/g,
];

/**
 * Normalize a question by stripping variable tokens and reducing to
 * a sorted, deduplicated keyword bag.
 *
 * "GaryClaw is a CLI tool with 2,978 vitest tests. There is no web UI.
 *  What QA approach should the /qa skill use?"
 *   → "approach cli garyclaw qa skill tool ui vitest web"
 */
export function normalizeQuestion(question: string): string {
  let text = question;

  // Strip variable patterns
  for (const pattern of STRIP_PATTERNS) {
    text = text.replace(pattern, " ");
  }

  // Lowercase, split into words, filter
  const words = text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 1 && !FILLER_WORDS.has(w));

  // Deduplicate and sort
  const unique = [...new Set(words)].sort();
  return unique.join(" ");
}

/**
 * Normalize option labels by sorting alphabetically and joining with "|".
 */
export function normalizeOptions(options: { label: string }[]): string {
  return options.map((o) => o.label).sort().join("|");
}

/**
 * Compute a cache key from normalized question and options.
 * Uses string concatenation (short enough for a Map key, no need for hashing).
 */
export function computeCacheKey(normalizedQuestion: string, normalizedOptions: string): string {
  return `${normalizedQuestion}\n${normalizedOptions}`;
}

// ── Cache data structures ────────────────────────────────────────

export interface CachedDecision {
  chosen: string;
  confidence: 10;
  rationale: string;
  principle: string;
  hitCount: number;
}

interface CacheEntry {
  /** Map from chosen answer → hit count. */
  answerCounts: Map<string, number>;
  /** Promoted answer (set when an answer reaches minHits). */
  promoted: CachedDecision | null;
  /** Most recent principle seen for the promoted answer. */
  lastPrinciple: string;
}

export interface OracleCacheStats {
  entries: number;
  promotedEntries: number;
  totalHits: number;
  totalMisses: number;
}

// ── OracleCache class ────────────────────────────────────────────

export class OracleCache {
  private readonly minHits: number;
  private readonly cache = new Map<string, CacheEntry>();
  private totalHits = 0;
  private totalMisses = 0;

  constructor(config: { minHits: number }) {
    this.minHits = config.minHits;
  }

  /**
   * Warm the cache from historical decision outcomes.
   * Groups outcomes by normalized key, promotes answers that appear minHits+ times.
   *
   * Note: decision-outcomes.md does not store options, so warm start matches
   * on question normalization only (key uses empty options string).
   * Runtime lookups with options will match via the question-only key
   * when no options-specific key exists.
   */
  warmFromOutcomes(outcomes: DecisionOutcome[]): void {
    // Group by normalized question → chosen → count
    const groups = new Map<string, Map<string, { count: number; principle: string }>>();

    for (const outcome of outcomes) {
      const normalizedQ = normalizeQuestion(outcome.question);
      // Warm start uses question-only key (no options in decision-outcomes.md)
      const key = computeCacheKey(normalizedQ, "");

      if (!groups.has(key)) {
        groups.set(key, new Map());
      }
      const answerMap = groups.get(key)!;
      const existing = answerMap.get(outcome.chosen) ?? { count: 0, principle: outcome.principle };
      existing.count++;
      existing.principle = outcome.principle; // Keep most recent
      answerMap.set(outcome.chosen, existing);
    }

    // Promote answers that reach minHits
    for (const [key, answerMap] of groups) {
      for (const [chosen, { count, principle }] of answerMap) {
        if (count >= this.minHits) {
          const entry: CacheEntry = {
            answerCounts: new Map([[chosen, count]]),
            promoted: {
              chosen,
              confidence: 10,
              rationale: `Cached: answered identically ${count} times`,
              principle: `P7 — Local evidence trumps general knowledge (originally ${principle})`,
              hitCount: 0,
            },
            lastPrinciple: principle,
          };
          this.cache.set(key, entry);
        }
      }
    }
  }

  /**
   * Look up a cached decision for a question + options.
   * Returns null on cache miss.
   *
   * Lookup strategy:
   * 1. Try exact key (normalized question + normalized options)
   * 2. Fall back to question-only key (from warm start)
   */
  lookup(question: string, options: { label: string }[]): CachedDecision | null {
    const normalizedQ = normalizeQuestion(question);
    const normalizedOpts = normalizeOptions(options);

    // Try exact key first
    const exactKey = computeCacheKey(normalizedQ, normalizedOpts);
    let entry = this.cache.get(exactKey);

    // Fall back to question-only key (warm start entries)
    if (!entry) {
      const questionOnlyKey = computeCacheKey(normalizedQ, "");
      entry = this.cache.get(questionOnlyKey);
    }

    if (entry?.promoted) {
      entry.promoted.hitCount++;
      this.totalHits++;
      return { ...entry.promoted };
    }

    this.totalMisses++;
    return null;
  }

  /**
   * Record an Oracle answer for future caching.
   * When a key+answer pair reaches minHits, it's promoted to the cache.
   */
  record(question: string, options: { label: string }[], chosen: string, principle: string = "Unknown"): void {
    const normalizedQ = normalizeQuestion(question);
    const normalizedOpts = normalizeOptions(options);
    const key = computeCacheKey(normalizedQ, normalizedOpts);

    let entry = this.cache.get(key);
    if (!entry) {
      entry = { answerCounts: new Map(), promoted: null, lastPrinciple: principle };
      this.cache.set(key, entry);
    }

    const currentCount = (entry.answerCounts.get(chosen) ?? 0) + 1;
    entry.answerCounts.set(chosen, currentCount);
    entry.lastPrinciple = principle;

    // Promote when threshold reached
    if (currentCount >= this.minHits && !entry.promoted) {
      entry.promoted = {
        chosen,
        confidence: 10,
        rationale: `Cached: answered identically ${currentCount} times`,
        principle: `P7 — Local evidence trumps general knowledge (originally ${principle})`,
        hitCount: 0,
      };
    }
  }

  /**
   * Invalidate a cache entry (e.g., when reflection detects a failure outcome).
   * Removes the promoted decision so future lookups miss.
   */
  invalidate(question: string, options: { label: string }[]): void {
    const normalizedQ = normalizeQuestion(question);
    const normalizedOpts = normalizeOptions(options);

    // Clear exact key
    const exactKey = computeCacheKey(normalizedQ, normalizedOpts);
    const exactEntry = this.cache.get(exactKey);
    if (exactEntry) {
      exactEntry.promoted = null;
      exactEntry.answerCounts.clear();
    }

    // Also clear question-only key (warm start entries)
    const questionOnlyKey = computeCacheKey(normalizedQ, "");
    if (questionOnlyKey !== exactKey) {
      const qEntry = this.cache.get(questionOnlyKey);
      if (qEntry) {
        qEntry.promoted = null;
        qEntry.answerCounts.clear();
      }
    }
  }

  /**
   * Return cache statistics.
   */
  stats(): OracleCacheStats {
    let promotedEntries = 0;
    for (const entry of this.cache.values()) {
      if (entry.promoted) promotedEntries++;
    }
    return {
      entries: this.cache.size,
      promotedEntries,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
    };
  }
}
