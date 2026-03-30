/**
 * Regression: ISSUE-001 — formatEvent missing oracle_cache_hit/miss/invalidated cases
 * Found by /qa on 2026-03-30
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
 *
 * The oracle_cache_hit, oracle_cache_miss, and oracle_cache_invalidated event types
 * were added to OrchestratorEvent in types.ts but formatEvent had no case branches,
 * causing a TypeScript exhaustiveness error (TS2366).
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

describe("formatEvent: oracle cache events", () => {
  it("formats oracle_cache_hit with question, chosen, and hit count", () => {
    const result = formatEvent({
      type: "oracle_cache_hit",
      question: "Should we use tabs or spaces?",
      chosen: "tabs",
      hitCount: 7,
    } as any);

    expect(result).toBeDefined();
    expect(result).toContain("Oracle Cache");
    expect(result).toContain("Hit");
    expect(result).toContain("Should we use tabs or spaces?");
    expect(result).toContain("tabs");
    expect(result).toContain("7 hits");
  });

  it("truncates long questions at 50 chars with ellipsis", () => {
    const longQuestion = "Should we refactor the entire authentication subsystem to use OAuth 2.1 with PKCE flow?";
    const result = formatEvent({
      type: "oracle_cache_hit",
      question: longQuestion,
      chosen: "yes",
      hitCount: 3,
    } as any);

    expect(result).toContain("...");
    expect(result).not.toContain(longQuestion);
    expect(result.length).toBeLessThan(200);
  });

  it("formats oracle_cache_miss with question", () => {
    const result = formatEvent({
      type: "oracle_cache_miss",
      question: "Use Vitest or Jest?",
    } as any);

    expect(result).toBeDefined();
    expect(result).toContain("Oracle Cache");
    expect(result).toContain("Miss");
    expect(result).toContain("Use Vitest or Jest?");
  });

  it("formats oracle_cache_invalidated with question", () => {
    const result = formatEvent({
      type: "oracle_cache_invalidated",
      question: "Deploy to staging first?",
    } as any);

    expect(result).toBeDefined();
    expect(result).toContain("Oracle Cache");
    expect(result).toContain("Invalidated");
    expect(result).toContain("Deploy to staging first?");
  });

  it("does not truncate short questions (under 50 chars)", () => {
    const shortQ = "Use ESM or CJS?";
    const result = formatEvent({
      type: "oracle_cache_miss",
      question: shortQ,
    } as any);

    expect(result).toContain(shortQ);
    expect(result).not.toContain("...");
  });
});
