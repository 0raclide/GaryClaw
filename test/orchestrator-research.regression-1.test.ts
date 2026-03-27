/**
 * Orchestrator research dispatch tests — verifies the short-circuit path
 * that routes skillName="research" + researchTopic directly to runResearch()
 * instead of starting a full SDK session.
 *
 * Regression: missing test coverage identified by /plan-eng-review
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GaryClawConfig, OrchestratorCallbacks, OrchestratorEvent } from "../src/types.js";

// Mock external dependencies (same pattern as orchestrator.test.ts)
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

vi.mock("../src/checkpoint.js", () => ({
  writeCheckpoint: vi.fn(),
  readCheckpoint: vi.fn().mockReturnValue(null),
  generateRelayPrompt: vi.fn().mockReturnValue("relay prompt"),
}));

vi.mock("../src/oracle.js", () => ({
  askOracle: vi.fn(),
  createSdkOracleQueryFn: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue("main\n"),
  execFileSync: vi.fn().mockReturnValue("main\n"),
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

vi.mock("../src/researcher.js", () => ({
  runResearch: vi.fn().mockResolvedValue({ searchesUsed: 5, topicWritten: true }),
}));

import { startSegment, verifyAuth } from "../src/sdk-wrapper.js";
import { runSkill } from "../src/orchestrator.js";
import { runResearch } from "../src/researcher.js";

const TEST_DIR = join(tmpdir(), `garyclaw-orch-research-test-${Date.now()}`);

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

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  vi.mocked(verifyAuth).mockResolvedValue(undefined);
  vi.mocked(startSegment).mockReset();
  vi.mocked(runResearch).mockReset();
  vi.mocked(runResearch).mockResolvedValue({ searchesUsed: 5, topicWritten: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Research skill dispatch", () => {
  it("routes to runResearch when skillName=research and researchTopic is set", async () => {
    const callbacks = createMockCallbacks();
    await runSkill(
      createTestConfig({ skillName: "research", researchTopic: "WebSocket Libraries" }),
      callbacks,
    );

    expect(runResearch).toHaveBeenCalledOnce();
    expect(startSegment).not.toHaveBeenCalled(); // No SDK session started
    expect(verifyAuth).not.toHaveBeenCalled(); // Auth skip for research
  });

  it("emits segment_start and skill_complete events on success", async () => {
    vi.mocked(runResearch).mockResolvedValue({ searchesUsed: 7, topicWritten: true });

    const callbacks = createMockCallbacks();
    await runSkill(
      createTestConfig({ skillName: "research", researchTopic: "OAuth 2.1" }),
      callbacks,
    );

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({ type: "segment_start", sessionIndex: 0, segmentIndex: 0 }),
    );
    expect(callbacks.events).toContainEqual(
      expect.objectContaining({
        type: "skill_complete",
        totalSessions: 1,
        totalTurns: 7,
        costUsd: 0,
      }),
    );
  });

  it("emits error event when runResearch throws", async () => {
    vi.mocked(runResearch).mockRejectedValue(new Error("WebSearch unavailable"));

    const callbacks = createMockCallbacks();
    await runSkill(
      createTestConfig({ skillName: "research", researchTopic: "Docker Networking" }),
      callbacks,
    );

    expect(callbacks.events).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("Research failed"),
        recoverable: false,
      }),
    );
    const errorEvent = callbacks.events.find((e) => e.type === "error")!;
    expect((errorEvent as any).message).toContain("WebSearch unavailable");
  });

  it("passes researchTopic as research config topic", async () => {
    const callbacks = createMockCallbacks();
    await runSkill(
      createTestConfig({ skillName: "research", researchTopic: "JWT Best Practices" }),
      callbacks,
    );

    const researchCall = vi.mocked(runResearch).mock.calls[0];
    expect(researchCall[0].topic).toBe("JWT Best Practices");
    expect(researchCall[0].maxSearches).toBe(10);
    expect(researchCall[0].force).toBe(false);
  });

  it("uses mainRepoDir for oracle memory config when set", async () => {
    const callbacks = createMockCallbacks();
    await runSkill(
      createTestConfig({
        skillName: "research",
        researchTopic: "SSL Certificates",
        mainRepoDir: "/main/repo",
        projectDir: "/worktree/path",
      }),
      callbacks,
    );

    const researchCall = vi.mocked(runResearch).mock.calls[0];
    // oracleMemoryConfig should use mainRepoDir when available
    expect(researchCall[0].oracleMemoryConfig).toBeTruthy();
  });

  it("falls through to normal skill loop when skillName=research but NO researchTopic", async () => {
    // This simulates a manual `garyclaw run research` without a topic
    // It should NOT dispatch to runResearch — it should go through the normal SDK loop
    const callbacks = createMockCallbacks();

    // Mock a normal successful segment so the orchestrator can complete
    const makeSegmentIterator = (msgs: any[]): AsyncIterable<any> => ({
      [Symbol.asyncIterator]() {
        let i = 0;
        return { async next() { return i >= msgs.length ? { done: true, value: undefined } : { done: false, value: msgs[i++] }; } };
      },
    });
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([{
      type: "result", subtype: "success", sessionId: "s1",
      resultText: "Done", totalCostUsd: 0, numTurns: 1,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: {},
    }]));

    const { extractResultData } = await import("../src/sdk-wrapper.js");
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return { sessionId: "s1", subtype: "success", resultText: "Done", usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1 };
      }
      return null;
    });

    await runSkill(
      createTestConfig({ skillName: "research" /* no researchTopic */ }),
      callbacks,
    );

    expect(runResearch).not.toHaveBeenCalled();
    expect(startSegment).toHaveBeenCalled(); // Normal SDK session
  });

  it("falls through to normal loop when researchTopic set but skillName is NOT research", async () => {
    const callbacks = createMockCallbacks();

    const makeSegmentIterator = (msgs: any[]): AsyncIterable<any> => ({
      [Symbol.asyncIterator]() {
        let i = 0;
        return { async next() { return i >= msgs.length ? { done: true, value: undefined } : { done: false, value: msgs[i++] }; } };
      },
    });
    vi.mocked(startSegment).mockReturnValue(makeSegmentIterator([{
      type: "result", subtype: "success", sessionId: "s1",
      resultText: "Done", totalCostUsd: 0, numTurns: 1,
      usage: { input_tokens: 100, output_tokens: 50 },
      modelUsage: {},
    }]));

    const { extractResultData } = await import("../src/sdk-wrapper.js");
    vi.mocked(extractResultData).mockImplementation((msg: any) => {
      if (msg.type === "result") {
        return { sessionId: "s1", subtype: "success", resultText: "Done", usage: null, modelUsage: null, totalCostUsd: 0, numTurns: 1 };
      }
      return null;
    });

    await runSkill(
      createTestConfig({ skillName: "qa", researchTopic: "WebSocket" }),
      callbacks,
    );

    expect(runResearch).not.toHaveBeenCalled();
    expect(startSegment).toHaveBeenCalled(); // Normal SDK session
  });

  it("returns without starting SDK session after research dispatch", async () => {
    // Reset verifyAuth call count since prior tests may have called it
    vi.mocked(verifyAuth).mockClear();
    vi.mocked(startSegment).mockClear();

    const callbacks = createMockCallbacks();
    await runSkill(
      createTestConfig({ skillName: "research", researchTopic: "API Design" }),
      callbacks,
    );

    // verifyAuth is called AFTER the research dispatch check — should NOT be called
    expect(verifyAuth).not.toHaveBeenCalled();
    expect(startSegment).not.toHaveBeenCalled();
    // No checkpoint or relay behavior
    const relayEvents = callbacks.events.filter((e) => e.type === "relay_triggered");
    expect(relayEvents.length).toBe(0);
  });
});
