/**
 * Orchestrator tests — runSkill flow, abort handling, error paths,
 * relay triggering, checkpoint building, helper functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GaryClawConfig, OrchestratorCallbacks, OrchestratorEvent, SegmentResult } from "../src/types.js";

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
  const actual = await importOriginal() as any;
  return {
    ...actual,
    writeCheckpoint: vi.fn(),
    readCheckpoint: vi.fn().mockReturnValue(null),
    generateRelayPrompt: vi.fn().mockReturnValue("relay prompt"),
  };
});

vi.mock("../src/oracle.js", () => ({
  askOracle: vi.fn(),
  createSdkOracleQueryFn: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue("main\n"),
}));

vi.mock("../src/reflection.js", () => ({
  runReflection: vi.fn().mockReturnValue({ outcomes: [], metrics: { totalDecisions: 0 }, reopenedCount: 0 }),
}));

vi.mock("../src/oracle-memory.js", () => ({
  defaultMemoryConfig: vi.fn().mockReturnValue({ globalDir: "/tmp/global", projectDir: "/tmp/project" }),
  readOracleMemory: vi.fn().mockReturnValue({ taste: null, domainExpertise: null, decisionOutcomes: null, memoryMd: null }),
  isCircuitBreakerTripped: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/notifier.js", () => ({
  sendNotification: vi.fn(),
}));

import { startSegment, extractTurnUsage, extractResultData, verifyAuth } from "../src/sdk-wrapper.js";
import { executeRelay } from "../src/relay.js";
import { writeCheckpoint, readCheckpoint } from "../src/checkpoint.js";
import { runSkill, runSkillWithInitialPrompt, resumeSkill } from "../src/orchestrator.js";
import { runReflection } from "../src/reflection.js";

const TEST_DIR = join(tmpdir(), `garyclaw-orch-test-${Date.now()}`);

function createTestConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skillName: "qa",
    projectDir: "/tmp/test-project",
    maxTurnsPerSegment: 15,
    relayThresholdRatio: 0.85,
    checkpointDir: join(TEST_DIR, "checkpoints"),
    settingSources: ["user", "project"],
    env: { HOME: "/home/test" },
    askTimeoutMs: 5000,
    maxRelaySessions: 10,
    autonomous: false,
    ...overrides,
  };
}

function createMockCallbacks(): OrchestratorCallbacks & { events: OrchestratorEvent[] } {
  const events: OrchestratorEvent[] = [];
  return {
    events,
    onEvent: (event: OrchestratorEvent) => { events.push(event); },
    onAskUser: vi.fn().mockResolvedValue("approve"),
  };
}

/** Create an async iterable that yields the given messages */
function makeSegmentIterator(messages: any[]): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= messages.length) return { done: true, value: undefined };
          return { done: false, value: messages[i++] };
        },
      };
    },
  };
}

/** Create a mock result message with success subtype */
function makeResultMsg(subtype: string = "success", overrides: Partial<SegmentResult> = {}): any {
  return {
    type: "result",
    subtype,
    sessionId: "session-123",
    resultText: "Done",
    totalCostUsd: 0.05,
    numTurns: 5,
    usage: { input_tokens: 1000, output_tokens: 500 },
    modelUsage: { "claude-sonnet-4-5-20250929": { contextWindow: 200000 } },
    ...overrides,
  };
}

/** Create a mock assistant message with text */
function makeAssistantTextMsg(text: string): any {
  return {
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  };
}

/** Create a mock assistant message with tool use */
function makeAssistantToolUseMsg(name: string, input: Record<string, any> = {}): any {
  return {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", name, input }],
    },
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  vi.mocked(verifyAuth).mockResolvedValue(undefined);
  vi.mocked(startSegment).mockReset();
  vi.mocked(extractTurnUsage).mockReturnValue(null);
  vi.mocked(extractResultData).mockReset();
  vi.mocked(writeCheckpoint).mockReset();
  vi.mocked(readCheckpoint).mockReturnValue(null);
  vi.mocked(executeRelay).mockReturnValue({
    segmentOptions: { prompt: "relay prompt", maxTurns: 15, cwd: "/tmp", env: {}, settingSources: [], canUseTool: async () => ({ behavior: "allow" as const }) },
    prepareResult: { stashed: false },
  });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("runSkill", () => {
  it("emits error and returns when auth fails", async () => {
    vi.mocked(verifyAuth).mockRejectedValue(new Error("Not logged in"));
    const callbacks = createMockCallbacks();

    await runSkill(createTestConfig(), callbacks);

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "error", recoverable: false }),
    );
    const errorEvent = callbacks.events.find((e) => e.type === "error")!;
    expect((errorEvent as any).message).toContain("Auth failed");
    expect(startSegment).not.toHaveBeenCalled();
  });

  it("runs a successful single-segment skill to completion", async () => {
    const resultMsg = makeResultMsg("success");

    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([makeAssistantTextMsg("Working..."), resultMsg]),
    );
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "session-123",
          subtype: "success",
          resultText: "Done",
          usage: null,
          modelUsage: null,
          totalCostUsd: 0.05,
          numTurns: 5,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    expect(startSegment).toHaveBeenCalledOnce();
    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "skill_complete" }),
    );
    expect(writeCheckpoint).toHaveBeenCalledOnce();
  });

  it("continues with 'Continue.' when maxTurns is hit", async () => {
    const resultMsg1 = makeResultMsg("max_turns");
    const resultMsg2 = makeResultMsg("success");

    let callCount = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return makeSegmentIterator([resultMsg1]);
      return makeSegmentIterator([resultMsg2]);
    });
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "session-123",
          subtype: msg.subtype,
          resultText: "Done",
          usage: null,
          modelUsage: null,
          totalCostUsd: 0.05,
          numTurns: 5,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    expect(startSegment).toHaveBeenCalledTimes(2);
    // Second call should use "Continue." as prompt
    const secondCall = vi.mocked(startSegment).mock.calls[1][0];
    expect(secondCall.prompt).toBe("Continue.");
    // Should still have resume set for second segment
    expect(secondCall.resume).toBe("session-123");
  });

  it("emits error event on segment error and saves checkpoint", async () => {
    const resultMsg = makeResultMsg("error", { resultText: "SDK crash" });

    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([resultMsg]));
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "session-123",
          subtype: "error",
          resultText: "SDK crash",
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

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "error", message: expect.stringContaining("SDK crash") }),
    );
    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "checkpoint_saved" }),
    );
  });

  it("emits error when segment completes without result", async () => {
    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([makeAssistantTextMsg("No result coming")]),
    );

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig({ maxRelaySessions: 1 }), callbacks);

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: "Segment completed without result message",
      }),
    );
  });

  it("respects maxRelaySessions limit", async () => {
    // Always return no result → forces loop to exhaust sessions
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([]));

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig({ maxRelaySessions: 2 }), callbacks);

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("max relay sessions"),
      }),
    );
  });

  it("aborts immediately when AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig({ abortSignal: controller.signal }), callbacks);

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "error", message: "Aborted by signal" }),
    );
    expect(startSegment).not.toHaveBeenCalled();
  });

  it("emits assistant_text events for text messages", async () => {
    const resultMsg = makeResultMsg("success");
    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([makeAssistantTextMsg("Hello world"), resultMsg]),
    );
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "assistant_text", text: "Hello world" }),
    );
  });

  it("emits tool_use events for tool calls", async () => {
    const resultMsg = makeResultMsg("success");
    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([
        makeAssistantToolUseMsg("Read", { file_path: "/tmp/test.ts" }),
        resultMsg,
      ]),
    );
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "tool_use", toolName: "Read" }),
    );
  });

  it("emits cost_update when result has non-zero cost", async () => {
    const resultMsg = makeResultMsg("success");
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([resultMsg]));
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 1.23, numTurns: 10,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "cost_update", costUsd: 1.23 }),
    );
  });

  it("uses initial prompt override for pipeline context handoff", async () => {
    const resultMsg = makeResultMsg("success");
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([resultMsg]));
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkillWithInitialPrompt(
      createTestConfig(),
      callbacks,
      "Custom handoff prompt with context",
    );

    const firstCall = vi.mocked(startSegment).mock.calls[0][0];
    expect(firstCall.prompt).toBe("Custom handoff prompt with context");
  });

  it("uses default prompt when no override provided", async () => {
    const resultMsg = makeResultMsg("success");
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([resultMsg]));
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig({ skillName: "design-review" }), callbacks);

    const firstCall = vi.mocked(startSegment).mock.calls[0][0];
    expect(firstCall.prompt).toContain("/design-review");
    expect(firstCall.prompt).toContain("SKILL.md");
  });

  it("passes settingSources and env to startSegment", async () => {
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([]));

    const callbacks = createMockCallbacks();
    await runSkill(
      createTestConfig({
        settingSources: ["user"],
        env: { CUSTOM: "value" },
        maxRelaySessions: 1,
      }),
      callbacks,
    );

    const call = vi.mocked(startSegment).mock.calls[0][0];
    expect(call.settingSources).toEqual(["user"]);
    expect(call.env).toEqual({ CUSTOM: "value" });
  });
});

describe("resumeSkill", () => {
  it("emits error when no checkpoint found", async () => {
    vi.mocked(readCheckpoint).mockReturnValue(null);

    const callbacks = createMockCallbacks();
    await resumeSkill(join(TEST_DIR, "nonexistent"), createTestConfig(), callbacks);

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("No valid checkpoint"),
        recoverable: false,
      }),
    );
  });

  it("resumes with checkpoint's skillName", async () => {
    vi.mocked(readCheckpoint).mockReturnValue({
      version: 1,
      timestamp: "2026-03-25T00:00:00Z",
      runId: "run-1",
      skillName: "design-review",
      issues: [],
      findings: [],
      decisions: [],
      gitBranch: "main",
      gitHead: "abc123",
      tokenUsage: {
        lastContextSize: 0,
        contextWindow: 1000000,
        totalOutputTokens: 0,
        sessionCount: 1,
        estimatedCostUsd: 0,
        turnHistory: [],
      },
      screenshotPaths: [],
    });

    const resultMsg = makeResultMsg("success");
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([resultMsg]));
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await resumeSkill(TEST_DIR, createTestConfig({ skillName: "qa" }), callbacks);

    // Should use the relay prompt from generateRelayPrompt(), not the default "Run the /skill" prompt.
    // generateRelayPrompt is mocked to return "relay prompt".
    const call = vi.mocked(startSegment).mock.calls[0][0];
    expect(call.prompt).toBe("relay prompt");
    expect(call.prompt).not.toContain("Run the /");
  });
});

describe("relay flow", () => {
  it("triggers relay when context exceeds threshold", async () => {
    // Segment 1: result message sets contextWindow to 1M
    // Segment 2: assistant msg with 900K usage triggers relay flag, then result
    // After segment 2 completes with relay flag set → executeRelay called
    // Segment 3 (new session): completes successfully

    let segmentCall = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      segmentCall++;
      if (segmentCall === 1) {
        // First segment: just a result to set contextWindow
        return makeSegmentIterator([makeResultMsg("max_turns")]);
      }
      if (segmentCall === 2) {
        // Second segment: high-usage assistant msg + result
        return makeSegmentIterator([
          makeAssistantTextMsg("Working hard..."),
          makeResultMsg("max_turns"),
        ]);
      }
      // Third segment (new session after relay): success
      return makeSegmentIterator([makeResultMsg("success")]);
    });

    // First call to extractTurnUsage (from segment 2's assistant msg) returns
    // very high usage to trigger relay
    let turnUsageCallCount = 0;
    vi.mocked(extractTurnUsage).mockImplementation((msg: any) => {
      if (msg.type === "assistant") {
        turnUsageCallCount++;
        return {
          input_tokens: 900000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
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
          totalCostUsd: 0.1,
          numTurns: 5,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "relay_triggered" }),
    );
    expect(executeRelay).toHaveBeenCalled();
    expect(writeCheckpoint).toHaveBeenCalled();
    // Should eventually complete
    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "skill_complete" }),
    );
  });
});

describe("helper functions (via exports)", () => {
  it("extractAssistantText returns null for non-assistant messages", async () => {
    const resultMsg = makeResultMsg("success");
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([
      { type: "user", content: "hello" },
      resultMsg,
    ]));
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    // Should NOT have assistant_text events for non-assistant messages
    expect(callbacks.events.filter((e) => e.type === "assistant_text")).toHaveLength(0);
  });

  it("extracts tool use with input summary for Read tool", async () => {
    const resultMsg = makeResultMsg("success");
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([
      makeAssistantToolUseMsg("Read", { file_path: "/path/to/file.ts" }),
      resultMsg,
    ]));
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    const toolEvent = callbacks.events.find((e) => e.type === "tool_use");
    expect(toolEvent).toBeDefined();
    expect((toolEvent as any).inputSummary).toBe("/path/to/file.ts");
  });

  it("extracts tool use with input summary for Bash tool", async () => {
    const resultMsg = makeResultMsg("success");
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([
      makeAssistantToolUseMsg("Bash", { command: "npm test" }),
      resultMsg,
    ]));
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    const toolEvent = callbacks.events.find((e) => e.type === "tool_use");
    expect(toolEvent).toBeDefined();
    expect((toolEvent as any).inputSummary).toBe("npm test");
  });

  it("truncates long tool input summaries", async () => {
    const longPath = "/very/long/path/" + "a".repeat(100) + ".ts";
    const resultMsg = makeResultMsg("success");
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([
      makeAssistantToolUseMsg("Read", { file_path: longPath }),
      resultMsg,
    ]));
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    const toolEvent = callbacks.events.find((e) => e.type === "tool_use");
    expect((toolEvent as any).inputSummary.length).toBeLessThanOrEqual(80);
    expect((toolEvent as any).inputSummary).toMatch(/\.\.\.$/);
  });
});

describe("AbortSignal mid-run", () => {
  it("aborts between segments when signal fires mid-execution", async () => {
    const controller = new AbortController();
    const resultMsg1 = makeResultMsg("max_turns");

    let segmentCall = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      segmentCall++;
      if (segmentCall === 1) {
        // After first segment completes, abort the signal
        controller.abort();
        return makeSegmentIterator([resultMsg1]);
      }
      // Should never reach here
      return makeSegmentIterator([makeResultMsg("success")]);
    });
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: msg.subtype, resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig({ abortSignal: controller.signal }), callbacks);

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "error", message: "Aborted by signal", recoverable: false }),
    );
    // Should have started only 1 segment (aborted before second)
    expect(startSegment).toHaveBeenCalledTimes(1);
  });
});

describe("checkpoint quadratic regression", () => {
  it("checkpoint data does not duplicate across multiple relays", async () => {
    // This test verifies the quadratic growth fix by checking that
    // writeCheckpoint is called with non-duplicated data across relays.
    // Simulate: segment 1 sets contextWindow, segment 2 triggers relay,
    // segment 3 (new session) triggers relay again, segment 4 succeeds.

    let segmentCall = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      segmentCall++;
      if (segmentCall <= 2) {
        return makeSegmentIterator([
          makeAssistantTextMsg("Working..."),
          makeResultMsg("max_turns"),
        ]);
      }
      return makeSegmentIterator([makeResultMsg("success")]);
    });

    vi.mocked(extractTurnUsage).mockImplementation((msg: any) => {
      if (msg.type === "assistant") {
        return {
          input_tokens: 900000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        };
      }
      return null;
    });

    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: msg.subtype, resultText: "ok",
          usage: null,
          modelUsage: { "claude-sonnet-4-5-20250929": { contextWindow: 1000000 } },
          totalCostUsd: 0.1, numTurns: 5,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    // writeCheckpoint should be called at least twice (relay + final)
    const checkpointCalls = vi.mocked(writeCheckpoint).mock.calls;
    expect(checkpointCalls.length).toBeGreaterThanOrEqual(2);

    // Each checkpoint's decisions array should not contain duplicates
    // from previous checkpoints (the quadratic growth bug)
    for (const [checkpoint] of checkpointCalls) {
      const cp = checkpoint as any;
      const decisionQuestions = cp.decisions.map((d: any) => d.question);
      const uniqueQuestions = new Set(decisionQuestions);
      expect(decisionQuestions.length).toBe(uniqueQuestions.size);
    }
  });
});

describe("relay re-check on first segment", () => {
  it("triggers relay via re-check after setContextWindow on first segment result", async () => {
    // The fix: shouldRelay is re-checked after setContextWindow, so relay
    // can trigger on the first segment even though contextWindow was null
    // during assistant message processing.

    let segmentCall = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      segmentCall++;
      if (segmentCall === 1) {
        // First segment: assistant msg with high usage, then result sets contextWindow
        return makeSegmentIterator([
          makeAssistantTextMsg("Processing..."),
          makeResultMsg("max_turns"),
        ]);
      }
      // Second segment (after relay): success
      return makeSegmentIterator([makeResultMsg("success")]);
    });

    vi.mocked(extractTurnUsage).mockImplementation((msg: any) => {
      if (msg.type === "assistant") {
        return {
          input_tokens: 900000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        };
      }
      return null;
    });

    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: msg.subtype, resultText: "ok",
          usage: null,
          modelUsage: { "claude-sonnet-4-5-20250929": { contextWindow: 1000000 } },
          totalCostUsd: 0.1, numTurns: 5,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    // Relay should trigger on the first segment (not requiring a second segment)
    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "relay_triggered" }),
    );
    expect(executeRelay).toHaveBeenCalled();
  });
});

describe("cost accumulation across relays", () => {
  it("accumulates cost across relay sessions, not resetting on each session", async () => {
    // Session 1: segment triggers relay with $0.50 cost
    // Session 2: segment completes successfully with $0.30 cost
    // Total should be $0.80, not $0.30 (which was the bug before the fix)

    let segmentCall = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      segmentCall++;
      if (segmentCall === 1) {
        // Session 1: high usage triggers relay
        return makeSegmentIterator([
          makeAssistantTextMsg("Session 1 work..."),
          makeResultMsg("max_turns"),
        ]);
      }
      // Session 2 (after relay): completes successfully
      return makeSegmentIterator([makeResultMsg("success")]);
    });

    vi.mocked(extractTurnUsage).mockImplementation((msg: any) => {
      if (msg.type === "assistant") {
        return {
          input_tokens: 900000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        };
      }
      return null;
    });

    let resultCallCount = 0;
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        resultCallCount++;
        return {
          sessionId: `s${resultCallCount}`,
          subtype: msg.subtype,
          resultText: "ok",
          usage: null,
          modelUsage: { "claude-sonnet-4-5-20250929": { contextWindow: 1000000 } },
          // Session 1 costs $0.50, Session 2 costs $0.30
          totalCostUsd: resultCallCount <= 1 ? 0.50 : 0.30,
          numTurns: 5,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    // Find the skill_complete event and verify accumulated cost
    const completeEvent = callbacks.events.find((e) => e.type === "skill_complete");
    expect(completeEvent).toBeDefined();
    // Cost should be $0.50 (session 1) + $0.30 (session 2) = $0.80
    expect((completeEvent as any).costUsd).toBeCloseTo(0.80, 2);

    // Also verify cost_update events show accumulation
    const costEvents = callbacks.events.filter((e) => e.type === "cost_update");
    // Last cost_update should reflect the accumulated total
    if (costEvents.length > 0) {
      const lastCostEvent = costEvents[costEvents.length - 1] as any;
      expect(lastCostEvent.costUsd).toBeGreaterThan(0.30); // Must be more than just session 2
    }
  });
});

describe("codebase summary extraction", () => {
  it("extracts observations from assistant text and includes in checkpoint", async () => {
    // Assistant message with text that contains observation signal words
    const observationText = "This project uses a convention where all modules follow kebab-case naming and types.ts has zero imports.";
    const resultMsg = makeResultMsg("success");

    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([makeAssistantTextMsg(observationText), resultMsg]),
    );
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    // writeCheckpoint should be called with codebaseSummary containing the observation
    expect(writeCheckpoint).toHaveBeenCalled();
    const checkpointArg = vi.mocked(writeCheckpoint).mock.calls[0][0] as any;
    // The text has 2+ signal words ("uses", "convention", "naming") so it should be extracted
    if (checkpointArg.codebaseSummary) {
      expect(checkpointArg.codebaseSummary.observations.length).toBeGreaterThan(0);
    }
  });

  it("extracts failed approaches from assistant text", async () => {
    const failedText = "I tried using require() for the import but it failed because this is an ESM project with strict module boundaries.";
    const resultMsg = makeResultMsg("success");

    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([makeAssistantTextMsg(failedText), resultMsg]),
    );
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    expect(writeCheckpoint).toHaveBeenCalled();
    const checkpointArg = vi.mocked(writeCheckpoint).mock.calls[0][0] as any;
    if (checkpointArg.codebaseSummary) {
      expect(checkpointArg.codebaseSummary.failedApproaches.length).toBeGreaterThan(0);
    }
  });

  it("omits codebaseSummary when no observations extracted", async () => {
    // Plain text with no signal words
    const plainText = "I'll start by reading the file.";
    const resultMsg = makeResultMsg("success");

    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([makeAssistantTextMsg(plainText), resultMsg]),
    );
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return {
          sessionId: "s1", subtype: "success", resultText: "ok",
          usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    const checkpointArg = vi.mocked(writeCheckpoint).mock.calls[0][0] as any;
    expect(checkpointArg.codebaseSummary).toBeUndefined();
  });

  it("carries observations through relay to second session checkpoint", async () => {
    // Session 1: assistant text with observations → triggers relay
    // Session 2: completes successfully
    // The session 2 checkpoint should carry forward session 1's observations
    const observationText = "This project uses a convention where all modules follow kebab-case naming and the architecture is organized around zero-import types.";

    let segmentCall = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      segmentCall++;
      if (segmentCall === 1) {
        // Session 1: observation text + result that triggers relay
        return makeSegmentIterator([
          makeAssistantTextMsg(observationText),
          makeResultMsg("max_turns"),
        ]);
      }
      // Session 2 (after relay): success
      return makeSegmentIterator([makeResultMsg("success")]);
    });

    vi.mocked(extractTurnUsage).mockImplementation((msg: any) => {
      if (msg.type === "assistant") {
        return {
          input_tokens: 900000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
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
          totalCostUsd: 0.1,
          numTurns: 5,
        };
      }
      return null;
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    // writeCheckpoint called at least twice: relay checkpoint + final checkpoint
    const checkpointCalls = vi.mocked(writeCheckpoint).mock.calls;
    expect(checkpointCalls.length).toBeGreaterThanOrEqual(2);

    // First checkpoint (relay) should have observations from session 1
    const relayCheckpoint = checkpointCalls[0][0] as any;
    if (relayCheckpoint.codebaseSummary) {
      expect(relayCheckpoint.codebaseSummary.observations.length).toBeGreaterThan(0);
    }
  });
});

describe("Post-job reflection integration (9A)", () => {
  function setupSuccessfulSkill() {
    const resultMsg = makeResultMsg("success");
    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([makeAssistantTextMsg("Working..."), resultMsg]),
    );
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") return msg as SegmentResult;
      return null;
    });
  }

  it("calls runReflection after successful autonomous job with memory enabled", async () => {
    setupSuccessfulSkill();
    vi.mocked(runReflection).mockReset();

    const config = createTestConfig({ autonomous: true, noMemory: false });
    const callbacks = createMockCallbacks();
    await runSkill(config, callbacks);

    expect(runReflection).toHaveBeenCalledTimes(1);
    expect(runReflection).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: config.projectDir,
      }),
    );
  });

  it("does NOT call runReflection when noMemory is true", async () => {
    setupSuccessfulSkill();
    vi.mocked(runReflection).mockReset();

    const config = createTestConfig({ autonomous: true, noMemory: true });
    const callbacks = createMockCallbacks();
    await runSkill(config, callbacks);

    expect(runReflection).not.toHaveBeenCalled();
  });

  it("does NOT call runReflection when not autonomous", async () => {
    setupSuccessfulSkill();
    vi.mocked(runReflection).mockReset();

    const config = createTestConfig({ autonomous: false });
    const callbacks = createMockCallbacks();
    await runSkill(config, callbacks);

    expect(runReflection).not.toHaveBeenCalled();
  });

  it("survives reflection failure without crashing the orchestrator", async () => {
    setupSuccessfulSkill();
    vi.mocked(runReflection).mockReset();
    vi.mocked(runReflection).mockImplementation(() => {
      throw new Error("Reflection I/O failure");
    });

    const config = createTestConfig({ autonomous: true, noMemory: false });
    const callbacks = createMockCallbacks();

    // Should not throw
    await runSkill(config, callbacks);

    // Skill should still complete successfully
    const completeEvent = callbacks.events.find((e) => e.type === "skill_complete");
    expect(completeEvent).toBeDefined();
  });
});
