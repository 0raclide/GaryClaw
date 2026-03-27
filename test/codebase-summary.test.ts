/**
 * Tests for codebase-summary.ts — extraction, deduplication,
 * truncation, summary building, and relay formatting.
 */

import { describe, it, expect } from "vitest";
import {
  extractObservations,
  extractFailedApproaches,
  deduplicateObservations,
  truncateToTokenBudget,
  buildCodebaseSummary,
  formatCodebaseSummaryForRelay,
} from "../src/codebase-summary.js";
import type { CodebaseSummary } from "../src/types.js";
import { estimateTokens } from "../src/checkpoint.js";

// ── extractObservations ──────────────────────────────────────────

describe("extractObservations", () => {
  it("extracts sentences with 2+ signal words", () => {
    const text = "This project uses a convention where all files are kebab-case.";
    const result = extractObservations(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("convention");
  });

  it("rejects sentences with only 1 signal word and no code anchor", () => {
    const text = "This project always does things a certain way that is unique.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("accepts 1 signal word when code anchor is present", () => {
    const text = "The project always wraps I/O through src/safe-json.ts for safety.";
    const result = extractObservations(text);
    expect(result).toHaveLength(1);
  });

  it("accepts 1 signal word with function call code anchor", () => {
    const text = "This codebase uses safeReadJSON() for all file reads across modules.";
    const result = extractObservations(text);
    expect(result).toHaveLength(1);
  });

  it("rejects sentences shorter than 20 chars", () => {
    const text = "Uses pattern.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("rejects sentences longer than 300 chars", () => {
    const text = "This project uses a convention where " + "x".repeat(300);
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("excludes negative pattern: narration sentences", () => {
    const text = "Let me try using the convention pattern that always works instead of the old approach.";
    const result = extractObservations(text);
    // "Let me try" matches a negative pattern — should be excluded
    expect(result).toHaveLength(0);
  });

  it("excludes 'I don't see' narration", () => {
    const text = "I don't see any convention or pattern that uses this approach.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("handles multi-line text", () => {
    const text = [
      "This project uses kebab-case naming convention for all files.",
      "The architecture is organized around a pattern of zero-import types.",
    ].join("\n");
    const result = extractObservations(text);
    expect(result).toHaveLength(2);
  });

  it("splits on period-space within lines", () => {
    const text = "This uses a convention for naming. The pattern is always kebab-case.";
    const result = extractObservations(text);
    // Both halves should have 2+ signal words
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty array for no-signal text", () => {
    const text = "I'm going to read the file and make changes to it.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("handles empty string", () => {
    expect(extractObservations("")).toHaveLength(0);
  });
});

// ── extractFailedApproaches ──────────────────────────────────────

describe("extractFailedApproaches", () => {
  it("extracts 'tried X but Y' patterns", () => {
    const text = "I tried using git diff --name-only but it missed files changed across multiple commits.";
    const result = extractFailedApproaches(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("tried");
  });

  it("extracts 'attempted X however Y' patterns", () => {
    const text = "I attempted to use execSync however it introduced a shell injection vulnerability.";
    const result = extractFailedApproaches(text);
    expect(result).toHaveLength(1);
  });

  it("extracts 'tried X failed' patterns", () => {
    const text = "I tried adding the module directly but the import failed due to circular dependency.";
    const result = extractFailedApproaches(text);
    expect(result).toHaveLength(1);
  });

  it("extracts 'tried X doesn't work' patterns", () => {
    const text = "I tried calling readFileSync directly but it doesn't work with the ESM module system.";
    const result = extractFailedApproaches(text);
    expect(result).toHaveLength(1);
  });

  it("extracts 'tried X broke' patterns", () => {
    const text = "I tried adding the import at the top but it broke the circular dependency chain.";
    const result = extractFailedApproaches(text);
    expect(result).toHaveLength(1);
  });

  it("rejects sentences with only try word and no fail word", () => {
    const text = "I tried the new approach and it worked perfectly on the first attempt.";
    const result = extractFailedApproaches(text);
    expect(result).toHaveLength(0);
  });

  it("rejects sentences with only fail word and no try word", () => {
    const text = "The build process failed due to a missing dependency in the lock file.";
    const result = extractFailedApproaches(text);
    expect(result).toHaveLength(0);
  });

  it("excludes negative patterns", () => {
    const text = "I tried running the test suite but it failed to compile.";
    // "I tried running" is a negative pattern
    const result = extractFailedApproaches(text);
    expect(result).toHaveLength(0);
  });

  it("handles empty string", () => {
    expect(extractFailedApproaches("")).toHaveLength(0);
  });

  it("handles multi-line text with multiple failures", () => {
    const text = [
      "I tried using require() but it failed in ESM mode.",
      "I attempted the sync approach however it broke the event loop.",
    ].join("\n");
    const result = extractFailedApproaches(text);
    expect(result).toHaveLength(2);
  });
});

// ── deduplicateObservations ──────────────────────────────────────

describe("deduplicateObservations", () => {
  it("removes exact duplicates", () => {
    const obs = [
      "This project uses kebab-case for files",
      "This project uses kebab-case for files",
    ];
    const result = deduplicateObservations(obs);
    expect(result).toHaveLength(1);
  });

  it("removes near-duplicates (normalized distance < 0.3)", () => {
    const obs = [
      "This project uses kebab-case for file names",
      "This project uses kebab-case for file-names",
    ];
    const result = deduplicateObservations(obs);
    expect(result).toHaveLength(1);
  });

  it("keeps distinct observations", () => {
    const obs = [
      "This project uses kebab-case for file names and follows strict naming conventions",
      "All git commands use execFileSync to prevent shell injection vulnerabilities",
    ];
    const result = deduplicateObservations(obs);
    expect(result).toHaveLength(2);
  });

  it("keeps first occurrence of duplicates", () => {
    const obs = ["first version of observation", "second version of observation slightly different"];
    // These are quite different so both should survive
    const result = deduplicateObservations(obs);
    expect(result[0]).toBe("first version of observation");
  });

  it("handles empty array", () => {
    expect(deduplicateObservations([])).toHaveLength(0);
  });

  it("respects custom threshold", () => {
    const obs = [
      "This project uses kebab-case for file names",
      "This project uses kebab-case for file-names",
    ];
    // Very strict threshold — should keep both
    const result = deduplicateObservations(obs, 0.01);
    expect(result).toHaveLength(2);
  });
});

// ── truncateToTokenBudget ────────────────────────────────────────

describe("truncateToTokenBudget", () => {
  it("returns all entries when under budget", () => {
    const entries = ["short entry", "another short one"];
    const result = truncateToTokenBudget(entries, 1000);
    expect(result).toHaveLength(2);
  });

  it("drops oldest entries first when over budget", () => {
    const entries = [
      "oldest entry that should be dropped first to make room",
      "middle entry",
      "newest entry",
    ];
    // Set a very tight budget
    const result = truncateToTokenBudget(entries, 15);
    // Should drop from front until under budget
    expect(result.length).toBeLessThan(entries.length);
    expect(result[result.length - 1]).toBe("newest entry");
  });

  it("returns empty array when budget is 0", () => {
    const entries = ["something"];
    const result = truncateToTokenBudget(entries, 0);
    expect(result).toHaveLength(0);
  });

  it("handles empty array", () => {
    expect(truncateToTokenBudget([], 1000)).toHaveLength(0);
  });

  it("preserves newest entries", () => {
    // Create entries that exceed budget
    const entries = Array.from({ length: 20 }, (_, i) => `Observation number ${i}: this is a fairly detailed description of something learned.`);
    const result = truncateToTokenBudget(entries, 200);
    // Should have dropped oldest, kept newest
    expect(result.length).toBeLessThan(20);
    expect(result[result.length - 1]).toContain("number 19");
  });
});

// ── buildCodebaseSummary ─────────────────────────────────────────

describe("buildCodebaseSummary", () => {
  it("builds summary from scratch when current is undefined", () => {
    const obs = ["This project uses kebab-case naming convention for all module files"];
    const failed = ["I tried using require() but it failed in ESM mode due to module restrictions"];
    const result = buildCodebaseSummary(undefined, obs, failed, 0);

    expect(result.observations).toHaveLength(1);
    expect(result.failedApproaches).toHaveLength(1);
    expect(result.lastSessionIndex).toBe(0);
  });

  it("merges with existing summary", () => {
    const current: CodebaseSummary = {
      observations: ["Old observation about naming conventions and patterns"],
      failedApproaches: [],
      lastSessionIndex: 0,
    };
    const result = buildCodebaseSummary(
      current,
      ["New observation about architecture structure and organization"],
      ["I tried X but Y failed due to something"],
      1,
    );

    expect(result.observations).toHaveLength(2);
    expect(result.failedApproaches).toHaveLength(1);
    expect(result.lastSessionIndex).toBe(1);
  });

  it("deduplicates across merge", () => {
    const current: CodebaseSummary = {
      observations: ["This project uses kebab-case for file names"],
      failedApproaches: [],
      lastSessionIndex: 0,
    };
    const result = buildCodebaseSummary(
      current,
      ["This project uses kebab-case for file-names"],
      [],
      1,
    );

    // Near-duplicate should be removed
    expect(result.observations).toHaveLength(1);
  });

  it("enforces token budget for observations", () => {
    const bigObservations = Array.from(
      { length: 100 },
      (_, i) => `Observation ${i}: ${" very detailed ".repeat(20)}`,
    );
    const result = buildCodebaseSummary(undefined, bigObservations, [], 0);

    const totalTokens = result.observations.reduce(
      (sum, o) => sum + estimateTokens(o),
      0,
    );
    expect(totalTokens).toBeLessThanOrEqual(1500);
  });

  it("enforces token budget for failed approaches", () => {
    const bigFailed = Array.from(
      { length: 50 },
      (_, i) => `Failed approach ${i}: ${" attempted something ".repeat(15)}`,
    );
    const result = buildCodebaseSummary(undefined, [], bigFailed, 0);

    const totalTokens = result.failedApproaches.reduce(
      (sum, f) => sum + estimateTokens(f),
      0,
    );
    expect(totalTokens).toBeLessThanOrEqual(500);
  });

  it("handles empty inputs", () => {
    const result = buildCodebaseSummary(undefined, [], [], 0);
    expect(result.observations).toHaveLength(0);
    expect(result.failedApproaches).toHaveLength(0);
    expect(result.lastSessionIndex).toBe(0);
  });
});

// ── formatCodebaseSummaryForRelay ────────────────────────────────

describe("formatCodebaseSummaryForRelay", () => {
  it("formats both sections when both have content", () => {
    const summary: CodebaseSummary = {
      observations: ["Uses kebab-case naming", "Types in types.ts"],
      failedApproaches: ["Tried require() but failed in ESM"],
      lastSessionIndex: 2,
    };
    const text = formatCodebaseSummaryForRelay(summary);

    expect(text).toContain("## Codebase Context (carried from sessions 0-2)");
    expect(text).toContain("**Approaches that failed (don't retry):**");
    expect(text).toContain("- Tried require() but failed in ESM");
    expect(text).toContain("**Observations:**");
    expect(text).toContain("- Uses kebab-case naming");
    expect(text).toContain("- Types in types.ts");
  });

  it("omits failed approaches section when empty", () => {
    const summary: CodebaseSummary = {
      observations: ["Uses kebab-case naming"],
      failedApproaches: [],
      lastSessionIndex: 1,
    };
    const text = formatCodebaseSummaryForRelay(summary);

    expect(text).toContain("**Observations:**");
    expect(text).not.toContain("**Approaches that failed");
  });

  it("omits observations section when empty", () => {
    const summary: CodebaseSummary = {
      observations: [],
      failedApproaches: ["Tried X but Y"],
      lastSessionIndex: 0,
    };
    const text = formatCodebaseSummaryForRelay(summary);

    expect(text).toContain("**Approaches that failed");
    expect(text).not.toContain("**Observations:**");
  });

  it("returns empty string when both arrays are empty", () => {
    const summary: CodebaseSummary = {
      observations: [],
      failedApproaches: [],
      lastSessionIndex: 0,
    };
    expect(formatCodebaseSummaryForRelay(summary)).toBe("");
  });

  it("includes lastSessionIndex in header", () => {
    const summary: CodebaseSummary = {
      observations: ["Something about convention patterns"],
      failedApproaches: [],
      lastSessionIndex: 5,
    };
    const text = formatCodebaseSummaryForRelay(summary);
    expect(text).toContain("sessions 0-5");
  });
});
