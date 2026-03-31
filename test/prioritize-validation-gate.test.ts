/**
 * Prioritize validation gate tests — isPickValid + parseAlternativeTitles.
 */

import { describe, it, expect } from "vitest";
import { isPickValid, extractCompletedTitles } from "../src/prioritize.js";
import { parseAlternativeTitles } from "../src/job-runner.js";

// ── isPickValid ─────────────────────────────────────────────────

describe("isPickValid", () => {
  const completedTitles = [
    "P3: Implement Skill Hardening",
    "P2: Daemon Resilience",
    "P3: Bootstrap Quality Gate",
  ];

  it("returns true for a non-matching title", () => {
    expect(isPickValid("P2: New Feature XYZ", completedTitles)).toBe(true);
  });

  it("returns false for exact match", () => {
    expect(isPickValid("P3: Implement Skill Hardening", completedTitles)).toBe(false);
  });

  it("returns false for fuzzy match (< 0.3 Levenshtein)", () => {
    // Very similar to "P3: Implement Skill Hardening"
    expect(isPickValid("P3: Implement Skill Hardening (Unresolved Review Findings)", completedTitles)).toBe(false);
  });

  it("returns false for substring match", () => {
    // "Implement Skill Hardening" is contained in the completed title
    expect(isPickValid("Implement Skill Hardening", completedTitles)).toBe(false);
  });

  it("returns true for empty completed titles list", () => {
    expect(isPickValid("Anything", [])).toBe(true);
  });

  it("returns true for empty pick title", () => {
    expect(isPickValid("", completedTitles)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isPickValid("p3: implement skill hardening", completedTitles)).toBe(false);
  });

  it("ignores punctuation differences", () => {
    expect(isPickValid("P3: Implement Skill Hardening!", completedTitles)).toBe(false);
  });

  it("returns true for genuinely different title", () => {
    expect(isPickValid("P1: WebSocket Reconnection Logic", completedTitles)).toBe(true);
  });
});

// ── parseAlternativeTitles ──────────────────────────────────────

describe("parseAlternativeTitles", () => {
  it("parses 2nd and 3rd alternative titles", () => {
    const content = `## Top Pick: Main Item

### 2nd: Alternative One — Score: 7.5/10
Some reasoning.

### 3rd: Alternative Two — Score: 6.0/10
More reasoning.`;

    expect(parseAlternativeTitles(content)).toEqual(["Alternative One", "Alternative Two"]);
  });

  it("returns empty array when no alternatives exist", () => {
    const content = `## Top Pick: Only Item\n\nNo alternatives.`;
    expect(parseAlternativeTitles(content)).toEqual([]);
  });

  it("handles 4th, 5th alternatives", () => {
    const content = `### 4th: Fourth Pick — Score: 5.0/10
### 5th: Fifth Pick — Score: 4.5/10`;

    expect(parseAlternativeTitles(content)).toEqual(["Fourth Pick", "Fifth Pick"]);
  });

  it("handles 1st alternative", () => {
    const content = `### 1st: First Alt — Score: 8.0/10`;
    expect(parseAlternativeTitles(content)).toEqual(["First Alt"]);
  });
});

// ── Integration: extractCompletedTitles + isPickValid ───────────

describe("validation gate integration", () => {
  it("rejects a pick matching a completed TODOS item", () => {
    const todosContent = `# TODOS

## P2: Open Feature

**What:** Build this.

## ~~P3: Implement Skill Hardening~~ — COMPLETE (2026-03-27)

**What:** Already done.`;

    const completed = extractCompletedTitles(todosContent);
    expect(isPickValid("Implement Skill Hardening", completed)).toBe(false);
    expect(isPickValid("P2: Open Feature", completed)).toBe(true);
  });
});
