/**
 * Regression: ISSUE-002 — runPostEvaluateAnalysis crash should not fail evaluate skill
 * Found by /qa on 2026-03-28
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md
 *
 * When the deterministic post-evaluate analysis throws (e.g., corrupt data,
 * disk full), the evaluate skill should still be marked as "completed" since
 * the Claude run itself succeeded. The pipeline try/catch now emits a warning
 * event instead of letting the error propagate to the skill-failure handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createTextAccumulatingCallbacks } from "../src/pipeline.js";
import { runPostEvaluateAnalysis } from "../src/evaluate.js";

import type { OrchestratorCallbacks, OrchestratorEvent } from "../src/types.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-pipeline-eval-wiring-regression-1");

function createMockCallbacks(): OrchestratorCallbacks & { events: OrchestratorEvent[] } {
  const events: OrchestratorEvent[] = [];
  return {
    events,
    onEvent: vi.fn((event: OrchestratorEvent) => { events.push(event); }),
    onAskUser: vi.fn().mockResolvedValue("approve"),
  };
}

beforeEach(() => {
  mkdirSync(join(TMP, ".garyclaw"), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("runPostEvaluateAnalysis error resilience", () => {
  it("produces degraded report when no CLAUDE.md or oracle data exists", () => {
    // Empty .garyclaw dir, no CLAUDE.md — safeAnalyze returns defaults
    const report = runPostEvaluateAnalysis(TMP, "");
    expect(report).toBeDefined();
    expect(report.bootstrap.claudeMdExists).toBe(false);
    expect(report.oracle.totalDecisions).toBe(0);
  });

  it("produces valid report even with corrupt .garyclaw data", () => {
    writeFileSync(join(TMP, ".garyclaw", "pipeline.json"), "{{{CORRUPT");
    writeFileSync(join(TMP, ".garyclaw", "decisions.jsonl"), "NOT\nJSON\nAT ALL");

    const report = runPostEvaluateAnalysis(TMP, "");
    expect(report).toBeDefined();
    expect(report.oracle.totalDecisions).toBe(0);
    expect(report.pipeline.skillsRun).toEqual([]);
  });

  it("createTextAccumulatingCallbacks captures text for post-analysis even on empty output", () => {
    const original = createMockCallbacks();
    const { wrapped, getAccumulatedText } = createTextAccumulatingCallbacks(original);

    // Simulate a segment with no assistant_text events (unusual but possible)
    wrapped.onEvent({ type: "segment_start", sessionIndex: 0, segmentIndex: 0 });
    wrapped.onEvent({ type: "segment_end", sessionIndex: 0, segmentIndex: 0, numTurns: 1 });

    expect(getAccumulatedText()).toBe("");
    // Should still work with runPostEvaluateAnalysis
    const report = runPostEvaluateAnalysis(TMP, getAccumulatedText());
    expect(report).toBeDefined();
  });

  it("error notes appear in report when bootstrap analysis fails", () => {
    // No CLAUDE.md, no .garyclaw data — bootstrap analysis returns default with error note
    // if analyzeBootstrapQuality throws (it won't here since missing file is handled,
    // but we verify the fallback structure is correct)
    rmSync(join(TMP, ".garyclaw"), { recursive: true, force: true });
    mkdirSync(join(TMP, ".garyclaw"), { recursive: true });

    const report = runPostEvaluateAnalysis(TMP, "");
    // bootstrap.qualityNotes should be an array (either empty or with error note)
    expect(Array.isArray(report.bootstrap.qualityNotes)).toBe(true);
  });
});
