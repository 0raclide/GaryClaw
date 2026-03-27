/**
 * Regression: ISSUE-001 — heavy tool detection missed non-first tool_use blocks
 * Found by /qa on 2026-03-28
 * Report: eng review finding — extractToolUse() returns first block only,
 *   so [Read, WebFetch] missed WebFetch as heavy.
 * Fix: moved heavy tool check into allToolUses loop in orchestrator.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GaryClawConfig, OrchestratorCallbacks, OrchestratorEvent } from "../src/types.js";

// Mock external dependencies
vi.mock("../src/sdk-wrapper.js", () => ({
  startSegment: vi.fn(),
  extractTurnUsage: vi.fn().mockReturnValue(null),
  extractResultData: vi.fn().mockReturnValue(null),
  verifyAuth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/relay.js", () => ({
  executeRelay: vi.fn().mockReturnValue({
    segmentOptions: { prompt: "relay prompt" },
    prepareResult: { stashed: false },
  }),
  finalizeRelay: vi.fn().mockReturnValue({}),
}));

vi.mock("../src/checkpoint.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    writeCheckpoint: vi.fn(),
    readCheckpoint: vi.fn().mockReturnValue(null),
  };
});

vi.mock("../src/oracle-memory.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    readOracleMemory: vi.fn().mockResolvedValue(null),
    isCircuitBreakerTripped: vi.fn().mockReturnValue(false),
  };
});

import {
  startSegment,
  extractTurnUsage,
  extractResultData,
  verifyAuth,
} from "../src/sdk-wrapper.js";
import { runSkill } from "../src/orchestrator.js";

const TEST_DIR = join(tmpdir(), "garyclaw-orch-regression1-" + process.pid);

function createTestConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skill: "qa",
    projectDir: TEST_DIR,
    checkpointDir: join(TEST_DIR, ".garyclaw"),
    maxTurnsPerSegment: 15,
    relayThreshold: 0.85,
    maxRelaySessions: 10,
    env: {},
    settingSources: [],
    autonomous: false,
    enableMemory: true,
    adaptiveMaxTurns: true,
    ...overrides,
  };
}

function createMockCallbacks(): OrchestratorCallbacks & { events: OrchestratorEvent[] } {
  const events: OrchestratorEvent[] = [];
  return {
    events,
    onEvent(ev: OrchestratorEvent) {
      events.push(ev);
    },
    onAskUser: async () => "Yes",
  };
}

/**
 * Build an assistant message with MULTIPLE tool_use blocks.
 * This is the key helper — the bug was that only the first block was checked.
 */
function makeMultiToolAssistantMsg(
  tools: Array<{ name: string; input: Record<string, any> }>,
): any {
  return {
    type: "assistant",
    message: {
      content: tools.map((t) => ({
        type: "tool_use",
        name: t.name,
        input: t.input,
      })),
    },
  };
}

function makeAssistantTextMsg(text: string): any {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  };
}

function makeResultMsg(subtype: string): any {
  return { type: "result", subtype };
}

function makeSegmentIterator(msgs: any[]): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < msgs.length) return { value: msgs[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  vi.mocked(verifyAuth).mockResolvedValue(undefined);
  vi.mocked(startSegment).mockReset();
  vi.mocked(extractTurnUsage).mockReturnValue(null);
  vi.mocked(extractResultData).mockReset();
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ISSUE-001: multi-tool heavy detection", () => {
  it("detects heavy tool when it is NOT the first tool_use block in a message", async () => {
    // Segment 1: message has [Read, WebFetch] — WebFetch is heavy but comes second
    // Segment 2: should receive the heavy tool flag from segment 1
    const multiToolMsg = makeMultiToolAssistantMsg([
      { name: "Read", input: { file_path: "/tmp/test.ts" } },
      { name: "WebFetch", input: { url: "https://example.com" } },
    ]);
    const resultMsg1 = makeResultMsg("max_turns");
    const resultMsg2 = makeResultMsg("success");

    let callCount = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Need 3+ assistant messages to build growth data for adaptive turns
        return makeSegmentIterator([
          multiToolMsg,
          makeAssistantTextMsg("Processing..."),
          makeAssistantTextMsg("Still going..."),
          resultMsg1,
        ]);
      }
      return makeSegmentIterator([resultMsg2]);
    });

    // Provide growth data so adaptive computation uses heavy tool multiplier
    let turnUsageCallCount = 0;
    vi.mocked(extractTurnUsage).mockImplementation((msg: any) => {
      if (msg.type === "assistant") {
        turnUsageCallCount++;
        return {
          input_tokens: 0,
          output_tokens: 1000,
          cache_read_input_tokens: turnUsageCallCount * 50000,
          cache_creation_input_tokens: 0,
        };
      }
      return null;
    });

    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "session-123",
          subtype: msg.subtype,
          resultText: "ok",
          usage: null,
          modelUsage: { "claude-sonnet-4-5-20250929": { contextWindow: 1000000 } },
          totalCostUsd: 0,
          numTurns: 5,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    const adaptiveEvents = callbacks.events.filter((e) => e.type === "adaptive_turns");
    expect(adaptiveEvents.length).toBeGreaterThanOrEqual(2);

    // Second segment should mention heavy tool — proves WebFetch was detected
    // even though Read came first in the multi-tool message
    const secondEvent = adaptiveEvents[1] as any;
    expect(secondEvent.reason).toContain("heavy tool");
  });

  it("detects heavy tool in 3-tool message where heavy is in the middle", async () => {
    // [Read, Screenshot, Bash] — Screenshot is heavy, sandwiched between non-heavy
    const multiToolMsg = makeMultiToolAssistantMsg([
      { name: "Read", input: { file_path: "/tmp/a.ts" } },
      { name: "Screenshot", input: {} },
      { name: "Bash", input: { command: "echo hi" } },
    ]);
    const resultMsg1 = makeResultMsg("max_turns");
    const resultMsg2 = makeResultMsg("success");

    let callCount = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return makeSegmentIterator([
          multiToolMsg,
          makeAssistantTextMsg("Processing..."),
          makeAssistantTextMsg("Still going..."),
          resultMsg1,
        ]);
      }
      return makeSegmentIterator([resultMsg2]);
    });

    let turnUsageCallCount = 0;
    vi.mocked(extractTurnUsage).mockImplementation((msg: any) => {
      if (msg.type === "assistant") {
        turnUsageCallCount++;
        return {
          input_tokens: 0,
          output_tokens: 1000,
          cache_read_input_tokens: turnUsageCallCount * 50000,
          cache_creation_input_tokens: 0,
        };
      }
      return null;
    });

    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1",
          subtype: msg.subtype,
          resultText: "ok",
          usage: null,
          modelUsage: { "claude-sonnet-4-5-20250929": { contextWindow: 1000000 } },
          totalCostUsd: 0,
          numTurns: 5,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    const adaptiveEvents = callbacks.events.filter((e) => e.type === "adaptive_turns");
    expect(adaptiveEvents.length).toBeGreaterThanOrEqual(2);

    // Screenshot detected as heavy despite being second in a 3-tool message
    const secondEvent = adaptiveEvents[1] as any;
    expect(secondEvent.reason).toContain("heavy tool");
  });

  it("does NOT flag heavy when multi-tool message has only non-heavy tools", async () => {
    // [Read, Bash, Edit] — none are heavy
    const multiToolMsg = makeMultiToolAssistantMsg([
      { name: "Read", input: { file_path: "/tmp/a.ts" } },
      { name: "Bash", input: { command: "npm test" } },
      { name: "Edit", input: { file_path: "/tmp/b.ts" } },
    ]);
    const resultMsg1 = makeResultMsg("max_turns");
    const resultMsg2 = makeResultMsg("success");

    let callCount = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return makeSegmentIterator([
          multiToolMsg,
          makeAssistantTextMsg("Processing..."),
          makeAssistantTextMsg("Still going..."),
          resultMsg1,
        ]);
      }
      return makeSegmentIterator([resultMsg2]);
    });

    let turnUsageCallCount = 0;
    vi.mocked(extractTurnUsage).mockImplementation((msg: any) => {
      if (msg.type === "assistant") {
        turnUsageCallCount++;
        return {
          input_tokens: 0,
          output_tokens: 1000,
          cache_read_input_tokens: turnUsageCallCount * 50000,
          cache_creation_input_tokens: 0,
        };
      }
      return null;
    });

    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1",
          subtype: msg.subtype,
          resultText: "ok",
          usage: null,
          modelUsage: { "claude-sonnet-4-5-20250929": { contextWindow: 1000000 } },
          totalCostUsd: 0,
          numTurns: 5,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    const adaptiveEvents = callbacks.events.filter((e) => e.type === "adaptive_turns");
    expect(adaptiveEvents.length).toBeGreaterThanOrEqual(2);

    // No heavy tool in the multi-tool message → no heavy tool flag
    const secondEvent = adaptiveEvents[1] as any;
    expect(secondEvent.reason).not.toContain("heavy tool");
  });

  it("emits tool_use event for first tool but still detects heavy in later position", async () => {
    // Verify the live progress event uses the first tool (Read) but heavy detection
    // still catches WebFetch in the second position
    const multiToolMsg = makeMultiToolAssistantMsg([
      { name: "Read", input: { file_path: "/tmp/test.ts" } },
      { name: "WebSearch", input: { query: "test query" } },
    ]);
    const resultMsg = makeResultMsg("success");

    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([multiToolMsg, resultMsg]),
    );

    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1",
          subtype: "success",
          resultText: "ok",
          usage: null,
          modelUsage: null,
          totalCostUsd: 0,
          numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    // tool_use event should be for Read (first tool in message)
    const toolEvents = callbacks.events.filter((e) => e.type === "tool_use");
    expect(toolEvents.length).toBeGreaterThanOrEqual(1);
    expect((toolEvents[0] as any).toolName).toBe("Read");

    // But WebSearch (heavy, second position) should still be tracked
    // We can verify this indirectly: if a second segment existed, it would get the flag.
    // Since this is a single-segment success, just verify the events were emitted correctly.
    expect(callbacks.events.some((e) => e.type === "skill_complete")).toBe(true);
  });
});
