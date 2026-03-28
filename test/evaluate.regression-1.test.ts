/**
 * Regression: ISSUE-001 — Missing interface properties in buildEvaluatePrompt error boundaries
 * Found by /qa on 2026-03-28
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md
 *
 * The error-boundary fallback objects in buildEvaluatePrompt were missing three
 * required properties (todosMdItemsAboveThreshold, researchTriggered, adaptiveTurnsUsed).
 * This caused `tsc --noEmit` failures even though vitest passed because tests
 * used synthetic data that bypassed the error boundaries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEvaluatePrompt } from "../src/evaluate.js";
import type { GaryClawConfig, PipelineSkillEntry, BootstrapEvaluation, OracleEvaluation, PipelineEvaluation } from "../src/types.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-eval-regression-1");

function makeConfig(projectDir: string): GaryClawConfig {
  return {
    skillName: "evaluate",
    projectDir,
    checkpointDir: join(projectDir, ".garyclaw"),
    maxTurnsPerSegment: 15,
    relayThresholdRatio: 0.85,
    maxRelaySessions: 10,
    autonomous: true,
    noMemory: false,
    noAdaptive: false,
  };
}

describe("buildEvaluatePrompt error boundary fallbacks", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    // Create minimal .garyclaw dir but with NO valid files inside,
    // so the analysis functions will throw or return minimal data
    mkdirSync(join(TMP, ".garyclaw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("produces a valid prompt even when .garyclaw has no data files", () => {
    const config = makeConfig(TMP);
    const prompt = buildEvaluatePrompt(config, [], TMP);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Instructions");
  });

  it("fallback bootstrap object satisfies BootstrapEvaluation interface", () => {
    // Force analyzeBootstrapQuality to use minimal data by providing empty project
    const config = makeConfig(TMP);
    const prompt = buildEvaluatePrompt(config, [], TMP);

    // The prompt should not crash and should mention bootstrap analysis
    expect(typeof prompt).toBe("string");
    // todosMdItemsAboveThreshold must be included (was the missing field)
    // We verify indirectly: if the interface was incomplete, tsc would fail
    // and the function would throw at runtime when accessing missing properties.
    expect(prompt).not.toContain("undefined");
  });

  it("fallback objects include all required fields when analysis functions throw", () => {
    // Create a corrupt decisions.jsonl to trigger error boundary
    writeFileSync(join(TMP, ".garyclaw", "decisions.jsonl"), "NOT VALID JSON\n{{{broken", "utf-8");

    const config = makeConfig(TMP);
    // Should not throw even with corrupt data
    const prompt = buildEvaluatePrompt(config, [], TMP);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("type-checks: BootstrapEvaluation requires todosMdItemsAboveThreshold", () => {
    // Compile-time type check: this object must satisfy the interface
    const bootstrap: BootstrapEvaluation = {
      claudeMdExists: false,
      claudeMdSizeTokens: 0,
      claudeMdHasSections: [],
      claudeMdMissingSections: [],
      todosMdExists: false,
      todosMdItemCount: 0,
      todosMdItemsAboveThreshold: 0,
      qualityScore: 0,
      qualityNotes: [],
    };
    expect(bootstrap.todosMdItemsAboveThreshold).toBe(0);
  });

  it("type-checks: OracleEvaluation requires researchTriggered", () => {
    const oracle: OracleEvaluation = {
      totalDecisions: 0,
      lowConfidenceCount: 0,
      escalatedCount: 0,
      averageConfidence: 0,
      topicClusters: [],
      researchTriggered: false,
    };
    expect(oracle.researchTriggered).toBe(false);
  });

  it("type-checks: PipelineEvaluation requires adaptiveTurnsUsed", () => {
    const pipeline: PipelineEvaluation = {
      skillsRun: [],
      skillsCompleted: [],
      skillsFailed: [],
      totalRelays: 0,
      totalCostUsd: 0,
      totalDurationSec: 0,
      contextGrowthRate: 0,
      adaptiveTurnsUsed: false,
    };
    expect(pipeline.adaptiveTurnsUsed).toBe(false);
  });
});
