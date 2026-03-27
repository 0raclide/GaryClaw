/**
 * Regression: ISSUE-001 — validateCheckpoint missing lastSessionIndex check
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 *
 * validateCheckpoint() accepted codebaseSummary objects with missing or
 * wrong-typed lastSessionIndex, breaking the type contract.
 */

import { describe, it, expect } from "vitest";
import { validateCheckpoint } from "../src/checkpoint.js";
import { createMockCheckpoint, resetCounters } from "./helpers.js";
import { beforeEach } from "vitest";

beforeEach(() => {
  resetCounters();
});

describe("validateCheckpoint codebaseSummary.lastSessionIndex", () => {
  it("rejects codebaseSummary missing lastSessionIndex", () => {
    const cp = createMockCheckpoint() as any;
    cp.codebaseSummary = { observations: [], failedApproaches: [] };
    // lastSessionIndex is missing — should fail
    expect(validateCheckpoint(cp)).toBe(false);
  });

  it("rejects codebaseSummary with lastSessionIndex as string", () => {
    const cp = createMockCheckpoint() as any;
    cp.codebaseSummary = {
      observations: [],
      failedApproaches: [],
      lastSessionIndex: "2",
    };
    expect(validateCheckpoint(cp)).toBe(false);
  });

  it("rejects codebaseSummary with lastSessionIndex as null", () => {
    const cp = createMockCheckpoint() as any;
    cp.codebaseSummary = {
      observations: [],
      failedApproaches: [],
      lastSessionIndex: null,
    };
    expect(validateCheckpoint(cp)).toBe(false);
  });

  it("accepts codebaseSummary with lastSessionIndex as 0", () => {
    const cp = createMockCheckpoint({
      codebaseSummary: {
        observations: [],
        failedApproaches: [],
        lastSessionIndex: 0,
      },
    });
    expect(validateCheckpoint(cp)).toBe(true);
  });

  it("accepts codebaseSummary with valid lastSessionIndex", () => {
    const cp = createMockCheckpoint({
      codebaseSummary: {
        observations: ["uses kebab-case"],
        failedApproaches: [],
        lastSessionIndex: 5,
      },
    });
    expect(validateCheckpoint(cp)).toBe(true);
  });
});
