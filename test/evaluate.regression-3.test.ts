/**
 * Regression: ISSUE-003 — analyzePipelineHealth returns 0 duration when no skill has endTime
 * Found by /qa on 2026-03-28
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md
 *
 * When all skills in a pipeline lacked endTime (e.g., crashed mid-run),
 * analyzePipelineHealth silently returned totalDurationSec=0 instead of
 * falling back to the current time. This under-reported pipeline duration
 * in evaluation reports.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzePipelineHealth } from "../src/evaluate.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-eval-regression-3");

describe("analyzePipelineHealth duration fallback", () => {
  beforeEach(() => {
    mkdirSync(join(TMP, ".garyclaw"), { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns non-zero duration when startTime exists but no skill has endTime", () => {
    // Simulate a pipeline where skills crashed without recording endTime
    const state = {
      version: 1,
      pipelineId: "test-crash",
      skills: [
        { skillName: "bootstrap", status: "failed", startTime: "2026-03-28T10:00:00Z" },
        { skillName: "qa", status: "failed", startTime: "2026-03-28T10:02:00Z" },
      ],
      currentSkillIndex: 1,
      startTime: "2026-03-28T10:00:00Z",
      totalCostUsd: 0.5,
      autonomous: true,
    };
    writeFileSync(join(TMP, ".garyclaw", "pipeline.json"), JSON.stringify(state));

    const result = analyzePipelineHealth(TMP);
    // Should fall back to Date.now(), giving a non-zero duration
    expect(result.totalDurationSec).toBeGreaterThan(0);
  });

  it("still uses endTime when available (happy path unchanged)", () => {
    const state = {
      version: 1,
      pipelineId: "test-normal",
      skills: [
        { skillName: "qa", status: "complete", startTime: "2026-03-28T10:00:00Z", endTime: "2026-03-28T10:10:00Z" },
      ],
      currentSkillIndex: 0,
      startTime: "2026-03-28T10:00:00Z",
      totalCostUsd: 0.2,
      autonomous: true,
    };
    writeFileSync(join(TMP, ".garyclaw", "pipeline.json"), JSON.stringify(state));

    const result = analyzePipelineHealth(TMP);
    expect(result.totalDurationSec).toBe(600); // 10 minutes exactly
  });

  it("returns 0 duration when no startTime exists", () => {
    const state = {
      version: 1,
      pipelineId: "test-no-start",
      skills: [{ skillName: "qa", status: "complete" }],
      currentSkillIndex: 0,
      totalCostUsd: 0,
      autonomous: true,
    };
    writeFileSync(join(TMP, ".garyclaw", "pipeline.json"), JSON.stringify(state));

    const result = analyzePipelineHealth(TMP);
    expect(result.totalDurationSec).toBe(0);
  });
});
