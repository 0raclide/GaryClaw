/**
 * Regression test: project type prefix must persist across relay sessions.
 *
 * When the orchestrator triggers a relay, the relay prompt replaces the original
 * prompt. The project type prefix (e.g., "This project has NO web UI") must be
 * appended to the relay prompt so session 2+ retains project type context.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GaryClawConfig, OrchestratorCallbacks, OrchestratorEvent } from "../src/types.js";

// Mock project-type to return a known CLI type
vi.mock("../src/project-type.js", () => ({
  ensureProjectType: vi.fn().mockReturnValue({
    type: "cli",
    confidence: 0.9,
    evidence: ["CLAUDE.md contains \"cli tool\""],
    frameworks: ["commander"],
    hasWebUI: false,
    hasTestSuite: true,
    testCommand: "vitest",
  }),
  formatProjectContext: vi.fn().mockReturnValue("CLI tool (confidence: 0.9). No web UI. Test suite: vitest."),
  buildProjectTypeSection: vi.fn().mockReturnValue(""),
}));

vi.mock("../src/sdk-wrapper.js", () => ({
  startSegment: vi.fn(),
  extractTurnUsage: vi.fn().mockReturnValue(null),
  extractResultData: vi.fn().mockReturnValue(null),
  verifyAuth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/relay.js", () => ({
  executeRelay: vi.fn().mockReturnValue({
    segmentOptions: { prompt: "relay prompt from checkpoint" },
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
    generateRelayPrompt: vi.fn().mockReturnValue("relay prompt from checkpoint"),
  };
});

vi.mock("../src/oracle.js", () => ({
  askOracle: vi.fn(),
  askOracleBatch: vi.fn(),
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

import { startSegment, extractTurnUsage, extractResultData } from "../src/sdk-wrapper.js";
import { runSkill } from "../src/orchestrator.js";

const TEST_DIR = join(tmpdir(), `garyclaw-orch-pt-relay-${Date.now()}`);

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
    noMemory: true,
    ...overrides,
  };
}

function createMockCallbacks(): OrchestratorCallbacks & { events: OrchestratorEvent[] } {
  const events: OrchestratorEvent[] = [];
  return {
    events,
    onEvent: vi.fn((e: OrchestratorEvent) => events.push(e)),
  };
}

function makeAssistantTextMsg(text: string) {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }], usage: {} },
  };
}

function makeResultMsg(subtype: string) {
  return { type: "result", subtype };
}

function makeSegmentIterator(messages: unknown[]) {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (i < messages.length) return { value: messages[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
    abort: vi.fn(),
  } as any;
}

describe("relay preserves project type prefix", () => {
  beforeEach(() => mkdirSync(join(TEST_DIR, "checkpoints"), { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("relay prompt includes project type prefix after relay", async () => {
    let segmentCall = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      segmentCall++;
      if (segmentCall === 1) {
        // First segment: sets contextWindow
        return makeSegmentIterator([makeResultMsg("max_turns")]);
      }
      if (segmentCall === 2) {
        // Second segment: high usage triggers relay
        return makeSegmentIterator([
          makeAssistantTextMsg("Working..."),
          makeResultMsg("max_turns"),
        ]);
      }
      // Third segment (after relay): success
      return makeSegmentIterator([makeResultMsg("success")]);
    });

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

    // The third startSegment call (after relay) should have the relay prompt
    // with the project type prefix appended
    expect(segmentCall).toBeGreaterThanOrEqual(3);
    const thirdCall = vi.mocked(startSegment).mock.calls[2]?.[0];
    expect(thirdCall).toBeDefined();

    // The prompt should contain both the relay prompt and the project type info
    expect(thirdCall.prompt).toContain("relay prompt from checkpoint");
    expect(thirdCall.prompt).toContain("Project type:");
    expect(thirdCall.prompt).toContain("NO web UI");
    expect(thirdCall.prompt).toContain("Do NOT attempt browser testing");
  });

  it("first segment prompt includes project type prefix", async () => {
    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([makeResultMsg("success")]),
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

    const firstCall = vi.mocked(startSegment).mock.calls[0][0];
    expect(firstCall.prompt).toContain("Project type:");
    expect(firstCall.prompt).toContain("NO web UI");
  });
});
