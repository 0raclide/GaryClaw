import { describe, it, expect } from "vitest";
import { parseTaskCategory, VALID_TASK_CATEGORIES, parseEffort, VALID_EFFORTS, parsePriority } from "../src/job-runner.js";

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

  it("parses colon-on-same-line format", () => {
    const content = "### Task Category: visual-ux\n";
    expect(parseTaskCategory(content)).toBe("visual-ux");
  });

  it("parses colon-on-same-line for all valid categories", () => {
    for (const cat of VALID_TASK_CATEGORIES) {
      if (cat === "unknown") continue;
      expect(parseTaskCategory(`### Task Category: ${cat}\n`)).toBe(cat);
    }
  });

  it("handles colon with extra whitespace", () => {
    expect(parseTaskCategory("### Task Category:  bug-fix\n")).toBe("bug-fix");
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

// ── parseEffort ─────────────────────────────────────────────────

describe("parseEffort", () => {
  it("parses effort from 'Effort: S' format", () => {
    expect(parseEffort("Effort: S\n")).toBe("S");
  });

  it("parses all valid effort sizes", () => {
    for (const e of VALID_EFFORTS) {
      expect(parseEffort(`Effort: ${e}\n`)).toBe(e);
    }
  });

  it("handles bold markdown formatting", () => {
    expect(parseEffort("**Effort:** M\n")).toBe("M");
  });

  it("handles no colon separator", () => {
    expect(parseEffort("Effort S\n")).toBe("S");
  });

  it("is case-insensitive", () => {
    expect(parseEffort("Effort: xs\n")).toBe("XS");
  });

  it("returns null when section is missing", () => {
    expect(parseEffort("Priority: P2\n")).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(parseEffort("")).toBeNull();
  });

  it("handles effort embedded in larger content", () => {
    const content = "# Priority Pick\n\n## Top Pick: Fix Bug\n\nEffort: L\nPriority: P1\n";
    expect(parseEffort(content)).toBe("L");
  });

  it("handles extra whitespace around value", () => {
    expect(parseEffort("Effort:  XL\n")).toBe("XL");
  });
});

// ── VALID_EFFORTS constant ──────────────────────────────────────

describe("VALID_EFFORTS", () => {
  it("contains exactly 5 sizes", () => {
    expect(VALID_EFFORTS).toHaveLength(5);
  });

  it("is ordered XS to XL", () => {
    expect([...VALID_EFFORTS]).toEqual(["XS", "S", "M", "L", "XL"]);
  });
});

// ── parsePriority ───────────────────────────────────────────────

describe("parsePriority", () => {
  it("parses priority from 'Priority: P2' format", () => {
    expect(parsePriority("Priority: P2\n")).toBe(2);
  });

  it("parses all valid priorities P1-P5", () => {
    for (let i = 1; i <= 5; i++) {
      expect(parsePriority(`Priority: P${i}\n`)).toBe(i);
    }
  });

  it("handles bold markdown formatting", () => {
    expect(parsePriority("**Priority:** P1\n")).toBe(1);
  });

  it("is case-insensitive", () => {
    expect(parsePriority("priority: p3\n")).toBe(3);
  });

  it("returns default 3 when section is missing", () => {
    expect(parsePriority("Effort: S\n")).toBe(3);
  });

  it("returns default 3 for empty content", () => {
    expect(parsePriority("")).toBe(3);
  });

  it("returns default 3 for out-of-range priority P0", () => {
    expect(parsePriority("Priority: P0\n")).toBe(3);
  });

  it("returns default 3 for out-of-range priority P9", () => {
    expect(parsePriority("Priority: P9\n")).toBe(3);
  });

  it("handles priority embedded in larger content", () => {
    const content = "# Priority Pick\n\n## Top Pick: Fix Bug\n\nEffort: S\nPriority: P1\n";
    expect(parsePriority(content)).toBe(1);
  });
});
