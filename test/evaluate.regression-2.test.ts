/**
 * Regression: buildEvaluatePrompt file-write instruction
 * Originally found by /qa on 2026-03-28
 *
 * History: The prompt originally told Claude to write evaluation files.
 * After wiring the deterministic post-evaluate path (runPostEvaluateAnalysis),
 * those file-write instructions became dead weight — Claude spends tokens
 * writing files that get immediately overwritten. The prompt now explicitly
 * tells Claude NOT to write files, and delegates file I/O to the pipeline.
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

describe("buildEvaluatePrompt file-write delegation", () => {
  beforeEach(() => {
    mkdirSync(join(TMP, ".garyclaw"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("tells Claude NOT to write files (deterministic path handles it)", () => {
    const prompt = buildEvaluatePrompt(makeConfig(TMP), [], TMP);
    expect(prompt).toContain("Do NOT write any files");
  });

  it("still requires <improvements> XML output format", () => {
    const prompt = buildEvaluatePrompt(makeConfig(TMP), [], TMP);
    expect(prompt).toContain("<improvements>");
    expect(prompt).toContain("</improvements>");
  });

  it("does not instruct Claude to write report files directly", () => {
    const prompt = buildEvaluatePrompt(makeConfig(TMP), [], TMP);
    // Should NOT contain the old file-write instructions
    expect(prompt).not.toContain("After outputting improvements, write the full evaluation report to:");
  });
});
