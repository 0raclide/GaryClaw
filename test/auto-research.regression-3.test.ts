// Regression: ISSUE-002 — extractTopicKeywords included numeric-only tokens
// Regression: ISSUE-003 — isTopicGroupFresh returned on first match, ignoring fresher alternatives
// Found by /qa on 2026-03-28
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md

import { describe, it, expect } from "vitest";
import { extractTopicKeywords, isTopicGroupFresh } from "../src/auto-research.js";

describe("extractTopicKeywords — numeric token filtering", () => {
  it("filters out purely numeric tokens", () => {
    const keywords = extractTopicKeywords("Should we limit responses to 100 items or 500 items?");
    expect(keywords).not.toContain("100");
    expect(keywords).not.toContain("500");
  });

  it("keeps tokens that mix letters and numbers", () => {
    const keywords = extractTopicKeywords("Should we use OAuth2 or SAML for auth?");
    expect(keywords).toContain("oauth2");
  });

  it("filters 4-digit years", () => {
    const keywords = extractTopicKeywords("Which framework was best in 2025 and 2026?");
    expect(keywords).not.toContain("2025");
    expect(keywords).not.toContain("2026");
  });

  it("still returns real keywords from questions with numbers", () => {
    const keywords = extractTopicKeywords("Should we use 100 workers or 200 workers for the queue?");
    expect(keywords).toContain("workers");
    expect(keywords).toContain("queue");
    expect(keywords.length).toBeGreaterThan(0);
  });
});

describe("isTopicGroupFresh — multi-section matching", () => {
  const freshDate = new Date().toISOString().slice(0, 10);
  const staleDate = "2025-01-01";

  function makeDomainExpertise(sections: Array<{ topic: string; date: string }>): string {
    const parts = sections.map(
      (s) =>
        `---\ntopic: ${s.topic}\nlast_researched: ${s.date}\nsearch_count: 1\npartial: false\n---\n\nContent about ${s.topic}.`,
    );
    return "# Domain Expertise\n\n" + parts.join("\n\n");
  }

  it("returns true when second matching section is fresh (first is stale)", () => {
    const expertise = makeDomainExpertise([
      { topic: "WebSocket Performance", date: staleDate },
      { topic: "WebSocket Library", date: freshDate },
    ]);

    // Keywords overlap with both sections (2+ match: "websocket" + "library"/"performance")
    const result = isTopicGroupFresh(["websocket", "library", "performance"], expertise);
    expect(result).toBe(true);
  });

  it("returns false when all matching sections are stale", () => {
    const expertise = makeDomainExpertise([
      { topic: "WebSocket Performance", date: staleDate },
      { topic: "WebSocket Library", date: staleDate },
    ]);

    const result = isTopicGroupFresh(["websocket", "library", "performance"], expertise);
    expect(result).toBe(false);
  });

  it("returns true when first matching section is fresh", () => {
    const expertise = makeDomainExpertise([
      { topic: "WebSocket Performance", date: freshDate },
      { topic: "WebSocket Library", date: staleDate },
    ]);

    const result = isTopicGroupFresh(["websocket", "library", "performance"], expertise);
    expect(result).toBe(true);
  });
});
