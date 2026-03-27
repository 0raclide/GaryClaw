/**
 * Auto-Research Trigger — analyzes low-confidence Oracle decisions post-job
 * and enqueues research jobs for topic areas where the Oracle struggled.
 *
 * Two pure functions:
 * - extractTopicKeywords(): extracts 2-5 significant words from a decision question
 * - groupDecisionsByTopic(): clusters decisions by shared keywords
 * - getResearchTopics(): returns topics that exceed the trigger threshold
 *
 * The job-runner calls getResearchTopics() after reflection and enqueues
 * research jobs for each returned topic.
 */

import type { AutoResearchConfig, Decision } from "./types.js";
import { isTopicStale, parseDomainSections } from "./researcher.js";

// ── Stop words ──────────────────────────────────────────────────

/** Stop words filtered from topic keyword extraction */
const STOP_WORDS = new Set([
  "should", "would", "could", "which", "what", "that", "this", "have",
  "with", "from", "they", "been", "were", "will", "does", "about",
  "into", "more", "some", "than", "other", "approach", "option",
  "decide", "choose", "best", "right", "use", "using", "used",
  "garyclaw", "oracle", "decision", "question", "answer",
]);

// ── Config defaults ─────────────────────────────────────────────

export const DEFAULT_AUTO_RESEARCH_CONFIG: AutoResearchConfig = {
  enabled: false,
  lowConfidenceThreshold: 6,
  minDecisionsToTrigger: 3,
  maxTopicsPerJob: 2,
};

// ── Topic group interface ───────────────────────────────────────

export interface TopicGroup {
  /** Synthesized topic label: top 3 keywords by frequency, title-cased, space-joined. */
  topic: string;
  keywords: string[];
  decisions: Decision[];
  avgConfidence: number;
}

// ── Keyword extraction ──────────────────────────────────────────

/**
 * Extract topic keywords from a decision question.
 * Returns 2-5 significant lowercased words (nouns, technical terms).
 *
 * Algorithm:
 * 1. Lowercase the entire question string
 * 2. Split on whitespace and punctuation
 * 3. Filter out words <= 3 chars
 * 4. Filter out STOP_WORDS
 * 5. Deduplicate
 * 6. Return first 5 remaining words (preserves original word order)
 */
export function extractTopicKeywords(question: string): string[] {
  if (!question) return [];

  const words = question
    .toLowerCase()
    .split(/[\s,;:?!.()\[\]{}"']+/)
    .filter((w) => w.length > 3)
    .filter((w) => !STOP_WORDS.has(w));

  // Deduplicate preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
    }
  }

  return unique.slice(0, 5);
}

// ── Topic grouping ──────────────────────────────────────────────

/**
 * Group low-confidence decisions by topic similarity.
 * Two decisions are in the same topic group if they share 2+ keywords.
 * Returns groups sorted by size (largest first).
 */
export function groupDecisionsByTopic(
  decisions: Decision[],
  config: AutoResearchConfig,
): TopicGroup[] {
  // Filter to low-confidence decisions only
  const lowConf = decisions.filter(
    (d) => d.confidence < config.lowConfidenceThreshold,
  );

  if (lowConf.length === 0) return [];

  // Extract keywords for each decision
  const decisionKeywords = lowConf.map((d) => ({
    decision: d,
    keywords: extractTopicKeywords(d.question),
  }));

  // Union-find-style grouping: merge decisions that share 2+ keywords
  const groups: { keywords: Set<string>; decisions: Decision[] }[] = [];

  for (const { decision, keywords } of decisionKeywords) {
    if (keywords.length === 0) continue;

    const keywordSet = new Set(keywords);

    // Find existing group with 2+ shared keywords
    let merged = false;
    for (const group of groups) {
      const shared = keywords.filter((k) => group.keywords.has(k));
      if (shared.length >= 2) {
        group.decisions.push(decision);
        for (const k of keywords) group.keywords.add(k);
        merged = true;
        break;
      }
    }

    if (!merged) {
      groups.push({
        keywords: keywordSet,
        decisions: [decision],
      });
    }
  }

  // Convert to TopicGroup format
  return groups
    .map((g) => {
      // Count keyword frequency across all decisions in this group
      const freq = new Map<string, number>();
      for (const d of g.decisions) {
        for (const k of extractTopicKeywords(d.question)) {
          if (g.keywords.has(k)) {
            freq.set(k, (freq.get(k) ?? 0) + 1);
          }
        }
      }

      // Top 3 keywords by frequency for topic label
      const topKeywords = [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k]) => k);

      // Title-case the topic label
      const topic = topKeywords
        .map((k) => k.charAt(0).toUpperCase() + k.slice(1))
        .join(" ");

      const avgConfidence =
        g.decisions.reduce((sum, d) => sum + d.confidence, 0) /
        g.decisions.length;

      return {
        topic,
        keywords: [...g.keywords],
        decisions: g.decisions,
        avgConfidence,
      };
    })
    .sort((a, b) => b.decisions.length - a.decisions.length);
}

// ── Research topic selection ────────────────────────────────────

/**
 * Check if a topic group's keywords overlap with any fresh domain expertise section.
 * A section is considered a match if 2+ of the group's keywords appear in the section's
 * topic name (case-insensitive). This handles synthesized topic labels like
 * "Websocket Library Performance" matching a section titled "WebSocket Library".
 */
export function isTopicGroupFresh(
  keywords: string[],
  existingDomainExpertise: string | null,
): boolean {
  if (!existingDomainExpertise) return false;

  const sections = parseDomainSections(existingDomainExpertise);

  for (const section of sections) {
    const sectionWords = section.topic.toLowerCase().split(/\s+/);
    const overlap = keywords.filter((k) => sectionWords.includes(k));
    if (overlap.length >= 2) {
      // Found a matching section — check if it's fresh
      return !isTopicStale(existingDomainExpertise, section.topic);
    }
  }

  return false;
}

/**
 * Determine which topics need research based on decision analysis.
 * Returns topic strings suitable for passing to runResearch().
 *
 * Rules:
 * - Only considers decisions with confidence < lowConfidenceThreshold
 * - Requires minDecisionsToTrigger decisions in the same topic group
 * - Returns at most maxTopicsPerJob topics
 * - Skips topics that are already fresh in domain-expertise.md (keyword-based match)
 */
export function getResearchTopics(
  decisions: Decision[],
  existingDomainExpertise: string | null,
  config: AutoResearchConfig,
): string[] {
  const groups = groupDecisionsByTopic(decisions, config);

  const topics: string[] = [];

  for (const group of groups) {
    if (topics.length >= config.maxTopicsPerJob) break;

    // Must meet minimum decisions threshold
    if (group.decisions.length < config.minDecisionsToTrigger) continue;

    // Check freshness — skip if a matching topic was recently researched
    if (isTopicGroupFresh(group.keywords, existingDomainExpertise)) continue;

    topics.push(group.topic);
  }

  return topics;
}
