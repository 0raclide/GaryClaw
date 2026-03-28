/**
 * Regression: ISSUE-001 — stale improvement-candidates.md causes duplicate TODOs
 * Found by /qa on 2026-03-28
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md
 *
 * When runPostEvaluateAnalysis finds 0 improvements, it must DELETE any stale
 * improvement-candidates.md from a previous run. Otherwise the cli.ts hook
 * (appendEvaluateCandidates) re-appends the same improvements to TODOS.md
 * on every subsequent run, creating duplicates that compound over time.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runPostEvaluateAnalysis, writeEvaluationReport } from "../src/evaluate.js";
import type { EvaluationReport } from "../src/types.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-eval-regression-5");

beforeEach(() => {
  mkdirSync(join(TMP, ".garyclaw"), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("stale improvement-candidates.md deletion", () => {
  it("deletes stale improvement-candidates.md when 0 improvements found", () => {
    // Simulate a previous run that wrote the file
    const stalePath = join(TMP, ".garyclaw", "improvement-candidates.md");
    writeFileSync(stalePath, "## P3: Old stale improvement\nThis should be deleted.\n");
    expect(existsSync(stalePath)).toBe(true);

    // Create a CLAUDE.md with ALL expected sections so no obvious improvements trigger
    writeFileSync(
      join(TMP, "CLAUDE.md"),
      "# Project\n## Architecture\nA\n## Tech Stack\nB\n## Test Strategy\nC\n## Usage\nD\n",
    );

    // Run with empty Claude output — should produce 0 improvements
    const report = runPostEvaluateAnalysis(TMP, "");

    expect(report.improvements.length).toBe(0);
    // The stale file should be GONE
    expect(existsSync(stalePath)).toBe(false);
  });

  it("keeps improvement-candidates.md when improvements exist", () => {
    const candidatesPath = join(TMP, ".garyclaw", "improvement-candidates.md");

    // CLAUDE.md missing sections triggers obvious improvements
    writeFileSync(join(TMP, "CLAUDE.md"), "# Project\nNo proper sections.");

    const report = runPostEvaluateAnalysis(TMP, "");

    expect(report.improvements.length).toBeGreaterThan(0);
    expect(existsSync(candidatesPath)).toBe(true);
  });

  it("handles missing stale file gracefully (no ENOENT crash)", () => {
    // No stale file exists — deletion should not throw
    writeFileSync(
      join(TMP, "CLAUDE.md"),
      "# Project\n## Architecture\nA\n## Tech Stack\nB\n## Test Strategy\nC\n## Usage\nD\n",
    );

    expect(() => runPostEvaluateAnalysis(TMP, "")).not.toThrow();
  });

  it("writeEvaluationReport deletes stale file when improvements empty", () => {
    const stalePath = join(TMP, ".garyclaw", "improvement-candidates.md");
    writeFileSync(stalePath, "## P3: Stale\nOld content.\n");

    const report: EvaluationReport = {
      targetRepo: TMP,
      timestamp: new Date().toISOString(),
      bootstrap: {
        claudeMdExists: true,
        claudeMdSizeTokens: 100,
        claudeMdHasSections: ["Architecture"],
        claudeMdMissingSections: [],
        todosMdExists: false,
        todosMdItemCount: 0,
        todosMdItemsAboveThreshold: 0,
        qualityScore: 80,
        qualityNotes: [],
      },
      oracle: {
        totalDecisions: 0,
        lowConfidenceCount: 0,
        escalatedCount: 0,
        averageConfidence: 0,
        topicClusters: [],
        researchTriggered: false,
      },
      pipeline: {
        skillsRun: [],
        skillsCompleted: [],
        skillsFailed: [],
        totalRelays: 0,
        totalCostUsd: 0,
        totalDurationSec: 0,
        contextGrowthRate: 0,
        adaptiveTurnsUsed: false,
      },
      improvements: [], // zero improvements
    };

    writeEvaluationReport(TMP, report);

    expect(existsSync(stalePath)).toBe(false);
  });
});
