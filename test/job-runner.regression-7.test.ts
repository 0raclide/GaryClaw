/**
 * Regression: ISSUE-002 — 'daemon-crash' must be a valid FailureCategory
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * The job-runner assigned "daemon_crash" via `as any` to bypass the type system.
 * The value wasn't in the FailureCategory union, so it was invisible to type checks
 * and could break downstream consumers that pattern-match on known categories.
 * Fix: added "daemon-crash" (kebab-case) to the union and removed the cast.
 */

import { describe, it, expect } from "vitest";
import type { FailureCategory } from "../src/types.js";

describe("FailureCategory includes daemon-crash", () => {
  it("accepts 'daemon-crash' as a valid FailureCategory", () => {
    const cat: FailureCategory = "daemon-crash";
    expect(cat).toBe("daemon-crash");
  });

  it("uses kebab-case matching all other categories", () => {
    const categories: FailureCategory[] = [
      "garyclaw-bug",
      "skill-bug",
      "project-bug",
      "sdk-bug",
      "auth-issue",
      "infra-issue",
      "budget-exceeded",
      "merge-failed",
      "daemon-crash",
      "unknown",
    ];
    // Every multi-word category uses kebab-case
    for (const c of categories) {
      if (c.includes("-")) {
        expect(c).toMatch(/^[a-z]+-[a-z]+$/);
      }
    }
    expect(categories).toContain("daemon-crash");
  });
});
