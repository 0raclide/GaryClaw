/**
 * Regression tests for prioritize prompt size guard fixes.
 *
 * Regression: ISSUE-001 — SB.capabilities budget key reused for vision + capabilities
 * Regression: ISSUE-002 — truncateSection missing marker for single-line content
 * Regression: ISSUE-003 — filterOpenTodos returns preamble when all items struck through
 * Found by /qa on 2026-03-31
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-31.md
 */

import { describe, it, expect } from "vitest";
import {
  filterOpenTodos,
  addBudgetedSection,
  truncateSection,
  PRIORITIZE_SECTION_BUDGETS as SB,
} from "../src/prioritize.js";

describe("ISSUE-001: vision vs capabilities budget keys", () => {
  it("has separate vision and capabilities budget keys", () => {
    expect(SB).toHaveProperty("vision");
    expect(SB).toHaveProperty("capabilities");
    expect(SB.vision).not.toBe(SB.capabilities);
  });

  it("vision + capabilities sum to 5K (design doc spec)", () => {
    expect(SB.vision + SB.capabilities).toBe(5_000);
  });

  it("vision budget is smaller than capabilities (vision is a short description)", () => {
    expect(SB.vision).toBeLessThan(SB.capabilities);
  });
});

describe("ISSUE-002: truncateSection marker for no-newline content", () => {
  it("keepEnd=true adds marker even without newlines", () => {
    const content = "A".repeat(5000);
    const result = truncateSection(content, 100, true);
    expect(result).toContain("[...older entries truncated]");
  });

  it("keepEnd=false adds marker even without newlines", () => {
    const content = "A".repeat(5000);
    const result = truncateSection(content, 100, false);
    expect(result).toContain("[...truncated to fit token budget]");
  });
});

describe("ISSUE-003: filterOpenTodos all-struck-through fallback", () => {
  it("returns empty when all ## blocks are struck through", () => {
    const input = "# TODOS\n\n## ~~P1: Done~~\nStuff.\n\n## ~~P2: Also Done~~\nMore.";
    expect(filterOpenTodos(input)).toBe("");
  });

  it("returns content when at least one ## block is open", () => {
    const input = "# TODOS\n\n## ~~P1: Done~~\nStuff.\n\n## P2: Open\nWork here.";
    const result = filterOpenTodos(input);
    expect(result).toContain("## P2: Open");
    expect(result).not.toContain("Done");
  });

  it("preserves content with no ## blocks at all (prose-only TODOS)", () => {
    const input = "# TODOS\n\nJust some unstructured text.";
    expect(filterOpenTodos(input)).toBe(input);
  });
});
