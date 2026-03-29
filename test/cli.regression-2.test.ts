/**
 * Regression: ISSUE-001 — formatEvent missing bootstrap_quality_check/recheck cases
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * formatEvent had no switch cases for bootstrap_quality_check or
 * bootstrap_quality_recheck, returning undefined and swallowing the events.
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

describe("ISSUE-001: formatEvent bootstrap quality events", () => {
  it("formats bootstrap_quality_check with score", () => {
    const result = formatEvent({
      type: "bootstrap_quality_check",
      qualityScore: 35,
      missingSections: ["Test Strategy", "Usage"],
      notes: ["Missing sections"],
    } as any);

    expect(result).toBeDefined();
    expect(result).toContain("35/100");
    expect(result).toContain("Quality Gate");
  });

  it("formats bootstrap_quality_check with missing sections", () => {
    const result = formatEvent({
      type: "bootstrap_quality_check",
      qualityScore: 40,
      missingSections: ["Architecture"],
      notes: [],
    } as any);

    expect(result).toContain("Architecture");
    expect(result).toContain("missing");
  });

  it("formats bootstrap_quality_check with no missing sections", () => {
    const result = formatEvent({
      type: "bootstrap_quality_check",
      qualityScore: 80,
      missingSections: [],
      notes: [],
    } as any);

    expect(result).toBeDefined();
    expect(result).toContain("80/100");
    // Should not contain "missing:" when no sections are missing
    expect(result).not.toContain("missing:");
  });

  it("formats bootstrap_quality_recheck with before/after scores", () => {
    const result = formatEvent({
      type: "bootstrap_quality_recheck",
      qualityScore: 72,
      previousScore: 25,
    } as any);

    expect(result).toBeDefined();
    expect(result).toContain("25");
    expect(result).toContain("72");
    expect(result).toContain("Quality Gate");
  });

  it("returns a string (not undefined) for both event types", () => {
    const check = formatEvent({
      type: "bootstrap_quality_check",
      qualityScore: 50,
      missingSections: [],
      notes: [],
    } as any);

    const recheck = formatEvent({
      type: "bootstrap_quality_recheck",
      qualityScore: 60,
      previousScore: 30,
    } as any);

    expect(typeof check).toBe("string");
    expect(typeof recheck).toBe("string");
  });
});
