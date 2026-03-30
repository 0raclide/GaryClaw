import { describe, it, expect } from "vitest";
import { parseTaskCategory, VALID_TASK_CATEGORIES } from "../src/job-runner.js";

// ── parseTaskCategory ──────────────────────────────────────────

describe("parseTaskCategory", () => {
  it("parses a valid category from priority.md", () => {
    const content = "### Task Category\nvisual-ux\n\n### Recommended Pipeline\nimplement -> qa\n";
    expect(parseTaskCategory(content)).toBe("visual-ux");
  });

  it("parses all valid categories", () => {
    for (const cat of VALID_TASK_CATEGORIES) {
      if (cat === "unknown") continue; // "unknown" is fallback only
      const content = `### Task Category\n${cat}\n`;
      expect(parseTaskCategory(content)).toBe(cat);
    }
  });

  it("returns 'unknown' when section is missing", () => {
    const content = "### Recommended Pipeline\nimplement -> qa\n";
    expect(parseTaskCategory(content)).toBe("unknown");
  });

  it("returns 'unknown' for invalid category", () => {
    const content = "### Task Category\nsome-random-thing\n";
    expect(parseTaskCategory(content)).toBe("unknown");
  });

  it("handles blank lines between heading and value", () => {
    const content = "### Task Category\n\narchitectural\n";
    expect(parseTaskCategory(content)).toBe("architectural");
  });

  it("is case-insensitive", () => {
    const content = "### Task Category\nBUG-FIX\n";
    expect(parseTaskCategory(content)).toBe("bug-fix");
  });

  it("handles extra whitespace in heading", () => {
    const content = "###  Task Category\nrefactor\n";
    expect(parseTaskCategory(content)).toBe("refactor");
  });

  it("handles empty content", () => {
    expect(parseTaskCategory("")).toBe("unknown");
  });

  it("handles content with only the heading but no value", () => {
    const content = "### Task Category\n\n### Recommended Pipeline\n";
    // The regex matches \S+ after newlines, so "###" from the next heading might match
    // but "###" is not a valid category, so it returns "unknown"
    expect(parseTaskCategory(content)).toBe("unknown");
  });
});

// ── VALID_TASK_CATEGORIES constant ──────────────────────────────

describe("VALID_TASK_CATEGORIES", () => {
  it("contains exactly 8 categories", () => {
    expect(VALID_TASK_CATEGORIES).toHaveLength(8);
  });

  it("includes 'unknown' as fallback", () => {
    expect(VALID_TASK_CATEGORIES).toContain("unknown");
  });

  it("includes all expected user-facing categories", () => {
    const expected = ["visual-ux", "architectural", "bug-fix", "refactor", "performance", "infra", "new-feature"];
    for (const cat of expected) {
      expect(VALID_TASK_CATEGORIES).toContain(cat);
    }
  });
});
