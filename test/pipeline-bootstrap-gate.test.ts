/**
 * Tests for the bootstrap quality gate in pipeline.ts — verifies quality
 * checking after bootstrap dispatch, enrichment flow, retry cap,
 * event emission, fail-open on scoring error, and config flag opt-out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mock orchestrator
vi.mock("../src/orchestrator.js", () => ({
  runSkill: vi.fn().mockResolvedValue(undefined),
  runSkillWithInitialPrompt: vi.fn().mockResolvedValue(undefined),
}));

// Mock checkpoint reader
vi.mock("../src/checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/checkpoint.js")>();
  return {
    ...actual,
    readCheckpoint: vi.fn().mockReturnValue(null),
    generateRelayPrompt: vi.fn().mockReturnValue("QA findings summary"),
  };
});

// Mock report builder
vi.mock("../src/report.js", () => ({
  buildReport: vi.fn().mockReturnValue({
    runId: "test",
    skillName: "bootstrap",
    startTime: "",
    endTime: "",
    totalSessions: 0,
    totalTurns: 0,
    estimatedCostUsd: 0,
    issues: [],
    findings: [],
    decisions: [],
    relayPoints: [],
  }),
}));

// We need to control analyzeBootstrapQuality return value per test
vi.mock("../src/evaluate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/evaluate.js")>();
  return {
    ...actual,
    analyzeBootstrapQuality: vi.fn(),
    BOOTSTRAP_QUALITY_THRESHOLD: 50,
  };
});

import { runPipeline } from "../src/pipeline.js";
import { runSkillWithInitialPrompt } from "../src/orchestrator.js";
import { analyzeBootstrapQuality } from "../src/evaluate.js";
import type { GaryClawConfig, OrchestratorCallbacks, OrchestratorEvent } from "../src/types.js";

const mockRunSkill = vi.mocked(runSkillWithInitialPrompt);
const mockAnalyze = vi.mocked(analyzeBootstrapQuality);

const TEST_DIR = join(process.cwd(), ".test-pipeline-gate-tmp");

function createTestConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skillName: "bootstrap",
    projectDir: TEST_DIR,
    maxTurnsPerSegment: 15,
    relayThresholdRatio: 0.85,
    checkpointDir: join(TEST_DIR, ".garyclaw"),
    settingSources: [],
    env: {},
    askTimeoutMs: 5000,
    maxRelaySessions: 10,
    autonomous: true,
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

function highQualityEval() {
  return {
    claudeMdExists: true,
    claudeMdSizeTokens: 3000,
    claudeMdHasSections: ["Architecture", "Tech Stack", "Test Strategy", "Usage"],
    claudeMdMissingSections: [],
    todosMdExists: true,
    todosMdItemCount: 5,
    todosMdItemsAboveThreshold: 3,
    qualityScore: 75,
    qualityNotes: [],
  };
}

function lowQualityEval(score = 30) {
  return {
    claudeMdExists: true,
    claudeMdSizeTokens: 500,
    claudeMdHasSections: [],
    claudeMdMissingSections: ["Architecture", "Tech Stack", "Test Strategy", "Usage"],
    todosMdExists: false,
    todosMdItemCount: 0,
    todosMdItemsAboveThreshold: 0,
    qualityScore: score,
    qualityNotes: ["Missing all expected sections"],
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });
  writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");
  mockRunSkill.mockReset().mockResolvedValue(undefined);
  mockAnalyze.mockReset();
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("bootstrap quality gate", () => {
  it("emits bootstrap_quality_check event when gate is enabled", async () => {
    mockAnalyze.mockReturnValue(highQualityEval());

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    const qualityEvent = callbacks.events.find(
      (e) => (e as Record<string, unknown>).type === "bootstrap_quality_check",
    ) as Record<string, unknown> | undefined;
    expect(qualityEvent).toBeDefined();
    expect(qualityEvent!.qualityScore).toBe(75);
  });

  it("skips enrichment when score >= threshold", async () => {
    mockAnalyze.mockReturnValue(highQualityEval());

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    // Only one runSkillWithInitialPrompt call (the bootstrap itself)
    expect(mockRunSkill).toHaveBeenCalledTimes(1);

    // No enrichment-related assistant_text events
    const gateTexts = callbacks.events.filter(
      (e) => e.type === "assistant_text" && (e as { text: string }).text.includes("[Quality Gate]"),
    );
    expect(gateTexts).toHaveLength(0);
  });

  it("triggers enrichment when score < threshold", async () => {
    mockAnalyze
      .mockReturnValueOnce(lowQualityEval(30))
      .mockReturnValueOnce(highQualityEval());

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    // 3 calls: initial bootstrap + QA pre-scan + enriched re-bootstrap
    expect(mockRunSkill).toHaveBeenCalledTimes(3);

    // Verify QA pre-scan call
    const qaCall = mockRunSkill.mock.calls[1];
    expect(qaCall[0].skillName).toBe("qa");
    expect(qaCall[0].maxRelaySessions).toBe(1); // cost cap
    expect(qaCall[2]).toContain("pre-scan for bootstrap enrichment");

    // Verify re-bootstrap call
    const rebootstrapCall = mockRunSkill.mock.calls[2];
    expect(rebootstrapCall[0].skillName).toBe("bootstrap");
    expect(rebootstrapCall[2]).toContain("scored below the quality threshold");
  });

  it("emits bootstrap_quality_recheck after enrichment", async () => {
    mockAnalyze
      .mockReturnValueOnce(lowQualityEval(25))       // 1st: quality gate check
      .mockReturnValueOnce(lowQualityEval(25))        // 2nd: claim verification inside buildEnrichedBootstrapPrompt
      .mockReturnValueOnce({                          // 3rd: recheck after enrichment
        ...highQualityEval(),
        qualityScore: 72,
      });

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    const recheckEvent = callbacks.events.find(
      (e) => (e as Record<string, unknown>).type === "bootstrap_quality_recheck",
    ) as Record<string, unknown> | undefined;
    expect(recheckEvent).toBeDefined();
    expect(recheckEvent!.qualityScore).toBe(72);
    expect(recheckEvent!.previousScore).toBe(25);
  });

  it("does not enrich a second time (retry cap via bootstrapEnriched)", async () => {
    // Both calls return low quality — but second should NOT trigger another enrichment
    mockAnalyze.mockReturnValue(lowQualityEval(25));

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    // Exactly 3 calls: initial bootstrap + QA pre-scan + enriched re-bootstrap
    // (NOT 5 — no second round of enrichment)
    expect(mockRunSkill).toHaveBeenCalledTimes(3);
  });

  it("skips gate when config.bootstrapQualityGate === false", async () => {
    mockAnalyze.mockReturnValue(lowQualityEval(10));

    const config = createTestConfig({ bootstrapQualityGate: false });
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    // Only initial bootstrap — no quality gate
    expect(mockRunSkill).toHaveBeenCalledTimes(1);
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("fail-open: continues pipeline if analyzeBootstrapQuality throws", async () => {
    mockAnalyze.mockImplementation(() => {
      throw new Error("corrupt CLAUDE.md");
    });

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    // Should NOT throw — fail-open
    await runPipeline(["bootstrap"], config, callbacks);

    // Only initial bootstrap call
    expect(mockRunSkill).toHaveBeenCalledTimes(1);

    // Should emit a warning
    const warningEvent = callbacks.events.find(
      (e) => e.type === "assistant_text" && (e as { text: string }).text.includes("[Quality Gate] Scoring failed"),
    );
    expect(warningEvent).toBeDefined();
  });

  it("enrichment works in a multi-skill pipeline (bootstrap → prioritize)", async () => {
    mockAnalyze
      .mockReturnValueOnce(lowQualityEval(30))
      .mockReturnValueOnce(highQualityEval());

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap", "prioritize"], config, callbacks);

    // 4 calls: bootstrap + QA pre-scan + enriched re-bootstrap + prioritize
    expect(mockRunSkill).toHaveBeenCalledTimes(4);

    // Last call should be prioritize
    const lastCall = mockRunSkill.mock.calls[3];
    expect(lastCall[0].skillName).toBe("prioritize");
  });

  it("quality gate assistant_text includes score and threshold", async () => {
    mockAnalyze
      .mockReturnValueOnce(lowQualityEval(35))
      .mockReturnValueOnce(highQualityEval());

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    const gateText = callbacks.events.find(
      (e) => e.type === "assistant_text" && (e as { text: string }).text.includes("[Quality Gate] Bootstrap scored"),
    ) as { text: string } | undefined;
    expect(gateText).toBeDefined();
    expect(gateText!.text).toContain("35/100");
    expect(gateText!.text).toContain("threshold: 50");
  });

  it("QA pre-scan checkpoint dir uses skill-enrichment-qa path", async () => {
    mockAnalyze
      .mockReturnValueOnce(lowQualityEval(20))
      .mockReturnValueOnce(highQualityEval());

    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    // QA pre-scan should use skill-enrichment-qa checkpoint dir
    const qaCall = mockRunSkill.mock.calls[1];
    expect(qaCall[0].checkpointDir).toContain("skill-enrichment-qa");

    // Re-bootstrap should use skill-enrichment-bootstrap checkpoint dir
    const rebootstrapCall = mockRunSkill.mock.calls[2];
    expect(rebootstrapCall[0].checkpointDir).toContain("skill-enrichment-bootstrap");
  });

  it("gate runs by default when bootstrapQualityGate is undefined", async () => {
    mockAnalyze.mockReturnValue(highQualityEval());

    // No bootstrapQualityGate set — should default to enabled
    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    expect(mockAnalyze).toHaveBeenCalledOnce();
  });

  it("bootstrap_quality_check event includes missingSections and notes", async () => {
    mockAnalyze.mockReturnValue({
      ...lowQualityEval(45),
      claudeMdMissingSections: ["Test Strategy", "Usage"],
      qualityNotes: ["Missing test strategy section"],
    });

    // Set bootstrapEnriched to prevent enrichment (we only care about the event here)
    const config = createTestConfig();
    const callbacks = createMockCallbacks();

    await runPipeline(["bootstrap"], config, callbacks);

    const qualityEvent = callbacks.events.find(
      (e) => (e as Record<string, unknown>).type === "bootstrap_quality_check",
    ) as Record<string, unknown> | undefined;
    expect(qualityEvent).toBeDefined();
    expect(qualityEvent!.missingSections).toEqual(["Test Strategy", "Usage"]);
    expect(qualityEvent!.notes).toEqual(["Missing test strategy section"]);
  });
});
