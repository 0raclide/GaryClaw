/**
 * Pipeline evaluate wiring tests — verifies the text accumulation callback
 * wrapper and the runPostEvaluateAnalysis deterministic pipeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTextAccumulatingCallbacks } from "../src/pipeline.js";
import {
  runPostEvaluateAnalysis,
  defaultBootstrapEvaluation,
  defaultOracleEvaluation,
  defaultPipelineEvaluation,
  EXPECTED_SECTIONS,
} from "../src/evaluate.js";

import type { OrchestratorCallbacks, OrchestratorEvent } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-evaluate-wiring-tmp");

function createMockCallbacks(): OrchestratorCallbacks & { events: OrchestratorEvent[] } {
  const events: OrchestratorEvent[] = [];
  return {
    events,
    onEvent: vi.fn((event: OrchestratorEvent) => { events.push(event); }),
    onAskUser: vi.fn().mockResolvedValue("approve"),
  };
}

beforeEach(() => {
  mkdirSync(join(TEST_DIR, ".garyclaw"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── createTextAccumulatingCallbacks ──────────────────────────────

describe("createTextAccumulatingCallbacks", () => {
  it("forwards all events to original callbacks", () => {
    const original = createMockCallbacks();
    const { wrapped } = createTextAccumulatingCallbacks(original);

    const events: OrchestratorEvent[] = [
      { type: "segment_start", sessionIndex: 0, segmentIndex: 0 },
      { type: "tool_use", toolName: "Read", inputSummary: "file.ts" },
      { type: "assistant_text", text: "hello" },
      { type: "segment_end", sessionIndex: 0, segmentIndex: 0, numTurns: 5 },
    ];

    for (const event of events) {
      wrapped.onEvent(event);
    }

    expect(original.onEvent).toHaveBeenCalledTimes(4);
    expect(original.events).toHaveLength(4);
    expect(original.events[0].type).toBe("segment_start");
    expect(original.events[2].type).toBe("assistant_text");
  });

  it("accumulates assistant_text events", () => {
    const original = createMockCallbacks();
    const { wrapped, getAccumulatedText } = createTextAccumulatingCallbacks(original);

    wrapped.onEvent({ type: "assistant_text", text: "Hello " });
    wrapped.onEvent({ type: "assistant_text", text: "world" });
    wrapped.onEvent({ type: "assistant_text", text: "!" });

    expect(getAccumulatedText()).toBe("Hello world!");
  });

  it("handles non-text events without accumulation", () => {
    const original = createMockCallbacks();
    const { wrapped, getAccumulatedText } = createTextAccumulatingCallbacks(original);

    wrapped.onEvent({ type: "segment_start", sessionIndex: 0, segmentIndex: 0 });
    wrapped.onEvent({ type: "tool_use", toolName: "Edit", inputSummary: "patch" });
    wrapped.onEvent({ type: "tool_result", toolName: "Edit" });
    wrapped.onEvent({ type: "cost_update", costUsd: 0.5, sessionIndex: 0 });

    expect(getAccumulatedText()).toBe("");
    expect(original.onEvent).toHaveBeenCalledTimes(4);
  });

  it("preserves onAskUser from original callbacks", async () => {
    const original = createMockCallbacks();
    const { wrapped } = createTextAccumulatingCallbacks(original);

    const result = await wrapped.onAskUser("question?", [{ label: "Yes", description: "" }], false);
    expect(result).toBe("approve");
    expect(original.onAskUser).toHaveBeenCalledOnce();
  });

  it("returns empty string when no text events emitted", () => {
    const original = createMockCallbacks();
    const { getAccumulatedText } = createTextAccumulatingCallbacks(original);

    expect(getAccumulatedText()).toBe("");
  });
});

// ── runPostEvaluateAnalysis ──────────────────────────────────────

describe("runPostEvaluateAnalysis", () => {
  it("produces report with obvious improvements from metrics", () => {
    // Create a CLAUDE.md with missing sections to trigger obvious improvements
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\n\nSome content, no proper sections.");

    const report = runPostEvaluateAnalysis(TEST_DIR, "");

    expect(report.targetRepo).toBe(TEST_DIR);
    expect(report.bootstrap).toBeDefined();
    expect(report.oracle).toBeDefined();
    expect(report.pipeline).toBeDefined();
    expect(report.timestamp).toBeDefined();
    // Should have obvious improvement for missing sections
    expect(report.improvements.length).toBeGreaterThan(0);
    expect(report.improvements.some((i) => i.category === "bootstrap")).toBe(true);
  });

  it("parses Claude <improvements> and merges them", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\n## Architecture\nStuff\n## Tech Stack\nNode\n## Test Strategy\nVitest\n## Usage\nnpx test");

    const claudeOutput = `Here's what I found:
<improvements>
[
  {
    "title": "Add retry logic for flaky tests",
    "priority": "P3",
    "effort": "S",
    "category": "pipeline",
    "description": "Some tests are flaky due to timing issues",
    "evidence": "3 test failures in the last 10 runs"
  }
]
</improvements>`;

    const report = runPostEvaluateAnalysis(TEST_DIR, claudeOutput);

    // Should include Claude's improvement
    const claudeImprovement = report.improvements.find(
      (i) => i.title === "Add retry logic for flaky tests",
    );
    expect(claudeImprovement).toBeDefined();
    expect(claudeImprovement!.category).toBe("pipeline");
  });

  it("deduplicates obvious + Claude improvements", () => {
    // Create CLAUDE.md missing only Architecture — so the obvious improvement
    // title is "Bootstrap missing Architecture detection"
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\n## Tech Stack\nNode\n## Test Strategy\nVitest\n## Usage\nnpx");

    // Claude outputs an improvement with a nearly identical title
    const claudeOutput = `<improvements>
[
  {
    "title": "Bootstrap missing Architecture detection",
    "priority": "P2",
    "effort": "XS",
    "category": "bootstrap",
    "description": "Same issue but from Claude's perspective with more detail",
    "evidence": "Very detailed evidence from Claude about the missing Architecture section and why it matters for the project"
  }
]
</improvements>`;

    const report = runPostEvaluateAnalysis(TEST_DIR, claudeOutput);

    // Should deduplicate — only one "missing sections" type improvement
    const bootstrapImprovements = report.improvements.filter(
      (i) => i.category === "bootstrap" && i.title.includes("missing"),
    );
    // Dedup should keep one version (the one with longer evidence)
    expect(bootstrapImprovements.length).toBe(1);
  });

  it("handles empty Claude output (only obvious improvements)", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\nNo proper sections.");

    const report = runPostEvaluateAnalysis(TEST_DIR, "");

    expect(report.improvements.length).toBeGreaterThan(0);
    // All improvements should be from obvious extraction (no Claude ones)
    expect(report.improvements.every((i) => i.category === "bootstrap")).toBe(true);
  });

  it("handles corrupt .garyclaw data gracefully", () => {
    // Write corrupt pipeline.json
    writeFileSync(join(TEST_DIR, ".garyclaw", "pipeline.json"), "NOT JSON{{{");
    // Write corrupt decisions.jsonl
    writeFileSync(join(TEST_DIR, ".garyclaw", "decisions.jsonl"), "NOT JSON\nALSO NOT");
    // No CLAUDE.md at all

    const report = runPostEvaluateAnalysis(TEST_DIR, "");

    expect(report).toBeDefined();
    expect(report.bootstrap.claudeMdExists).toBe(false);
    expect(report.oracle.totalDecisions).toBe(0);
    expect(report.pipeline.skillsRun).toEqual([]);
  });

  it("writes all three output files", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\n## Architecture\nStuff");

    runPostEvaluateAnalysis(TEST_DIR, "");

    expect(existsSync(join(TEST_DIR, ".garyclaw", "evaluation-report.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, ".garyclaw", "evaluation-report.md"))).toBe(true);

    // evaluation-report.json should be valid JSON
    const jsonContent = readFileSync(join(TEST_DIR, ".garyclaw", "evaluation-report.json"), "utf-8");
    const parsed = JSON.parse(jsonContent);
    expect(parsed.targetRepo).toBe(TEST_DIR);
  });

  it("writes improvement-candidates.md when improvements exist", () => {
    // Missing sections triggers obvious improvements
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\nNo sections.");

    const report = runPostEvaluateAnalysis(TEST_DIR, "");

    expect(report.improvements.length).toBeGreaterThan(0);
    expect(existsSync(join(TEST_DIR, ".garyclaw", "improvement-candidates.md"))).toBe(true);
    const content = readFileSync(join(TEST_DIR, ".garyclaw", "improvement-candidates.md"), "utf-8");
    expect(content).toContain("## P");
  });

  it("handles multiple <improvements> blocks (uses last valid match)", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\n## Architecture\nA\n## Tech Stack\nB\n## Test Strategy\nC\n## Usage\nD");

    const claudeOutput = `First block:
<improvements>
[{"title": "First block improvement", "priority": "P3", "effort": "XS", "category": "skill", "description": "From first", "evidence": "First block"}]
</improvements>
Second block:
<improvements>
[{"title": "Second block improvement", "priority": "P3", "effort": "XS", "category": "skill", "description": "From second", "evidence": "Second block"}]
</improvements>`;

    const report = runPostEvaluateAnalysis(TEST_DIR, claudeOutput);

    // Last valid block should be used (last-valid-match strategy)
    const firstBlock = report.improvements.find((i) => i.title === "First block improvement");
    const secondBlock = report.improvements.find((i) => i.title === "Second block improvement");
    expect(firstBlock).toBeUndefined();
    expect(secondBlock).toBeDefined();
  });

  it("handles broken first block with valid second block (relay split)", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\n## Architecture\nA\n## Tech Stack\nB\n## Test Strategy\nC\n## Usage\nD");

    // Simulate relay boundary splitting the first block mid-JSON
    const claudeOutput = `First block (truncated by relay):
<improvements>
[{"title": "Truncated improvement", "priority": "P3", "effort": "XS", "category": "skill", "descri
</improvements>
Second block (complete after relay):
<improvements>
[{"title": "Valid improvement after relay", "priority": "P3", "effort": "XS", "category": "skill", "description": "Complete item", "evidence": "From post-relay segment"}]
</improvements>`;

    const report = runPostEvaluateAnalysis(TEST_DIR, claudeOutput);

    // Should skip the broken first block and use the valid second block
    const validImprovement = report.improvements.find((i) => i.title === "Valid improvement after relay");
    expect(validImprovement).toBeDefined();
    expect(validImprovement!.evidence).toBe("From post-relay segment");
  });
});

// ── Default evaluation helpers ──────────────────────────────────

describe("default evaluation helpers", () => {
  it("defaultBootstrapEvaluation matches expected shape", () => {
    const d = defaultBootstrapEvaluation();
    expect(d.claudeMdExists).toBe(false);
    expect(d.claudeMdSizeTokens).toBe(0);
    expect(d.claudeMdHasSections).toEqual([]);
    expect(d.claudeMdMissingSections).toEqual(EXPECTED_SECTIONS);
    expect(d.todosMdExists).toBe(false);
    expect(d.todosMdItemCount).toBe(0);
    expect(d.todosMdItemsAboveThreshold).toBe(0);
    expect(d.qualityScore).toBe(0);
    expect(d.qualityNotes).toEqual([]);
  });

  it("defaultOracleEvaluation matches expected shape", () => {
    const d = defaultOracleEvaluation();
    expect(d.totalDecisions).toBe(0);
    expect(d.lowConfidenceCount).toBe(0);
    expect(d.escalatedCount).toBe(0);
    expect(d.averageConfidence).toBe(0);
    expect(d.topicClusters).toEqual([]);
    expect(d.researchTriggered).toBe(false);
  });

  it("defaultPipelineEvaluation matches expected shape", () => {
    const d = defaultPipelineEvaluation();
    expect(d.skillsRun).toEqual([]);
    expect(d.skillsCompleted).toEqual([]);
    expect(d.skillsFailed).toEqual([]);
    expect(d.totalRelays).toBe(0);
    expect(d.totalCostUsd).toBe(0);
    expect(d.totalDurationSec).toBe(0);
    expect(d.contextGrowthRate).toBe(0);
    expect(d.adaptiveTurnsUsed).toBe(false);
  });

  it("default helpers return fresh objects (not shared references)", () => {
    const a = defaultBootstrapEvaluation();
    const b = defaultBootstrapEvaluation();
    a.qualityNotes.push("modified");
    expect(b.qualityNotes).toEqual([]);

    const c = defaultOracleEvaluation();
    const d = defaultOracleEvaluation();
    c.topicClusters.push({ topic: "test", count: 1, avgConfidence: 5 });
    expect(d.topicClusters).toEqual([]);
  });
});
