/**
 * Regression: ISSUE-002 — null/undefined msg crashes extractAssistantText/extractToolUse
 * Found by /qa on 2026-03-26
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-26.md
 *
 * Before fix: passing null or undefined as msg would throw
 * "Cannot read properties of null (reading 'type')".
 * After fix: returns null gracefully.
 */

import { describe, it, expect, vi } from "vitest";

// Mock external deps so the module can load
vi.mock("../src/sdk-wrapper.js", () => ({
  startSegment: vi.fn(),
  extractTurnUsage: vi.fn(),
  extractResultData: vi.fn(),
  verifyAuth: vi.fn(),
}));
vi.mock("../src/relay.js", () => ({
  executeRelay: vi.fn(),
  finalizeRelay: vi.fn(),
}));
vi.mock("../src/checkpoint.js", () => ({
  writeCheckpoint: vi.fn(),
  readCheckpoint: vi.fn(),
  generateRelayPrompt: vi.fn(),
}));
vi.mock("../src/oracle.js", () => ({
  askOracle: vi.fn(),
  createSdkOracleQueryFn: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue("main\n"),
}));

import { extractAssistantText, extractToolUse } from "../src/orchestrator.js";

describe("ISSUE-002: null msg guard", () => {
  it("extractAssistantText returns null for null msg", () => {
    expect(extractAssistantText(null)).toBeNull();
  });

  it("extractAssistantText returns null for undefined msg", () => {
    expect(extractAssistantText(undefined)).toBeNull();
  });

  it("extractToolUse returns null for null msg", () => {
    expect(extractToolUse(null)).toBeNull();
  });

  it("extractToolUse returns null for undefined msg", () => {
    expect(extractToolUse(undefined)).toBeNull();
  });

  it("extractAssistantText still works for valid assistant msg", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
    };
    expect(extractAssistantText(msg)).toBe("hello");
  });

  it("extractToolUse still works for valid tool_use msg", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/a.ts" } }],
      },
    };
    const result = extractToolUse(msg);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("Read");
  });
});
