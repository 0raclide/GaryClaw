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
