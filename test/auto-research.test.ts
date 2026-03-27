import { describe, it, expect, vi } from "vitest";
import type { AutoResearchConfig, Decision } from "../src/types.js";
import {
  extractTopicKeywords,
  groupDecisionsByTopic,
  getResearchTopics,
  DEFAULT_AUTO_RESEARCH_CONFIG,
} from "../src/auto-research.js";
import type { TopicGroup } from "../src/auto-research.js";

// ── Helpers ─────────────────────────────────────────────────────

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    timestamp: new Date().toISOString(),
    sessionIndex: 0,
    question: "Should we use WebSocket or SSE?",
    options: [
      { label: "WebSocket", description: "Full duplex" },
      { label: "SSE", description: "Server-sent events" },
    ],
    chosen: "WebSocket",
    confidence: 4,
    rationale: "Not sure about the tradeoffs",
    principle: "P1",
    ...overrides,
  };
}

const defaultConfig: AutoResearchConfig = {
  enabled: true,
  lowConfidenceThreshold: 6,
  minDecisionsToTrigger: 3,
  maxTopicsPerJob: 2,
};

// ── extractTopicKeywords ────────────────────────────────────────

describe("extractTopicKeywords", () => {
  it("extracts technical terms from a question", () => {
    const keywords = extractTopicKeywords("Should we use PKCE for this OAuth flow?");
    expect(keywords).toContain("pkce");
    expect(keywords).toContain("oauth");
    expect(keywords).toContain("flow");
  });

  it("filters out common stop words", () => {
    const keywords = extractTopicKeywords("Which approach should we use for this question?");
    expect(keywords).not.toContain("which");
    expect(keywords).not.toContain("should");
    expect(keywords).not.toContain("approach");
    expect(keywords).not.toContain("question");
  });

  it("returns empty array for empty input", () => {
    expect(extractTopicKeywords("")).toEqual([]);
  });

  it("handles very long questions", () => {
    const longQuestion = "Should we " + "implement ".repeat(50) + "this feature?";
    const keywords = extractTopicKeywords(longQuestion);
    expect(keywords.length).toBeLessThanOrEqual(5);
  });

  it("normalizes to lowercase", () => {
    const keywords = extractTopicKeywords("WebSocket Library Selection");
    expect(keywords).toContain("websocket");
    expect(keywords).toContain("library");
    expect(keywords).toContain("selection");
  });

  it("preserves numbers in keywords", () => {
    const keywords = extractTopicKeywords("Should we use OAuth2 or OAuth3?");
    expect(keywords).toContain("oauth2");
    expect(keywords).toContain("oauth3");
  });

  it("returns at most 5 keywords", () => {
    const keywords = extractTopicKeywords(
      "WebSocket library performance benchmarks testing deployment monitoring security"
    );
    expect(keywords.length).toBeLessThanOrEqual(5);
  });

  it("handles special characters and punctuation", () => {
    const keywords = extractTopicKeywords("Is real-time sync (via WebSocket) needed?");
    expect(keywords).toContain("real-time");
    expect(keywords).toContain("sync");
    expect(keywords).toContain("websocket");
    expect(keywords).toContain("needed");
  });

  it("deduplicates keywords", () => {
    const keywords = extractTopicKeywords("OAuth flow or OAuth token?");
    const oauthCount = keywords.filter((k) => k === "oauth").length;
    expect(oauthCount).toBe(1);
  });

  it("filters words with 3 or fewer characters", () => {
    const keywords = extractTopicKeywords("Is the API key set for SSL?");
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("key");
    expect(keywords).not.toContain("set");
    expect(keywords).not.toContain("for");
    expect(keywords).not.toContain("ssl");
  });
});

// ── groupDecisionsByTopic ───────────────────────────────────────

describe("groupDecisionsByTopic", () => {
  it("groups decisions with shared keywords into one cluster", () => {
    const decisions = [
      makeDecision({ question: "Which WebSocket library should we pick?", confidence: 3 }),
      makeDecision({ question: "WebSocket library performance benchmarks?", confidence: 4 }),
      makeDecision({ question: "WebSocket library connection pooling?", confidence: 2 }),
    ];
    const groups = groupDecisionsByTopic(decisions, defaultConfig);
    expect(groups.length).toBe(1);
    expect(groups[0].decisions.length).toBe(3);
  });

  it("creates multiple clusters for different topics", () => {
    const decisions = [
      makeDecision({ question: "Which WebSocket library should we pick?", confidence: 3 }),
      makeDecision({ question: "WebSocket library performance?", confidence: 4 }),
      makeDecision({ question: "WebSocket library pooling approach?", confidence: 2 }),
      makeDecision({ question: "OAuth token refresh strategy?", confidence: 3 }),
      makeDecision({ question: "OAuth token expiration handling?", confidence: 4 }),
      makeDecision({ question: "OAuth token rotation policy?", confidence: 2 }),
    ];
    const groups = groupDecisionsByTopic(decisions, defaultConfig);
    expect(groups.length).toBe(2);
  });

  it("returns empty array when no low-confidence decisions", () => {
    const decisions = [
      makeDecision({ question: "Which framework?", confidence: 8 }),
      makeDecision({ question: "Which database?", confidence: 9 }),
    ];
    const groups = groupDecisionsByTopic(decisions, defaultConfig);
    expect(groups.length).toBe(0);
  });

  it("requires 2+ shared keywords to cluster", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "OAuth library selection?", confidence: 4 }),
    ];
    // "library" is shared but only 1 keyword — should not cluster
    const groups = groupDecisionsByTopic(decisions, defaultConfig);
    expect(groups.length).toBe(2);
  });

  it("sorts groups by size (largest first)", () => {
    const decisions = [
      makeDecision({ question: "OAuth token refresh?", confidence: 3 }),
      makeDecision({ question: "OAuth token expiration?", confidence: 4 }),
      makeDecision({ question: "WebSocket library perf?", confidence: 2 }),
      makeDecision({ question: "WebSocket library pool?", confidence: 3 }),
      makeDecision({ question: "WebSocket library retry?", confidence: 4 }),
    ];
    const groups = groupDecisionsByTopic(decisions, defaultConfig);
    expect(groups[0].decisions.length).toBeGreaterThanOrEqual(groups[groups.length - 1].decisions.length);
  });

  it("handles empty decisions array", () => {
    const groups = groupDecisionsByTopic([], defaultConfig);
    expect(groups).toEqual([]);
  });

  it("computes average confidence correctly", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 2 }),
      makeDecision({ question: "WebSocket library pooling?", confidence: 4 }),
    ];
    const groups = groupDecisionsByTopic(decisions, defaultConfig);
    expect(groups[0].avgConfidence).toBe(3);
  });

  it("only considers low-confidence decisions", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library pooling?", confidence: 8 }), // high confidence
    ];
    const groups = groupDecisionsByTopic(decisions, defaultConfig);
    // Only 1 low-confidence decision, so group has 1
    expect(groups[0].decisions.length).toBe(1);
  });

  it("generates title-cased topic labels from top keywords", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library connection?", confidence: 4 }),
      makeDecision({ question: "WebSocket library timeout?", confidence: 2 }),
    ];
    const groups = groupDecisionsByTopic(decisions, defaultConfig);
    expect(groups[0].topic).toMatch(/^[A-Z]/); // Title-cased
    expect(groups[0].topic.split(" ").length).toBeLessThanOrEqual(3);
  });

  it("handles decisions with no extractable keywords", () => {
    const decisions = [
      makeDecision({ question: "Yes or no?", confidence: 2 }),
      makeDecision({ question: "OK?", confidence: 3 }),
    ];
    const groups = groupDecisionsByTopic(decisions, defaultConfig);
    expect(groups).toEqual([]);
  });
});

// ── getResearchTopics ───────────────────────────────────────────

describe("getResearchTopics", () => {
  it("returns topics when threshold is met", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library connection pooling?", confidence: 4 }),
      makeDecision({ question: "WebSocket library retry strategy?", confidence: 2 }),
    ];
    const topics = getResearchTopics(decisions, null, defaultConfig);
    expect(topics.length).toBe(1);
    expect(topics[0]).toBeTruthy();
  });

  it("respects minDecisionsToTrigger", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library connection?", confidence: 4 }),
      // Only 2 decisions — below default threshold of 3
    ];
    const topics = getResearchTopics(decisions, null, defaultConfig);
    expect(topics.length).toBe(0);
  });

  it("respects lowConfidenceThreshold", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 7 }),
      makeDecision({ question: "WebSocket library connection?", confidence: 8 }),
      makeDecision({ question: "WebSocket library retry?", confidence: 9 }),
    ];
    const topics = getResearchTopics(decisions, null, defaultConfig);
    expect(topics.length).toBe(0);
  });

  it("respects maxTopicsPerJob cap", () => {
    const decisions = [
      // Topic 1: WebSocket
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library connection?", confidence: 4 }),
      makeDecision({ question: "WebSocket library retry?", confidence: 2 }),
      // Topic 2: OAuth
      makeDecision({ question: "OAuth token refresh strategy?", confidence: 3 }),
      makeDecision({ question: "OAuth token expiration handling?", confidence: 4 }),
      makeDecision({ question: "OAuth token rotation policy?", confidence: 2 }),
      // Topic 3: Docker
      makeDecision({ question: "Docker container orchestration setup?", confidence: 3 }),
      makeDecision({ question: "Docker container networking config?", confidence: 4 }),
      makeDecision({ question: "Docker container volume management?", confidence: 2 }),
    ];
    const config = { ...defaultConfig, maxTopicsPerJob: 2 };
    const topics = getResearchTopics(decisions, null, config);
    expect(topics.length).toBeLessThanOrEqual(2);
  });

  it("skips fresh topics (isTopicStale returns false)", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library connection?", confidence: 4 }),
      makeDecision({ question: "WebSocket library retry?", confidence: 2 }),
    ];

    // Domain expertise with a fresh WebSocket topic (researched today)
    const freshDomainExpertise = `# Domain Expertise

---
topic: Websocket Library
last_researched: ${new Date().toISOString()}
search_count: 5
partial: false
---

## Current SOTA
- ws is the fastest`;

    const topics = getResearchTopics(decisions, freshDomainExpertise, defaultConfig);
    expect(topics.length).toBe(0);
  });

  it("returns empty for no decisions", () => {
    const topics = getResearchTopics([], null, defaultConfig);
    expect(topics.length).toBe(0);
  });

  it("returns empty when all decisions are high confidence", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library?", confidence: 8 }),
      makeDecision({ question: "OAuth flow?", confidence: 9 }),
    ];
    const topics = getResearchTopics(decisions, null, defaultConfig);
    expect(topics.length).toBe(0);
  });

  it("returns empty for single low-confidence decision (below threshold)", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library selection?", confidence: 2 }),
    ];
    const topics = getResearchTopics(decisions, null, defaultConfig);
    expect(topics.length).toBe(0);
  });

  it("works with exactly minDecisionsToTrigger decisions", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance benchmarks?", confidence: 3 }),
      makeDecision({ question: "WebSocket library connection handling?", confidence: 4 }),
      makeDecision({ question: "WebSocket library reconnection strategy?", confidence: 2 }),
    ];
    const config = { ...defaultConfig, minDecisionsToTrigger: 3 };
    const topics = getResearchTopics(decisions, null, config);
    expect(topics.length).toBe(1);
  });

  it("includes stale topics (researched > 14 days ago)", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library connection?", confidence: 4 }),
      makeDecision({ question: "WebSocket library retry?", confidence: 2 }),
    ];

    // Domain expertise with a stale topic (researched 30 days ago)
    const staleDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const staleDomainExpertise = `# Domain Expertise

---
topic: Websocket Library
last_researched: ${staleDate}
search_count: 5
partial: false
---

## Current SOTA
- ws is the fastest`;

    const topics = getResearchTopics(decisions, staleDomainExpertise, defaultConfig);
    expect(topics.length).toBe(1);
  });

  it("returns topics sorted by group size (largest first)", () => {
    const decisions = [
      // Smaller group
      makeDecision({ question: "OAuth token refresh?", confidence: 3 }),
      makeDecision({ question: "OAuth token expiration?", confidence: 4 }),
      makeDecision({ question: "OAuth token rotation?", confidence: 2 }),
      // Larger group
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library connection?", confidence: 4 }),
      makeDecision({ question: "WebSocket library retry?", confidence: 2 }),
      makeDecision({ question: "WebSocket library timeout?", confidence: 3 }),
    ];
    const config = { ...defaultConfig, maxTopicsPerJob: 2 };
    const topics = getResearchTopics(decisions, null, config);
    // Largest group should come first
    expect(topics.length).toBe(2);
  });

  it("handles null domain expertise (all topics stale)", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library connection?", confidence: 4 }),
      makeDecision({ question: "WebSocket library retry?", confidence: 2 }),
    ];
    const topics = getResearchTopics(decisions, null, defaultConfig);
    expect(topics.length).toBe(1);
  });
});

// ── DEFAULT_AUTO_RESEARCH_CONFIG ────────────────────────────────

describe("DEFAULT_AUTO_RESEARCH_CONFIG", () => {
  it("has correct defaults", () => {
    expect(DEFAULT_AUTO_RESEARCH_CONFIG.enabled).toBe(false);
    expect(DEFAULT_AUTO_RESEARCH_CONFIG.lowConfidenceThreshold).toBe(6);
    expect(DEFAULT_AUTO_RESEARCH_CONFIG.minDecisionsToTrigger).toBe(3);
    expect(DEFAULT_AUTO_RESEARCH_CONFIG.maxTopicsPerJob).toBe(2);
  });
});
