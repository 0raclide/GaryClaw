/**
 * Orchestrator segment retry tests — transient error recovery.
 *
 * Verifies that transient SDK/infra errors trigger a single retry with delay,
 * while non-transient errors propagate immediately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GaryClawConfig, OrchestratorCallbacks, OrchestratorEvent, SegmentResult } from "../src/types.js";
import { PerJobCostExceededError } from "../src/types.js";

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
  askOracleBatch: vi.fn(),
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

import { startSegment, extractTurnUsage, extractResultData, verifyAuth } from "../src/sdk-wrapper.js";
import { runSkill, MAX_SEGMENT_RETRIES, SEGMENT_RETRY_DELAY_MS } from "../src/orchestrator.js";

const TEST_DIR = join(tmpdir(), `garyclaw-retry-test-${Date.now()}`);

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

function createCallbacks(): OrchestratorCallbacks & { events: OrchestratorEvent[] } {
  const events: OrchestratorEvent[] = [];
  return {
    events,
    onEvent: (event: OrchestratorEvent) => { events.push(event); },
    onAskUser: vi.fn().mockResolvedValue("Yes"),
  };
}

/** Create a mock async iterable that yields messages then returns a result. */
function createSuccessSegment(result: Partial<SegmentResult> = {}): AsyncIterable<any> {
  const fullResult: SegmentResult = {
    sessionId: "sess-1",
    subtype: "success",
    resultText: "Done",
    usage: null,
    modelUsage: null,
    totalCostUsd: 0.01,
    numTurns: 3,
    ...result,
  };

  // extractResultData needs to return this result
  (extractResultData as any).mockReturnValueOnce(fullResult);

  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "result" };
    },
  };
}

/** Create a mock async iterable that throws on iteration. */
function createThrowingSegment(error: Error): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      throw error;
    },
  };
}

describe("Orchestrator Segment Retry", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    vi.clearAllMocks();
    // Use fake timers to avoid actual 30s delay
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Constants exported ───────────────────────────────────────────

  it("exports MAX_SEGMENT_RETRIES constant", () => {
    expect(MAX_SEGMENT_RETRIES).toBe(1);
  });

  it("exports SEGMENT_RETRY_DELAY_MS constant", () => {
    expect(SEGMENT_RETRY_DELAY_MS).toBe(30_000);
  });

  // ── Transient error retries ──────────────────────────────────────

  it("retries once on transient sdk-bug error then succeeds", async () => {
    const config = createTestConfig();
    const cbs = createCallbacks();

    // SDK error with stack trace in @anthropic-ai → classified as sdk-bug
    const sdkError = new Error("stream error");
    sdkError.stack = `Error: stream error\n    at node_modules/@anthropic-ai/claude-agent-sdk/dist/index.js:42:10`;

    // First call throws, second succeeds
    const mockStartSegment = startSegment as any;
    mockStartSegment
      .mockReturnValueOnce(createThrowingSegment(sdkError))
      .mockReturnValueOnce(createSuccessSegment());

    const promise = runSkill(config, cbs);
    // Advance past the 30s retry delay
    await vi.advanceTimersByTimeAsync(SEGMENT_RETRY_DELAY_MS + 100);
    await promise;

    // Should have a segment_retry event
    const retryEvents = cbs.events.filter(e => e.type === "segment_retry");
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]).toMatchObject({
      type: "segment_retry",
      attempt: 1,
      maxRetries: MAX_SEGMENT_RETRIES,
      error: "stream error",
      delayMs: SEGMENT_RETRY_DELAY_MS,
    });

    // Should have a skill_complete event (succeeded on retry)
    const completeEvents = cbs.events.filter(e => e.type === "skill_complete");
    expect(completeEvents).toHaveLength(1);
  });

  it("retries once on transient infra-issue error (ECONNRESET)", async () => {
    const config = createTestConfig();
    const cbs = createCallbacks();

    const infraError = new Error("ECONNRESET");

    const mockStartSegment = startSegment as any;
    mockStartSegment
      .mockReturnValueOnce(createThrowingSegment(infraError))
      .mockReturnValueOnce(createSuccessSegment());

    const promise = runSkill(config, cbs);
    await vi.advanceTimersByTimeAsync(SEGMENT_RETRY_DELAY_MS + 100);
    await promise;

    const retryEvents = cbs.events.filter(e => e.type === "segment_retry");
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]).toMatchObject({
      error: "ECONNRESET",
    });
  });

  // ── Non-transient error propagation ──────────────────────────────

  it("propagates non-transient error immediately without retry", async () => {
    const config = createTestConfig();
    const cbs = createCallbacks();

    // A generic error with no matching patterns → classified as "unknown", not retryable
    const unknownError = new Error("something unexpected happened");

    const mockStartSegment = startSegment as any;
    mockStartSegment.mockReturnValueOnce(createThrowingSegment(unknownError));

    await expect(runSkill(config, cbs)).rejects.toThrow("something unexpected happened");

    // No retry event should be emitted
    const retryEvents = cbs.events.filter(e => e.type === "segment_retry");
    expect(retryEvents).toHaveLength(0);
  });

  // ── PerJobCostExceededError never retried ────────────────────────

  it("never retries PerJobCostExceededError", async () => {
    const config = createTestConfig();
    const cbs = createCallbacks();

    const budgetError = new PerJobCostExceededError(5.0, 3.0);

    const mockStartSegment = startSegment as any;
    mockStartSegment.mockReturnValueOnce(createThrowingSegment(budgetError));

    await expect(runSkill(config, cbs)).rejects.toThrow("Per-job cost limit exceeded");

    const retryEvents = cbs.events.filter(e => e.type === "segment_retry");
    expect(retryEvents).toHaveLength(0);
  });

  // ── Retry exhaustion ─────────────────────────────────────────────

  it("propagates after exhausting retries", async () => {
    const config = createTestConfig();
    const cbs = createCallbacks();

    const sdkError = new Error("protocol error");

    const mockStartSegment = startSegment as any;
    // Both calls throw (first attempt + one retry)
    mockStartSegment
      .mockReturnValueOnce(createThrowingSegment(sdkError))
      .mockReturnValueOnce(createThrowingSegment(sdkError));

    // Catch rejection immediately to prevent unhandled rejection warnings
    const promise = runSkill(config, cbs).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(SEGMENT_RETRY_DELAY_MS + 100);
    const error = await promise;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("protocol error");

    // Should have exactly one retry event (retry once, then propagate)
    const retryEvents = cbs.events.filter(e => e.type === "segment_retry");
    expect(retryEvents).toHaveLength(1);
  });

  // ── Resume session on retry ──────────────────────────────────────

  it("preserves sessionId for resume on retry", async () => {
    const config = createTestConfig();
    const cbs = createCallbacks();

    // Simulate: first segment succeeds (sets sessionId), then max_turns,
    // then second segment throws transient, retry succeeds.
    // We need the orchestrator to have a sessionId set before the retry.

    // For simplicity: first segment returns max_turns (setting sessionId),
    // second segment throws and retries.
    const maxTurnsResult: SegmentResult = {
      sessionId: "sess-42",
      subtype: "max_turns",
      resultText: "",
      usage: null,
      modelUsage: null,
      totalCostUsd: 0.01,
      numTurns: 15,
    };

    const sdkError = new Error("stream error");
    sdkError.stack = `Error: stream error\n    at node_modules/@anthropic-ai/claude-agent-sdk/dist/index.js:42:10`;

    const mockStartSegment = startSegment as any;
    const mockExtractResult = extractResultData as any;

    // Segment 0: max_turns (sets sessionId)
    mockExtractResult.mockReturnValueOnce(maxTurnsResult);
    mockStartSegment.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() { yield { type: "result" }; },
    });

    // Segment 1: throws transient error
    mockStartSegment.mockReturnValueOnce(createThrowingSegment(sdkError));

    // Segment 1 retry: succeeds
    mockStartSegment.mockReturnValueOnce(createSuccessSegment());

    const promise = runSkill(config, cbs);
    await vi.advanceTimersByTimeAsync(SEGMENT_RETRY_DELAY_MS + 100);
    await promise;

    // The third startSegment call (retry of segment 1) should have resume: "sess-42"
    const thirdCall = mockStartSegment.mock.calls[2];
    expect(thirdCall[0]).toHaveProperty("resume", "sess-42");
  });

  // ── Retry delay ──────────────────────────────────────────────────

  it("applies 30s delay between attempts", async () => {
    const config = createTestConfig();
    const cbs = createCallbacks();

    const sdkError = new Error("ECONNRESET");

    const mockStartSegment = startSegment as any;
    mockStartSegment
      .mockReturnValueOnce(createThrowingSegment(sdkError))
      .mockReturnValueOnce(createSuccessSegment());

    const promise = runSkill(config, cbs);

    // Before timer: second startSegment should NOT have been called yet
    await vi.advanceTimersByTimeAsync(100);
    // First call is the failing one
    expect(mockStartSegment).toHaveBeenCalledTimes(1);

    // After 30s: retry fires
    await vi.advanceTimersByTimeAsync(SEGMENT_RETRY_DELAY_MS);
    await promise;

    // Now both calls should have happened
    expect(mockStartSegment).toHaveBeenCalledTimes(2);
  });

  // ── Abort signal cancels retry ───────────────────────────────────

  it("abort signal cancels retry sleep", async () => {
    const controller = new AbortController();
    const config = createTestConfig({ abortSignal: controller.signal });
    const cbs = createCallbacks();

    const sdkError = new Error("ECONNRESET");

    const mockStartSegment = startSegment as any;
    mockStartSegment.mockReturnValueOnce(createThrowingSegment(sdkError));

    // Catch rejection immediately to prevent unhandled rejection warnings
    const promise = runSkill(config, cbs).catch((e: Error) => e);

    // Abort during the sleep
    await vi.advanceTimersByTimeAsync(5000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);

    // Should throw the original error after abort
    const error = await promise;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("ECONNRESET");

    // Only one startSegment call (no retry after abort)
    expect(mockStartSegment).toHaveBeenCalledTimes(1);
  });
});
