/**
 * Daemon merge config validation tests.
 * Validates the optional merge field in DaemonConfig.
 */

import { describe, it, expect } from "vitest";
import { validateDaemonConfig } from "../src/daemon.js";
import type { DaemonConfig } from "../src/types.js";

function createValidConfig(merge?: DaemonConfig["merge"]): Record<string, unknown> {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [{ type: "git_poll", intervalSeconds: 60, skills: ["qa"] }],
    budget: { dailyCostLimitUsd: 5, perJobCostLimitUsd: 1, maxJobsPerDay: 10 },
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: false },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
    logging: { level: "info", retainDays: 7 },
    ...(merge !== undefined ? { merge } : {}),
  };
}

describe("validateDaemonConfig merge field", () => {
  it("accepts config without merge field (backward compat)", () => {
    expect(validateDaemonConfig(createValidConfig())).toBeNull();
  });

  it("accepts valid merge config with all fields", () => {
    expect(validateDaemonConfig(createValidConfig({
      testCommand: "npm test",
      testTimeout: 90000,
      skipValidation: false,
    }))).toBeNull();
  });

  it("accepts merge config with only testCommand", () => {
    expect(validateDaemonConfig(createValidConfig({
      testCommand: "npm run ci-test",
    }))).toBeNull();
  });

  it("accepts merge config with skipValidation only", () => {
    expect(validateDaemonConfig(createValidConfig({
      skipValidation: true,
    }))).toBeNull();
  });

  it("accepts empty merge object", () => {
    expect(validateDaemonConfig(createValidConfig({}))).toBeNull();
  });

  it("rejects non-object merge", () => {
    expect(validateDaemonConfig(createValidConfig("npm test" as any))).toBe("merge must be an object");
  });

  it("rejects null merge", () => {
    expect(validateDaemonConfig(createValidConfig(null as any))).toBe("merge must be an object");
  });

  it("rejects empty string testCommand", () => {
    expect(validateDaemonConfig(createValidConfig({ testCommand: "" }))).toBe("merge.testCommand must be a non-empty string");
  });

  it("rejects non-string testCommand", () => {
    expect(validateDaemonConfig(createValidConfig({ testCommand: 42 } as any))).toBe("merge.testCommand must be a non-empty string");
  });

  it("rejects zero testTimeout", () => {
    expect(validateDaemonConfig(createValidConfig({ testTimeout: 0 }))).toBe("merge.testTimeout must be a positive number");
  });

  it("rejects negative testTimeout", () => {
    expect(validateDaemonConfig(createValidConfig({ testTimeout: -1000 }))).toBe("merge.testTimeout must be a positive number");
  });

  it("rejects non-number testTimeout", () => {
    expect(validateDaemonConfig(createValidConfig({ testTimeout: "fast" } as any))).toBe("merge.testTimeout must be a positive number");
  });

  it("rejects non-boolean skipValidation", () => {
    expect(validateDaemonConfig(createValidConfig({ skipValidation: "yes" } as any))).toBe("merge.skipValidation must be a boolean");
  });
});

describe("validateDaemonConfig merge PR fields", () => {
  it('accepts strategy "direct"', () => {
    expect(validateDaemonConfig(createValidConfig({ strategy: "direct" }))).toBeNull();
  });

  it('accepts strategy "pr"', () => {
    expect(validateDaemonConfig(createValidConfig({ strategy: "pr" }))).toBeNull();
  });

  it("rejects invalid strategy", () => {
    expect(validateDaemonConfig(createValidConfig({ strategy: "github" } as any))).toBe('merge.strategy must be "direct" or "pr"');
  });

  it("accepts prAutoMerge boolean", () => {
    expect(validateDaemonConfig(createValidConfig({ strategy: "pr", prAutoMerge: false }))).toBeNull();
  });

  it("rejects non-boolean prAutoMerge", () => {
    expect(validateDaemonConfig(createValidConfig({ prAutoMerge: "yes" } as any))).toBe("merge.prAutoMerge must be a boolean");
  });

  it('accepts prMergeMethod "squash"', () => {
    expect(validateDaemonConfig(createValidConfig({ prMergeMethod: "squash" }))).toBeNull();
  });

  it('accepts prMergeMethod "merge"', () => {
    expect(validateDaemonConfig(createValidConfig({ prMergeMethod: "merge" }))).toBeNull();
  });

  it('accepts prMergeMethod "rebase"', () => {
    expect(validateDaemonConfig(createValidConfig({ prMergeMethod: "rebase" }))).toBeNull();
  });

  it("rejects invalid prMergeMethod", () => {
    expect(validateDaemonConfig(createValidConfig({ prMergeMethod: "fast-forward" } as any))).toBe('merge.prMergeMethod must be "squash", "merge", or "rebase"');
  });

  it("accepts valid prLabels", () => {
    expect(validateDaemonConfig(createValidConfig({ prLabels: ["bot", "auto"] }))).toBeNull();
  });

  it("accepts empty prLabels array", () => {
    expect(validateDaemonConfig(createValidConfig({ prLabels: [] }))).toBeNull();
  });

  it("rejects non-array prLabels", () => {
    expect(validateDaemonConfig(createValidConfig({ prLabels: "bot" } as any))).toBe("merge.prLabels must be an array of strings");
  });

  it("rejects prLabels with non-string elements", () => {
    expect(validateDaemonConfig(createValidConfig({ prLabels: [42] } as any))).toBe("merge.prLabels must be an array of strings");
  });

  it("accepts valid prReviewers", () => {
    expect(validateDaemonConfig(createValidConfig({ prReviewers: ["alice"] }))).toBeNull();
  });

  it("rejects non-array prReviewers", () => {
    expect(validateDaemonConfig(createValidConfig({ prReviewers: "alice" } as any))).toBe("merge.prReviewers must be an array of strings");
  });

  it("accepts prDraft boolean", () => {
    expect(validateDaemonConfig(createValidConfig({ prDraft: true }))).toBeNull();
  });

  it("rejects non-boolean prDraft", () => {
    expect(validateDaemonConfig(createValidConfig({ prDraft: "yes" } as any))).toBe("merge.prDraft must be a boolean");
  });

  it("accepts full PR config", () => {
    expect(validateDaemonConfig(createValidConfig({
      strategy: "pr",
      prAutoMerge: true,
      prMergeMethod: "squash",
      prLabels: ["garyclaw", "auto"],
      prReviewers: ["alice", "bob"],
      prDraft: false,
      testCommand: "npm test",
      testTimeout: 120000,
    }))).toBeNull();
  });

  // ── autoFixOnRevert ─────────────────────────────────────────

  it("accepts autoFixOnRevert boolean", () => {
    expect(validateDaemonConfig(createValidConfig({ autoFixOnRevert: true }))).toBeNull();
    expect(validateDaemonConfig(createValidConfig({ autoFixOnRevert: false }))).toBeNull();
  });

  it("rejects non-boolean autoFixOnRevert", () => {
    expect(validateDaemonConfig(createValidConfig({ autoFixOnRevert: "yes" } as any))).toBe("merge.autoFixOnRevert must be a boolean");
  });

  it("accepts full config with autoFixOnRevert", () => {
    expect(validateDaemonConfig(createValidConfig({
      strategy: "direct",
      testCommand: "npm test",
      autoFixOnRevert: true,
    }))).toBeNull();
  });
});
