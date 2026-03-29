/**
 * Regression: ISSUE-001 — backward compat: missing config.merge should NOT trigger test gate.
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * When config.merge is undefined (user has no merge key in daemon.json),
 * the auto-merge block should pass no validation options to mergeWorktreeBranch,
 * so the test gate never activates. Previously, `config.merge ?? {}` normalized
 * undefined to {}, which built a truthy validation object, activating the test gate.
 */

import { describe, it, expect } from "vitest";

describe("merge config backward compat", () => {
  /**
   * Simulate the merge config construction logic from job-runner.ts (lines 362-375).
   * This is a pure logic test — no mocks, no I/O.
   */
  function buildValidationFromMergeConfig(
    merge: { testCommand?: string; testTimeout?: number; skipValidation?: boolean } | undefined,
  ): { testCommand?: string; testTimeout?: number; skipValidation?: boolean } | undefined {
    // This mirrors the FIXED logic in job-runner.ts
    if (!merge) return undefined;
    if (merge.skipValidation) return { skipValidation: true };
    return { testCommand: merge.testCommand, testTimeout: merge.testTimeout };
  }

  it("undefined merge config produces undefined validation (no test gate)", () => {
    const validation = buildValidationFromMergeConfig(undefined);
    expect(validation).toBeUndefined();
  });

  it("empty merge object {} produces validation with defaults (test gate activates)", () => {
    const validation = buildValidationFromMergeConfig({});
    // Empty object is explicitly provided = user opted in, even with defaults
    expect(validation).toBeDefined();
    expect(validation!.testCommand).toBeUndefined(); // will default to "npm test"
    expect(validation!.testTimeout).toBeUndefined(); // will default to 120000
  });

  it("explicit skipValidation skips test gate", () => {
    const validation = buildValidationFromMergeConfig({ skipValidation: true });
    expect(validation).toEqual({ skipValidation: true });
  });

  it("explicit testCommand passes through", () => {
    const validation = buildValidationFromMergeConfig({ testCommand: "bun test", testTimeout: 60000 });
    expect(validation).toEqual({ testCommand: "bun test", testTimeout: 60000 });
  });
});
