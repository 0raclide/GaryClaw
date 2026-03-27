/**
 * Regression tests for auto-research: isTopicGroupFresh direct tests,
 * seed-keyword clustering, 3-char acronym preservation.
 *
 * Regression: ISSUE-001, ISSUE-002, ISSUE-003
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 */

import { describe, it, expect } from "vitest";
import type { AutoResearchConfig, Decision } from "../src/types.js";
import {
  extractTopicKeywords,
  groupDecisionsByTopic,
  isTopicGroupFresh,
} from "../src/auto-research.js";

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

// ── isTopicGroupFresh direct tests ──────────────────────────────

describe("isTopicGroupFresh", () => {
  it("returns false when domainExpertise is null", () => {
    expect(isTopicGroupFresh(["websocket", "library"], null)).toBe(false);
  });

  it("returns false when domainExpertise is empty string", () => {
    expect(isTopicGroupFresh(["websocket", "library"], "")).toBe(false);
  });

  it("returns false when no section matches the keywords", () => {
    const domainExpertise = `# Domain Expertise

---
topic: OAuth Token Management
last_researched: ${new Date().toISOString()}
search_count: 5
partial: false
---

## Current SOTA
- Use refresh tokens`;

    expect(isTopicGroupFresh(["websocket", "library"], domainExpertise)).toBe(false);
  });

  it("returns true when a matching section is fresh", () => {
    const domainExpertise = `# Domain Expertise

---
topic: WebSocket Library
last_researched: ${new Date().toISOString()}
search_count: 5
partial: false
---

## Current SOTA
- ws is the fastest`;

    expect(isTopicGroupFresh(["websocket", "library"], domainExpertise)).toBe(true);
  });

  it("returns false when a matching section is stale (>14 days)", () => {
    const staleDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const domainExpertise = `# Domain Expertise

---
topic: WebSocket Library
last_researched: ${staleDate}
search_count: 5
partial: false
---

## Current SOTA
- ws is the fastest`;

    expect(isTopicGroupFresh(["websocket", "library"], domainExpertise)).toBe(false);
  });

  it("requires 2+ keyword overlap to match a section", () => {
    const domainExpertise = `# Domain Expertise

---
topic: WebSocket Performance
last_researched: ${new Date().toISOString()}
search_count: 5
partial: false
---

## Current SOTA
- Very fast`;

    // Only "websocket" overlaps, not enough
    expect(isTopicGroupFresh(["websocket", "library"], domainExpertise)).toBe(false);
    // Both "websocket" and "performance" overlap
    expect(isTopicGroupFresh(["websocket", "performance"], domainExpertise)).toBe(true);
  });

  it("handles multiple sections — returns true if ANY fresh section matches", () => {
    const staleDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const domainExpertise = `# Domain Expertise

---
topic: WebSocket Library
last_researched: ${staleDate}
search_count: 5
partial: false
---

## Old SOTA

---
topic: WebSocket Performance
last_researched: ${new Date().toISOString()}
search_count: 3
partial: false
---

## Fresh SOTA`;

    // "websocket" + "library" matches the stale section first
    expect(isTopicGroupFresh(["websocket", "library"], domainExpertise)).toBe(false);
    // "websocket" + "performance" matches the fresh section
    expect(isTopicGroupFresh(["websocket", "performance"], domainExpertise)).toBe(true);
  });

  it("is case-insensitive on keyword matching", () => {
    const domainExpertise = `# Domain Expertise

---
topic: OAuth Token Management
last_researched: ${new Date().toISOString()}
search_count: 5
partial: false
---

## Current SOTA`;

    expect(isTopicGroupFresh(["oauth", "token"], domainExpertise)).toBe(true);
  });
});

// ── ISSUE-001: 3-char acronyms survive the filter ───────────────

describe("extractTopicKeywords — 3-char acronym preservation", () => {
  it("preserves API", () => {
    expect(extractTopicKeywords("Which API should we use?")).toContain("api");
  });

  it("preserves JWT", () => {
    expect(extractTopicKeywords("JWT vs session tokens?")).toContain("jwt");
  });

  it("preserves SSL", () => {
    expect(extractTopicKeywords("SSL certificate renewal?")).toContain("ssl");
  });

  it("preserves SQL", () => {
    expect(extractTopicKeywords("SQL injection prevention?")).toContain("sql");
  });

  it("preserves CSS", () => {
    expect(extractTopicKeywords("CSS module approach?")).toContain("css");
  });

  it("preserves DOM", () => {
    expect(extractTopicKeywords("DOM manipulation strategy?")).toContain("dom");
  });

  it("preserves RPC", () => {
    // "gRPC" lowercases to "grpc", not "rpc" — test the actual input
    expect(extractTopicKeywords("RPC protocol or REST API?")).toContain("rpc");
    // "gRPC" is a distinct keyword
    expect(extractTopicKeywords("gRPC or REST API?")).toContain("grpc");
  });

  it("filters 2-char words", () => {
    const keywords = extractTopicKeywords("Is it OK to do so?");
    expect(keywords).not.toContain("is");
    expect(keywords).not.toContain("it");
    expect(keywords).not.toContain("ok");
    expect(keywords).not.toContain("to");
    expect(keywords).not.toContain("do");
    expect(keywords).not.toContain("so");
  });
});

// ── ISSUE-002: seed-keyword clustering prevents snowball ────────

describe("groupDecisionsByTopic — seed-keyword clustering", () => {
  it("does NOT snowball unrelated decisions through accumulated keywords", () => {
    const decisions = [
      // Group seed: {websocket, library}
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library connection pooling?", confidence: 4 }),
      // This one shares "connection" and "pooling" with the group's accumulated keywords
      // but NOT with the seed {websocket, library}. Should form its OWN group.
      makeDecision({ question: "Connection pooling timeout strategy?", confidence: 2 }),
    ];

    const groups = groupDecisionsByTopic(decisions, defaultConfig);

    // Without the fix: 1 group (snowball absorbed the 3rd decision)
    // With the fix: 2 groups (3rd decision doesn't match seed keywords)
    expect(groups.length).toBe(2);
    expect(groups[0].decisions.length).toBe(2); // websocket library group
    expect(groups[1].decisions.length).toBe(1); // connection pooling group
  });

  it("still clusters decisions that share seed keywords", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library retry logic?", confidence: 4 }),
      makeDecision({ question: "WebSocket library reconnection?", confidence: 2 }),
    ];

    const groups = groupDecisionsByTopic(decisions, defaultConfig);
    // All share seed keywords {websocket, library}
    expect(groups.length).toBe(1);
    expect(groups[0].decisions.length).toBe(3);
  });

  it("creates separate groups for truly distinct topics", () => {
    const decisions = [
      makeDecision({ question: "WebSocket library performance?", confidence: 3 }),
      makeDecision({ question: "WebSocket library retry?", confidence: 4 }),
      makeDecision({ question: "OAuth token refresh?", confidence: 3 }),
      makeDecision({ question: "OAuth token expiration?", confidence: 2 }),
    ];

    const groups = groupDecisionsByTopic(decisions, defaultConfig);
    expect(groups.length).toBe(2);
  });
});
