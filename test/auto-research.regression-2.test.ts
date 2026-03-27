/**
 * Regression tests for auto-research.ts edge cases.
 *
 * ISSUE-007 — extractTopicKeywords: all-stopwords input returns empty
 * ISSUE-008 — isTopicGroupFresh: empty string domain expertise
 * ISSUE-009 — groupDecisionsByTopic: decisions with no extractable keywords
 *
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 */

import { describe, it, expect } from "vitest";
import {
  extractTopicKeywords,
  groupDecisionsByTopic,
  isTopicGroupFresh,
  getResearchTopics,
  DEFAULT_AUTO_RESEARCH_CONFIG,
} from "../src/auto-research.js";
import type { Decision, AutoResearchConfig } from "../src/types.js";

function makeDecision(question: string, confidence: number): Decision {
  return {
    timestamp: new Date().toISOString(),
    sessionIndex: 0,
    question,
    options: [{ label: "A", description: "yes" }, { label: "B", description: "no" }],
    chosen: "A",
    confidence,
    rationale: "test",
    principle: "test",
  };
}

// ── extractTopicKeywords edge cases ────────────────────────────

describe("extractTopicKeywords edge cases", () => {
  it("returns empty array for all-stopwords question", () => {
    // "which and the or" — all stopwords or <=2 chars
    const result = extractTopicKeywords("which and the or but can has");
    expect(result).toEqual([]);
  });

  it("returns empty array for question with only 1-2 char words", () => {
    const result = extractTopicKeywords("is it ok to do so?");
    // "is"=2, "it"=2, "ok"=2, "to"=2, "do"=2, "so"=2 — all <=2 chars
    expect(result).toEqual([]);
  });

  it("returns empty for empty string", () => {
    expect(extractTopicKeywords("")).toEqual([]);
  });

  it("returns empty for null-ish (undefined-like) input", () => {
    expect(extractTopicKeywords("")).toEqual([]);
  });

  it("handles question where all words after stopword filter are duplicates", () => {
    const result = extractTopicKeywords(
      "websocket websocket websocket connection connection",
    );
    // Dedup: should return ["websocket", "connection"]
    expect(result).toEqual(["websocket", "connection"]);
  });
});

// ── groupDecisionsByTopic edge cases ───────────────────────────

describe("groupDecisionsByTopic edge cases", () => {
  const config: AutoResearchConfig = {
    ...DEFAULT_AUTO_RESEARCH_CONFIG,
    lowConfidenceThreshold: 6,
  };

  it("skips decisions whose keywords extract to empty", () => {
    const decisions = [
      makeDecision("should we use the or not?", 3), // all stopwords
      makeDecision("websocket library performance tuning", 3),
      makeDecision("websocket library real-time streaming", 3),
      makeDecision("websocket library latency optimization", 3),
    ];
    const groups = groupDecisionsByTopic(decisions, config);
    // The first decision has no keywords → shouldn't create its own group or crash
    // Remaining 3 share "websocket" + "library" → 1 group
    expect(groups.length).toBeGreaterThanOrEqual(1);
    // The all-stopwords decision shouldn't appear in any group
    for (const g of groups) {
      for (const d of g.decisions) {
        expect(d.question).not.toBe("should we use the or not?");
      }
    }
  });

  it("returns empty array when no decisions are below confidence threshold", () => {
    const decisions = [
      makeDecision("websocket library performance", 8),
      makeDecision("websocket library streaming", 9),
    ];
    const groups = groupDecisionsByTopic(decisions, config);
    expect(groups).toEqual([]);
  });

  it("creates separate groups when decisions share <2 keywords", () => {
    const decisions = [
      makeDecision("websocket library performance tuning", 3),
      makeDecision("database migration schema changes", 3),
    ];
    const groups = groupDecisionsByTopic(decisions, config);
    // 0 shared keywords → separate groups
    expect(groups).toHaveLength(2);
  });
});

// ── isTopicGroupFresh edge cases ───────────────────────────────

describe("isTopicGroupFresh edge cases", () => {
  it("returns false for null domain expertise", () => {
    expect(isTopicGroupFresh(["websocket", "library"], null)).toBe(false);
  });

  it("returns false for empty string domain expertise", () => {
    // Empty string → parseDomainSections returns no sections → no match
    expect(isTopicGroupFresh(["websocket", "library"], "")).toBe(false);
  });

  it("returns false when keywords don't match any section", () => {
    const expertise = [
      "## Database Migration",
      "---",
      "researched_at: 2026-03-27",
      "---",
      "Use pgloader for large migrations.",
    ].join("\n");
    expect(isTopicGroupFresh(["websocket", "library"], expertise)).toBe(false);
  });

  it("returns false for empty keywords array", () => {
    const expertise = [
      "## WebSocket Library",
      "---",
      "researched_at: 2026-03-27",
      "---",
      "Use ws for Node.js.",
    ].join("\n");
    // Empty keywords → 0 overlap < 2 → no match
    expect(isTopicGroupFresh([], expertise)).toBe(false);
  });
});

// ── getResearchTopics edge cases ───────────────────────────────

describe("getResearchTopics edge cases", () => {
  it("returns empty when all decisions are high confidence", () => {
    const decisions = [
      makeDecision("websocket library choice", 9),
      makeDecision("websocket streaming method", 8),
    ];
    const result = getResearchTopics(decisions, null, DEFAULT_AUTO_RESEARCH_CONFIG);
    expect(result).toEqual([]);
  });

  it("returns empty when low-confidence decisions don't meet minDecisionsToTrigger", () => {
    const config: AutoResearchConfig = {
      ...DEFAULT_AUTO_RESEARCH_CONFIG,
      minDecisionsToTrigger: 5,
    };
    const decisions = [
      makeDecision("websocket library performance", 3),
      makeDecision("websocket library streaming", 3),
    ];
    const result = getResearchTopics(decisions, null, config);
    expect(result).toEqual([]);
  });
});
