/**
 * Regression: ISSUE-001 — buildEvaluatePrompt missing improvement-candidates.md instruction
 * Found by /qa on 2026-03-28
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md
 *
 * The evaluate prompt instructed Claude to write evaluation-report.json and
 * evaluation-report.md, but never mentioned improvement-candidates.md. The
 * CLI post-pipeline hook (appendEvaluateCandidates) reads that file to append
 * improvements to GaryClaw's TODOS.md. Without the instruction, the self-improvement
 * loop was broken — Claude would never write the file the hook depends on.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildEvaluatePrompt } from "../src/evaluate.js";
import type { GaryClawConfig, PipelineSkillEntry } from "../src/types.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-eval-regression-2");

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

describe("buildEvaluatePrompt improvement-candidates.md instruction", () => {
  beforeEach(() => {
    mkdirSync(join(TMP, ".garyclaw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("includes improvement-candidates.md in the write instructions", () => {
    const prompt = buildEvaluatePrompt(makeConfig(TMP), [], TMP);
    expect(prompt).toContain("improvement-candidates.md");
  });

  it("mentions improvement-candidates.md alongside the other report files", () => {
    const prompt = buildEvaluatePrompt(makeConfig(TMP), [], TMP);
    // All three output files should be mentioned
    expect(prompt).toContain("evaluation-report.json");
    expect(prompt).toContain("evaluation-report.md");
    expect(prompt).toContain("improvement-candidates.md");
  });

  it("explains the purpose of improvement-candidates.md for the post-pipeline hook", () => {
    const prompt = buildEvaluatePrompt(makeConfig(TMP), [], TMP);
    // The instruction should explain what the file is for
    expect(prompt).toContain("TODOS.md");
  });
});
