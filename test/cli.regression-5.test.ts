/**
 * Regression: formatEvent missing priority_pick_rejected/exhausted cases.
 * Added as part of prioritize completed-item detection gap fix.
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

describe("formatEvent: priority pick events", () => {
  it("formats priority_pick_rejected with title and reason", () => {
    const result = formatEvent({
      type: "priority_pick_rejected",
      title: "P3: Implement Skill Hardening",
      reason: "completed",
    } as any);

    expect(result).toBeDefined();
    expect(result).toContain("Prioritize");
    expect(result).toContain("rejected");
    expect(result).toContain("completed");
    expect(result).toContain("P3: Implement Skill Hardening");
  });

  it("formats priority_pick_exhausted", () => {
    const result = formatEvent({
      type: "priority_pick_exhausted",
    } as any);

    expect(result).toBeDefined();
    expect(result).toContain("Prioritize");
    expect(result).toContain("exhausted");
  });
});
