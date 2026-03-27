/**
 * Regression: ISSUE-003 — Multi-session relay observation carry-forward
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 *
 * The existing orchestrator tests for codebase summary extraction used
 * conditional assertions (`if (checkpointArg.codebaseSummary)`) which
 * pass vacuously when the field is missing. This test file:
 * 1. Asserts unconditionally that observations appear in checkpoints
 * 2. Verifies session 2 checkpoint inherits session 1 observations
 * 3. Tests the buildCodebaseSummary merge across a simulated relay cycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import type { GaryClawConfig, OrchestratorCallbacks, OrchestratorEvent, SegmentResult, CodebaseSummary } from "../src/types.js";

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

vi.mock("../src/reflection.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    runReflection: vi.fn().mockReturnValue({ outcomes: [], metrics: { totalDecisions: 0 }, reopenedCount: 0 }),
  };
});

vi.mock("../src/oracle-memory.js", () => ({
  defaultMemoryConfig: vi.fn().mockReturnValue({ globalDir: "/tmp/global", projectDir: "/tmp/project" }),
  readOracleMemory: vi.fn().mockReturnValue({ taste: null, domainExpertise: null, decisionOutcomes: null, memoryMd: null }),
  isCircuitBreakerTripped: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/notifier.js", () => ({
  sendNotification: vi.fn(),
}));

import { startSegment, extractTurnUsage, extractResultData } from "../src/sdk-wrapper.js";
import { writeCheckpoint, readCheckpoint } from "../src/checkpoint.js";
import { runSkill } from "../src/orchestrator.js";

const TEST_DIR = join(tmpdir(), `garyclaw-cs-reg3-${Date.now()}`);

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

function makeResultMsg(subtype: string = "success"): any {
  return {
    type: "result",
    subtype,
    sessionId: "session-123",
    resultText: "Done",
    totalCostUsd: 0.05,
    numTurns: 5,
    usage: { input_tokens: 1000, output_tokens: 500 },
    modelUsage: { "claude-sonnet-4-5-20250929": { contextWindow: 1000000 } },
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

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── ISSUE-003a: Unconditional assertion that observations appear ──────

describe("ISSUE-003a: unconditional codebaseSummary assertions", () => {
  it("checkpoint MUST contain codebaseSummary when text has 2+ signal words", async () => {
    const observationText = "This project uses a convention where all modules follow kebab-case naming and the architecture is organized around zero-import types.";

    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([makeAssistantTextMsg(observationText), makeResultMsg("success")]),
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

    await runSkill(createTestConfig(), createMockCallbacks());

    const checkpointArg = vi.mocked(writeCheckpoint).mock.calls[0][0] as any;
    // Unconditional: codebaseSummary MUST exist
    expect(checkpointArg.codebaseSummary).toBeDefined();
    expect(checkpointArg.codebaseSummary.observations.length).toBeGreaterThan(0);
    expect(checkpointArg.codebaseSummary.lastSessionIndex).toBe(0);
  });

  it("checkpoint MUST contain failedApproaches when text has try+fail pattern", async () => {
    const failedText = "I tried using require() for the import but it failed because this is an ESM project with strict module boundaries.";

    vi.mocked(startSegment).mockReturnValue(
      makeSegmentIterator([makeAssistantTextMsg(failedText), makeResultMsg("success")]),
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

    await runSkill(createTestConfig(), createMockCallbacks());

    const checkpointArg = vi.mocked(writeCheckpoint).mock.calls[0][0] as any;
    // Unconditional: codebaseSummary MUST exist with failedApproaches
    expect(checkpointArg.codebaseSummary).toBeDefined();
    expect(checkpointArg.codebaseSummary.failedApproaches.length).toBeGreaterThan(0);
  });
});

// ── ISSUE-003b: Multi-session relay carry-forward ─────────────────────

describe("ISSUE-003b: observations carry through relay to session 2", () => {
  it("session 2 checkpoint inherits session 1 observations via readCheckpoint", async () => {
    const session1Observation = "This project uses a convention where all modules follow kebab-case naming and the architecture is organized around zero-import types.";

    let segmentCall = 0;
    vi.mocked(startSegment).mockImplementation(() => {
      segmentCall++;
      if (segmentCall === 1) {
        // Session 1: observation text → triggers relay via high context usage
        return makeSegmentIterator([
          makeAssistantTextMsg(session1Observation),
          makeResultMsg("max_turns"),
        ]);
      }
      // Session 2: plain text, completes successfully
      return makeSegmentIterator([
        makeAssistantTextMsg("Continuing the work now."),
        makeResultMsg("success"),
      ]);
    });

    let turnUsageCall = 0;
    vi.mocked(extractTurnUsage).mockImplementation((msg: any) => {
      if (msg.type === "assistant") {
        turnUsageCall++;
        if (turnUsageCall === 1) {
          // Session 1: high context usage to trigger relay
          return {
            input_tokens: 900000,
            output_tokens: 1000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          };
        }
        // Session 2: low context usage — no relay
        return {
          input_tokens: 10000,
          output_tokens: 500,
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

    // After session 1 writes a checkpoint, readCheckpoint returns it for session 2
    let checkpointWriteCount = 0;
    vi.mocked(writeCheckpoint).mockImplementation((cp: any) => {
      checkpointWriteCount++;
      if (checkpointWriteCount === 1) {
        // After first write (relay checkpoint), make readCheckpoint return it
        vi.mocked(readCheckpoint).mockReturnValue(cp);
      }
    });

    const callbacks = createMockCallbacks();
    await runSkill(createTestConfig(), callbacks);

    // Must have at least 2 checkpoint writes (relay + final)
    const allCheckpoints = vi.mocked(writeCheckpoint).mock.calls;
    expect(allCheckpoints.length).toBeGreaterThanOrEqual(2);

    // Session 1 checkpoint (relay): MUST have observations
    const relayCheckpoint = allCheckpoints[0][0] as any;
    expect(relayCheckpoint.codebaseSummary).toBeDefined();
    expect(relayCheckpoint.codebaseSummary.observations.length).toBeGreaterThan(0);
    expect(relayCheckpoint.codebaseSummary.lastSessionIndex).toBe(0);

    // Session 2 checkpoint (final): MUST inherit session 1 observations
    const finalCheckpoint = allCheckpoints[allCheckpoints.length - 1][0] as any;
    expect(finalCheckpoint.codebaseSummary).toBeDefined();
    expect(finalCheckpoint.codebaseSummary.observations.length).toBeGreaterThan(0);
    // lastSessionIndex should be 1 (session 2 = index 1)
    expect(finalCheckpoint.codebaseSummary.lastSessionIndex).toBe(1);

    // The session 1 observation text should still be present in session 2's observations
    const session2Obs = finalCheckpoint.codebaseSummary.observations;
    const hasSession1Content = session2Obs.some((obs: string) =>
      obs.includes("convention") || obs.includes("kebab-case"),
    );
    expect(hasSession1Content).toBe(true);
  });
});

// ── ISSUE-003c: buildCodebaseSummary merge across relay cycle ─────────

describe("ISSUE-003c: buildCodebaseSummary relay cycle simulation", () => {
  // This is a pure unit test of the merge function, simulating what
  // happens at a relay boundary: session 0 observations → buildCodebaseSummary
  // → session 1 gets that as `current` → builds again with new observations.

  // We import directly since this is a pure function test.
  it("session 1 summary preserves session 0 observations and adds new ones", async () => {
    const { buildCodebaseSummary } = await import("../src/codebase-summary.js");

    // Session 0: extracted these observations
    const session0Obs = ["This project uses a naming convention where all files are kebab-case"];
    const session0Failed = ["I tried using require() but it failed in ESM mode due to module restrictions"];
    const session0Summary = buildCodebaseSummary(undefined, session0Obs, session0Failed, 0);

    expect(session0Summary.observations).toHaveLength(1);
    expect(session0Summary.failedApproaches).toHaveLength(1);
    expect(session0Summary.lastSessionIndex).toBe(0);

    // Session 1: new observations + previous summary carried forward
    const session1Obs = ["The architecture is organized around zero-import types in types.ts for decoupling"];
    const session1Failed: string[] = [];
    const session1Summary = buildCodebaseSummary(session0Summary, session1Obs, session1Failed, 1);

    // Session 1 summary must contain BOTH session 0 and session 1 observations
    expect(session1Summary.observations).toHaveLength(2);
    expect(session1Summary.observations[0]).toContain("kebab-case");
    expect(session1Summary.observations[1]).toContain("zero-import types");

    // Session 0 failed approaches must carry forward
    expect(session1Summary.failedApproaches).toHaveLength(1);
    expect(session1Summary.failedApproaches[0]).toContain("require()");

    expect(session1Summary.lastSessionIndex).toBe(1);
  });

  it("deduplicates near-identical observations across relay boundary", async () => {
    const { buildCodebaseSummary } = await import("../src/codebase-summary.js");

    const session0Summary = buildCodebaseSummary(
      undefined,
      ["This project uses kebab-case for all file names in the codebase"],
      [],
      0,
    );

    // Session 1 extracts a near-duplicate (slightly different wording)
    const session1Summary = buildCodebaseSummary(
      session0Summary,
      ["This project uses kebab-case for all file-names in the codebase"],
      [],
      1,
    );

    // Should deduplicate to just 1 observation
    expect(session1Summary.observations).toHaveLength(1);
    expect(session1Summary.lastSessionIndex).toBe(1);
  });

  it("three-session accumulation: each session adds unique observations", async () => {
    const { buildCodebaseSummary } = await import("../src/codebase-summary.js");

    const s0 = buildCodebaseSummary(undefined, ["Convention: kebab-case files throughout the project codebase"], [], 0);
    const s1 = buildCodebaseSummary(s0, ["Architecture pattern: zero-import types.ts decouples all modules"], [], 1);
    const s2 = buildCodebaseSummary(s1, ["Structure: test files mirror src directory naming layout exactly"], [], 2);

    expect(s2.observations).toHaveLength(3);
    expect(s2.observations[0]).toContain("kebab-case");
    expect(s2.observations[1]).toContain("zero-import");
    expect(s2.observations[2]).toContain("test files mirror");
    expect(s2.lastSessionIndex).toBe(2);
  });
});
