/**
 * Regression: updateAutoFixCost empty SHA guard.
 *
 * Bug: With isDirectSha=true and an empty string, shaPrefix would be ""
 * and "".startsWith("") is always true in JS, so it would match the FIRST
 * entry in state regardless of SHA — silently corrupting cost tracking
 * for the wrong auto-fix entry.
 *
 * Fix: Guard against empty shaPrefix in the isDirectSha path.
 *
 * Found by /qa on 2026-03-30
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  updateAutoFixCost,
  readAutoFixState,
  writeAutoFixState,
} from "../src/auto-fix.js";
import type { AutoFixState } from "../src/auto-fix.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-auto-fix-regression-1");

describe("updateAutoFixCost empty SHA guard (regression)", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("no-ops when isDirectSha=true and SHA is empty string", () => {
    const state: AutoFixState = {
      entries: {
        abc123def456: {
          originalMergeSha: "abc123def456",
          originalJobId: "job-001",
          originalJobCost: 4.0,
          bugTodoTitle: "P2: bug",
          retryCount: 1,
          totalAutoFixCost: 1.0,
          createdAt: new Date().toISOString(),
        },
      },
    };
    writeAutoFixState(TMP, state);

    // Empty string with isDirectSha=true should NOT match any entry
    updateAutoFixCost(TMP, "", 5.0, true);

    const updated = readAutoFixState(TMP);
    expect(updated.entries["abc123def456"].totalAutoFixCost).toBe(1.0);
  });

  it("still works with valid SHA when isDirectSha=true", () => {
    const state: AutoFixState = {
      entries: {
        abc123def456: {
          originalMergeSha: "abc123def456",
          originalJobId: "job-001",
          originalJobCost: 4.0,
          bugTodoTitle: "P2: bug",
          retryCount: 1,
          totalAutoFixCost: 1.0,
          createdAt: new Date().toISOString(),
        },
      },
    };
    writeAutoFixState(TMP, state);

    updateAutoFixCost(TMP, "abc123def456", 2.0, true);

    const updated = readAutoFixState(TMP);
    expect(updated.entries["abc123def456"].totalAutoFixCost).toBe(3.0);
  });
});
