/**
 * Regression: ISSUE-002 — formatCodebaseSummaryForRelay prints "undefined"
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 *
 * If lastSessionIndex was missing or non-number, the relay prompt header
 * contained literal "sessions 0-undefined".
 */

import { describe, it, expect } from "vitest";
import { formatCodebaseSummaryForRelay } from "../src/codebase-summary.js";
import type { CodebaseSummary } from "../src/types.js";

describe("formatCodebaseSummaryForRelay defensive lastSessionIndex", () => {
  it("falls back to 0 when lastSessionIndex is undefined", () => {
    const summary = {
      observations: ["uses kebab-case"],
      failedApproaches: [],
    } as unknown as CodebaseSummary;
    // lastSessionIndex is undefined
    const result = formatCodebaseSummaryForRelay(summary);
    expect(result).toContain("sessions 0-0");
    expect(result).not.toContain("undefined");
  });

  it("falls back to 0 when lastSessionIndex is a string", () => {
    const summary = {
      observations: ["uses kebab-case"],
      failedApproaches: [],
      lastSessionIndex: "bad",
    } as unknown as CodebaseSummary;
    const result = formatCodebaseSummaryForRelay(summary);
    expect(result).toContain("sessions 0-0");
    expect(result).not.toContain("bad");
  });

  it("uses actual value when lastSessionIndex is valid number", () => {
    const summary: CodebaseSummary = {
      observations: ["uses kebab-case"],
      failedApproaches: [],
      lastSessionIndex: 3,
    };
    const result = formatCodebaseSummaryForRelay(summary);
    expect(result).toContain("sessions 0-3");
  });

  it("handles lastSessionIndex of 0 correctly", () => {
    const summary: CodebaseSummary = {
      observations: ["uses kebab-case"],
      failedApproaches: [],
      lastSessionIndex: 0,
    };
    const result = formatCodebaseSummaryForRelay(summary);
    expect(result).toContain("sessions 0-0");
  });
});
