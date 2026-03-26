/**
 * Orchestrator helper tests — extractAssistantText, extractToolUse,
 * summarizeToolInput, truncate, deduplicateIssues.
 *
 * These test the pure helper functions exported from orchestrator.ts
 * without touching the SDK or relay machinery.
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

import {
  extractAssistantText,
  extractToolUse,
  summarizeToolInput,
  truncate,
  deduplicateIssues,
} from "../src/orchestrator.js";

import type { Issue } from "../src/types.js";

// ── truncate ─────────────────────────────────────────────────────

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates strings longer than max", () => {
    expect(truncate("hello world", 8)).toBe("hello...");
  });

  it("handles exact-length strings", () => {
    expect(truncate("exact", 5)).toBe("exact");
  });

  it("handles empty strings", () => {
    expect(truncate("", 10)).toBe("");
  });

  it("handles max=3 (minimum for ellipsis)", () => {
    expect(truncate("abcdef", 3)).toBe("...");
  });
});

// ── summarizeToolInput ───────────────────────────────────────────

describe("summarizeToolInput", () => {
  it("summarizes Read tool with file_path", () => {
    expect(summarizeToolInput("Read", { file_path: "/src/main.ts" })).toBe("/src/main.ts");
  });

  it("summarizes Edit tool with file_path", () => {
    expect(summarizeToolInput("Edit", { file_path: "/src/app.tsx" })).toBe("/src/app.tsx");
  });

  it("summarizes Write tool with file_path", () => {
    expect(summarizeToolInput("Write", { file_path: "/tmp/out.txt" })).toBe("/tmp/out.txt");
  });

  it("summarizes Bash tool with command", () => {
    expect(summarizeToolInput("Bash", { command: "npm test" })).toBe("npm test");
  });

  it("summarizes Glob tool with pattern", () => {
    expect(summarizeToolInput("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("summarizes Grep tool with pattern", () => {
    expect(summarizeToolInput("Grep", { pattern: "TODO" })).toBe("TODO");
  });

  it("summarizes WebFetch with url", () => {
    expect(summarizeToolInput("WebFetch", { url: "https://example.com" })).toBe("https://example.com");
  });

  it("falls back to first string value for unknown tools", () => {
    expect(summarizeToolInput("CustomTool", { query: "search term" })).toBe("search term");
  });

  it("returns empty string for unknown tool with no string values", () => {
    expect(summarizeToolInput("CustomTool", { count: 42 })).toBe("");
  });

  it("returns empty string when expected field is missing", () => {
    expect(summarizeToolInput("Read", {})).toBe("");
    expect(summarizeToolInput("Bash", {})).toBe("");
  });

  it("truncates long file paths", () => {
    const longPath = "/very/long/path/" + "a".repeat(100) + ".ts";
    const result = summarizeToolInput("Read", { file_path: longPath });
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result).toContain("...");
  });

  it("truncates long bash commands", () => {
    const longCmd = "find . -name " + "x".repeat(100);
    const result = summarizeToolInput("Bash", { command: longCmd });
    expect(result.length).toBeLessThanOrEqual(80);
  });
});

// ── extractAssistantText ─────────────────────────────────────────

describe("extractAssistantText", () => {
  it("extracts text from assistant message", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    };
    expect(extractAssistantText(msg)).toBe("Hello world");
  });

  it("concatenates multiple text blocks", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Part 1 " },
          { type: "text", text: "Part 2" },
        ],
      },
    };
    expect(extractAssistantText(msg)).toBe("Part 1 Part 2");
  });

  it("returns null for non-assistant messages", () => {
    expect(extractAssistantText({ type: "result" })).toBeNull();
    expect(extractAssistantText({ type: "user" })).toBeNull();
  });

  it("returns null when content is not an array", () => {
    const msg = { type: "assistant", message: { content: "raw string" } };
    expect(extractAssistantText(msg)).toBeNull();
  });

  it("returns null when message is missing", () => {
    expect(extractAssistantText({ type: "assistant" })).toBeNull();
  });

  it("returns null when no text blocks exist", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    };
    expect(extractAssistantText(msg)).toBeNull();
  });

  it("ignores non-text blocks and extracts only text", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash" },
          { type: "text", text: "After tool" },
        ],
      },
    };
    expect(extractAssistantText(msg)).toBe("After tool");
  });

  it("skips text blocks with empty text", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "" }] },
    };
    expect(extractAssistantText(msg)).toBeNull();
  });
});

// ── extractToolUse ───────────────────────────────────────────────

describe("extractToolUse", () => {
  it("extracts tool_use block from assistant message", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
        ],
      },
    };
    const result = extractToolUse(msg);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("Bash");
    expect(result!.inputSummary).toBe("ls -la");
  });

  it("returns null for non-assistant messages", () => {
    expect(extractToolUse({ type: "result" })).toBeNull();
  });

  it("returns null when no tool_use blocks exist", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
    };
    expect(extractToolUse(msg)).toBeNull();
  });

  it("returns null when content is not an array", () => {
    const msg = { type: "assistant", message: { content: null } };
    expect(extractToolUse(msg)).toBeNull();
  });

  it("uses 'unknown' when tool name is missing", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", input: {} }] },
    };
    const result = extractToolUse(msg);
    expect(result!.toolName).toBe("unknown");
  });

  it("handles missing input gracefully", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read" }] },
    };
    const result = extractToolUse(msg);
    expect(result!.toolName).toBe("Read");
    expect(result!.inputSummary).toBe("");
  });

  it("returns first tool_use when multiple exist", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/a.ts" } },
          { type: "tool_use", name: "Write", input: { file_path: "/b.ts" } },
        ],
      },
    };
    const result = extractToolUse(msg);
    expect(result!.toolName).toBe("Read");
  });
});

// ── deduplicateIssues ────────────────────────────────────────────

describe("deduplicateIssues", () => {
  const makeIssue = (id: string, desc: string): Issue => ({
    id,
    description: desc,
    severity: "medium",
    commitSha: "abc123",
    commitMessage: `fix: ${desc}`,
    skillName: "qa",
    timestamp: new Date().toISOString(),
  });

  it("returns all issues when no overlap", () => {
    const prev = [makeIssue("A", "a")];
    const tracker = [makeIssue("B", "b")];
    const result = deduplicateIssues(prev, tracker);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id)).toEqual(["A", "B"]);
  });

  it("deduplicates by ID", () => {
    const prev = [makeIssue("A", "a"), makeIssue("B", "b")];
    const tracker = [makeIssue("A", "a-updated"), makeIssue("C", "c")];
    const result = deduplicateIssues(prev, tracker);
    expect(result).toHaveLength(3);
    expect(result.map((i) => i.id)).toEqual(["A", "B", "C"]);
    // prev version of A wins (it comes first)
    expect(result[0].description).toBe("a");
  });

  it("handles empty previous issues", () => {
    const tracker = [makeIssue("A", "a")];
    const result = deduplicateIssues([], tracker);
    expect(result).toEqual(tracker);
  });

  it("handles empty tracker issues", () => {
    const prev = [makeIssue("A", "a")];
    const result = deduplicateIssues(prev, []);
    expect(result).toEqual(prev);
  });

  it("handles both empty", () => {
    expect(deduplicateIssues([], [])).toEqual([]);
  });

  it("handles all duplicates", () => {
    const prev = [makeIssue("A", "a"), makeIssue("B", "b")];
    const tracker = [makeIssue("A", "a2"), makeIssue("B", "b2")];
    const result = deduplicateIssues(prev, tracker);
    expect(result).toHaveLength(2);
  });
});
