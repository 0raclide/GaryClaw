/**
 * Regression: formatEvent pipeline_oracle_adjustment "kept_skipped" variant
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * The "kept_skipped" action is defined in the OrchestratorEvent type union but
 * had no dedicated test — only "restored" was tested. This verifies the else
 * branch in formatEvent.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/sdk-wrapper.js", () => ({
  buildSdkEnv: vi.fn((env: Record<string, string>) => env),
}));
vi.mock("../src/orchestrator.js", () => ({
  runSkill: vi.fn(),
  resumeSkill: vi.fn(),
}));
vi.mock("../src/pipeline.js", () => ({
  runPipeline: vi.fn(),
  resumePipeline: vi.fn(),
  readPipelineState: vi.fn(),
}));
vi.mock("../src/daemon-ipc.js", () => ({
  sendIPCRequest: vi.fn(),
}));
vi.mock("../src/daemon.js", () => ({
  readPidFile: vi.fn(),
  isPidAlive: vi.fn(),
  cleanupDaemonFiles: vi.fn(),
}));

import { formatEvent } from "../src/cli.js";

describe("formatEvent: pipeline_oracle_adjustment kept_skipped variant", () => {
  it("formats kept_skipped action with skill name and skip-risk", () => {
    const result = formatEvent({
      type: "pipeline_oracle_adjustment",
      skill: "design-review",
      skipRisk: 0.12,
      action: "kept_skipped",
    } as any);

    expect(result).toBeDefined();
    expect(result).toContain("Oracle Composition");
    expect(result).toContain("design-review");
    expect(result).toContain("12%");
    expect(result).toContain("Kept skipped");
  });

  it("does not contain 'Restored' for kept_skipped action", () => {
    const result = formatEvent({
      type: "pipeline_oracle_adjustment",
      skill: "qa",
      skipRisk: 0.05,
      action: "kept_skipped",
    } as any);

    expect(result).not.toContain("Restored");
    expect(result).toContain("Kept skipped");
  });

  it("formats zero skip-risk as 0%", () => {
    const result = formatEvent({
      type: "pipeline_oracle_adjustment",
      skill: "implement",
      skipRisk: 0,
      action: "kept_skipped",
    } as any);

    expect(result).toContain("0%");
  });
});
