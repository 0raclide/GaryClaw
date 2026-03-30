import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  readPipelineOutcomes,
  appendPipelineOutcome,
  truncatePipelineOutcomes,
  MAX_PIPELINE_OUTCOMES,
  computeSkipRiskScores,
  shouldUseOracleComposition,
  computeFailureRates,
  computeCategoryStats,
  MIN_CATEGORY_SAMPLES,
  DEFAULT_DECAY_HALF_LIFE,
  MIN_SKIP_SAMPLES,
  CIRCUIT_BREAKER_MARGIN,
  DEFAULT_CIRCUIT_BREAKER_MIN_SAMPLES,
  DEFAULT_SKIP_RISK_THRESHOLD,
} from "../src/pipeline-history.js";
import type { PipelineOutcomeRecord } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────

const TMP_DIR = join(__dirname, ".tmp-pipeline-history");

function makeRecord(overrides: Partial<PipelineOutcomeRecord> = {}): PipelineOutcomeRecord {
  return {
    jobId: "job-1",
    timestamp: "2026-03-29T00:00:00Z",
    todoTitle: "Test Item",
    effort: "S",
    priority: 3,
    skills: ["implement", "qa"],
    skippedSkills: [],
    qaFailureCount: 0,
    reopenedCount: 0,
    outcome: "success",
    oracleAdjusted: false,
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ── I/O: readPipelineOutcomes ────────────────────────────────────

describe("readPipelineOutcomes", () => {
  it("returns empty array for missing file", () => {
    expect(readPipelineOutcomes(join(TMP_DIR, "nonexistent.jsonl"))).toEqual([]);
  });

  it("reads valid JSONL records", () => {
    const path = join(TMP_DIR, "outcomes.jsonl");
    const r1 = makeRecord({ jobId: "j1" });
    const r2 = makeRecord({ jobId: "j2", outcome: "failure" });
    writeFileSync(path, JSON.stringify(r1) + "\n" + JSON.stringify(r2) + "\n");

    const result = readPipelineOutcomes(path);
    expect(result).toHaveLength(2);
    expect(result[0].jobId).toBe("j1");
    expect(result[1].jobId).toBe("j2");
    expect(result[1].outcome).toBe("failure");
  });

  it("skips malformed lines", () => {
    const path = join(TMP_DIR, "outcomes.jsonl");
    const r1 = makeRecord({ jobId: "j1" });
    writeFileSync(path, JSON.stringify(r1) + "\n" + "not json\n" + "{}}\n");

    const result = readPipelineOutcomes(path);
    expect(result).toHaveLength(1);
    expect(result[0].jobId).toBe("j1");
  });

  it("skips records missing required fields", () => {
    const path = join(TMP_DIR, "outcomes.jsonl");
    writeFileSync(path, '{"jobId":"j1","outcome":"success"}\n{"foo":"bar"}\n');

    const result = readPipelineOutcomes(path);
    expect(result).toHaveLength(1);
  });

  it("handles empty file", () => {
    const path = join(TMP_DIR, "outcomes.jsonl");
    writeFileSync(path, "");
    expect(readPipelineOutcomes(path)).toEqual([]);
  });

  it("handles file with only whitespace/newlines", () => {
    const path = join(TMP_DIR, "outcomes.jsonl");
    writeFileSync(path, "\n\n  \n");
    expect(readPipelineOutcomes(path)).toEqual([]);
  });
});

// ── I/O: appendPipelineOutcome ───────────────────────────────────

describe("appendPipelineOutcome", () => {
  it("creates file and appends record", () => {
    const path = join(TMP_DIR, "sub", "outcomes.jsonl");
    const record = makeRecord({ jobId: "j1" });
    appendPipelineOutcome(path, record);

    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.jobId).toBe("j1");
  });

  it("appends to existing file", () => {
    const path = join(TMP_DIR, "outcomes.jsonl");
    appendPipelineOutcome(path, makeRecord({ jobId: "j1" }));
    appendPipelineOutcome(path, makeRecord({ jobId: "j2" }));

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("does not throw on write failure", () => {
    // Path that can't be created (file as parent)
    const path = join(TMP_DIR, "outcomes.jsonl");
    writeFileSync(path, "");
    // Try to write inside the file-as-directory — should not throw
    expect(() => appendPipelineOutcome(join(path, "sub", "out.jsonl"), makeRecord())).not.toThrow();
  });

  it("truncates to MAX_PIPELINE_OUTCOMES when file exceeds cap", () => {
    const path = join(TMP_DIR, "outcomes-trunc.jsonl");
    // Write MAX_PIPELINE_OUTCOMES + 5 records
    const totalRecords = MAX_PIPELINE_OUTCOMES + 5;
    const lines: string[] = [];
    for (let i = 0; i < totalRecords - 1; i++) {
      lines.push(JSON.stringify(makeRecord({ jobId: `j-${i}` })));
    }
    writeFileSync(path, lines.join("\n") + "\n");

    // Append one more — triggers truncation
    appendPipelineOutcome(path, makeRecord({ jobId: `j-last` }));

    const result = readPipelineOutcomes(path);
    expect(result).toHaveLength(MAX_PIPELINE_OUTCOMES);
    // Oldest records should be dropped, newest kept
    expect(result[result.length - 1].jobId).toBe("j-last");
    // First kept record should be the 6th original (index 5)
    expect(result[0].jobId).toBe("j-5");
  });
});

// ── truncatePipelineOutcomes ─────────────────────────────────────

describe("truncatePipelineOutcomes", () => {
  it("is a no-op when file has fewer entries than max", () => {
    const path = join(TMP_DIR, "small.jsonl");
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify(makeRecord({ jobId: `j-${i}` })),
    );
    writeFileSync(path, lines.join("\n") + "\n");

    truncatePipelineOutcomes(path, 100);
    expect(readPipelineOutcomes(path)).toHaveLength(5);
  });

  it("truncates to exactly maxEntries, keeping newest", () => {
    const path = join(TMP_DIR, "big.jsonl");
    const lines = Array.from({ length: 15 }, (_, i) =>
      JSON.stringify(makeRecord({ jobId: `j-${i}` })),
    );
    writeFileSync(path, lines.join("\n") + "\n");

    truncatePipelineOutcomes(path, 10);
    const result = readPipelineOutcomes(path);
    expect(result).toHaveLength(10);
    expect(result[0].jobId).toBe("j-5");
    expect(result[9].jobId).toBe("j-14");
  });

  it("is a no-op for missing file", () => {
    expect(() => truncatePipelineOutcomes(join(TMP_DIR, "nope.jsonl"), 10)).not.toThrow();
  });

  it("MAX_PIPELINE_OUTCOMES is 100", () => {
    expect(MAX_PIPELINE_OUTCOMES).toBe(100);
  });
});

// ── Pure: computeSkipRiskScores ──────────────────────────────────

describe("computeSkipRiskScores", () => {
  it("returns empty map for empty outcomes", () => {
    expect(computeSkipRiskScores([])).toEqual(new Map());
  });

  it("returns 0 for skills with fewer than MIN_SKIP_SAMPLES skips", () => {
    const outcomes = [
      makeRecord({ skippedSkills: ["office-hours"], outcome: "failure" }),
      makeRecord({ skippedSkills: ["office-hours"], outcome: "failure" }),
    ];
    const scores = computeSkipRiskScores(outcomes);
    expect(scores.get("office-hours")).toBe(0);
  });

  it("computes high risk when all skips correlate with failures", () => {
    const outcomes = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        jobId: `j${i}`,
        skippedSkills: ["plan-eng-review"],
        outcome: "failure",
        qaFailureCount: 2,
      }),
    );
    const scores = computeSkipRiskScores(outcomes);
    expect(scores.get("plan-eng-review")).toBeCloseTo(1.0, 1);
  });

  it("computes low risk when all skips succeed", () => {
    const outcomes = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        jobId: `j${i}`,
        skippedSkills: ["office-hours"],
        outcome: "success",
      }),
    );
    const scores = computeSkipRiskScores(outcomes);
    expect(scores.get("office-hours")).toBeCloseTo(0.0, 1);
  });

  it("computes mixed risk from mixed outcomes", () => {
    // 3 failures + 2 successes = ~0.6 (with decay favoring recent)
    const outcomes = [
      makeRecord({ jobId: "j0", skippedSkills: ["eng-review"], outcome: "failure" }),
      makeRecord({ jobId: "j1", skippedSkills: ["eng-review"], outcome: "failure" }),
      makeRecord({ jobId: "j2", skippedSkills: ["eng-review"], outcome: "failure" }),
      makeRecord({ jobId: "j3", skippedSkills: ["eng-review"], outcome: "success" }),
      makeRecord({ jobId: "j4", skippedSkills: ["eng-review"], outcome: "success" }),
    ];
    const scores = computeSkipRiskScores(outcomes);
    const risk = scores.get("eng-review")!;
    // With exponential decay, recent successes get more weight
    expect(risk).toBeGreaterThan(0.2);
    expect(risk).toBeLessThan(0.8);
  });

  it("applies exponential decay — recent failures weight more", () => {
    // Old successes, recent failures
    const oldSuccess = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ jobId: `old${i}`, skippedSkills: ["qa"], outcome: "success" }),
    );
    const recentFailures = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ jobId: `new${i}`, skippedSkills: ["qa"], outcome: "failure" }),
    );
    const scores = computeSkipRiskScores([...oldSuccess, ...recentFailures]);
    const risk = scores.get("qa")!;
    // Recent failures dominate, so risk should be > 0.5
    expect(risk).toBeGreaterThan(0.5);
  });

  it("exponential decay — old failures decay, recent successes dominate", () => {
    const oldFailures = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ jobId: `old${i}`, skippedSkills: ["qa"], outcome: "failure" }),
    );
    const recentSuccess = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ jobId: `new${i}`, skippedSkills: ["qa"], outcome: "success" }),
    );
    const scores = computeSkipRiskScores([...oldFailures, ...recentSuccess]);
    const risk = scores.get("qa")!;
    // Recent successes dominate, so risk should be < 0.5
    expect(risk).toBeLessThan(0.5);
  });

  it("tracks multiple skills independently", () => {
    const outcomes = [
      makeRecord({ jobId: "j0", skippedSkills: ["office-hours", "eng-review"], outcome: "failure" }),
      makeRecord({ jobId: "j1", skippedSkills: ["office-hours"], outcome: "success" }),
      makeRecord({ jobId: "j2", skippedSkills: ["office-hours", "eng-review"], outcome: "failure" }),
      makeRecord({ jobId: "j3", skippedSkills: ["eng-review"], outcome: "success" }),
      makeRecord({ jobId: "j4", skippedSkills: ["office-hours", "eng-review"], outcome: "success" }),
    ];
    const scores = computeSkipRiskScores(outcomes);
    expect(scores.has("office-hours")).toBe(true);
    expect(scores.has("eng-review")).toBe(true);
    // Both have 3+ samples
    expect(scores.get("office-hours")).not.toBe(scores.get("eng-review"));
  });

  it("ignores records where skill was NOT skipped", () => {
    const outcomes = [
      makeRecord({ jobId: "j0", skippedSkills: ["office-hours"], skills: ["implement", "qa"], outcome: "failure" }),
      makeRecord({ jobId: "j1", skippedSkills: [], skills: ["implement", "qa", "office-hours"], outcome: "failure" }),
      makeRecord({ jobId: "j2", skippedSkills: ["office-hours"], skills: ["implement", "qa"], outcome: "failure" }),
      makeRecord({ jobId: "j3", skippedSkills: ["office-hours"], skills: ["implement", "qa"], outcome: "success" }),
    ];
    const scores = computeSkipRiskScores(outcomes);
    // j1 has no skippedSkills for office-hours, so only 3 samples
    expect(scores.get("office-hours")).toBeDefined();
  });

  it("respects custom decay half-life", () => {
    // With very short half-life (1), old data decays fast
    const outcomes = [
      makeRecord({ jobId: "j0", skippedSkills: ["qa"], outcome: "failure" }),
      makeRecord({ jobId: "j1", skippedSkills: ["qa"], outcome: "failure" }),
      makeRecord({ jobId: "j2", skippedSkills: ["qa"], outcome: "failure" }),
      makeRecord({ jobId: "j3", skippedSkills: ["qa"], outcome: "success" }),
      makeRecord({ jobId: "j4", skippedSkills: ["qa"], outcome: "success" }),
    ];
    const fastDecay = computeSkipRiskScores(outcomes, 1);
    const slowDecay = computeSkipRiskScores(outcomes, 100);
    // Fast decay weights recent successes much more → lower risk
    expect(fastDecay.get("qa")!).toBeLessThan(slowDecay.get("qa")!);
  });

  it("handles partial outcomes as failures", () => {
    const outcomes = Array.from({ length: 5 }, (_, i) =>
      makeRecord({
        jobId: `j${i}`,
        skippedSkills: ["eng-review"],
        outcome: "partial",
      }),
    );
    const scores = computeSkipRiskScores(outcomes);
    // "partial" != "success", so should be treated as failure
    expect(scores.get("eng-review")).toBeCloseTo(1.0, 1);
  });
});

// ── Pure: shouldUseOracleComposition ─────────────────────────────

describe("shouldUseOracleComposition", () => {
  it("returns true with no outcomes", () => {
    expect(shouldUseOracleComposition([])).toBe(true);
  });

  it("returns true with insufficient Oracle-adjusted samples", () => {
    const outcomes = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ jobId: `j${i}`, oracleAdjusted: true, outcome: "failure" }),
    );
    // Only 5 samples, default min is 10
    expect(shouldUseOracleComposition(outcomes)).toBe(true);
  });

  it("returns true when Oracle performs better than static", () => {
    const oracle = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ jobId: `o${i}`, oracleAdjusted: true, outcome: "success" }),
    );
    const statics = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ jobId: `s${i}`, oracleAdjusted: false, outcome: i < 3 ? "failure" : "success" }),
    );
    expect(shouldUseOracleComposition([...oracle, ...statics])).toBe(true);
  });

  it("returns true when Oracle and static have similar rates", () => {
    // Both at 20% failure rate — within margin
    const oracle = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ jobId: `o${i}`, oracleAdjusted: true, outcome: i < 2 ? "failure" : "success" }),
    );
    const statics = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ jobId: `s${i}`, oracleAdjusted: false, outcome: i < 2 ? "failure" : "success" }),
    );
    expect(shouldUseOracleComposition([...oracle, ...statics])).toBe(true);
  });

  it("trips breaker when Oracle is meaningfully worse", () => {
    // Oracle: 50% failure, Static: 10% failure — well beyond margin
    const oracle = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ jobId: `o${i}`, oracleAdjusted: true, outcome: i < 5 ? "failure" : "success" }),
    );
    const statics = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ jobId: `s${i}`, oracleAdjusted: false, outcome: i < 1 ? "failure" : "success" }),
    );
    expect(shouldUseOracleComposition([...oracle, ...statics])).toBe(false);
  });

  it("respects custom minSampleSize", () => {
    const oracle = Array.from({ length: 3 }, (_, i) =>
      makeRecord({ jobId: `o${i}`, oracleAdjusted: true, outcome: "failure" }),
    );
    // With minSampleSize=3, this should trip
    expect(shouldUseOracleComposition(oracle, 3)).toBe(false);
    // With default minSampleSize=10, insufficient data
    expect(shouldUseOracleComposition(oracle)).toBe(true);
  });

  it("handles all-static outcomes (no Oracle jobs)", () => {
    const statics = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ jobId: `s${i}`, oracleAdjusted: false }),
    );
    // No Oracle-adjusted jobs < minSampleSize → return true
    expect(shouldUseOracleComposition(statics)).toBe(true);
  });

  it("handles zero static jobs (all Oracle)", () => {
    // 10 Oracle jobs, all success, no static comparison
    const oracle = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ jobId: `o${i}`, oracleAdjusted: true, outcome: "success" }),
    );
    // staticFailureRate = 0, oracleFailureRate = 0 → 0 > 0 + 0.1 is false → true
    expect(shouldUseOracleComposition(oracle)).toBe(true);
  });
});

// ── Pure: computeFailureRates ────────────────────────────────────

describe("computeFailureRates", () => {
  it("returns zeros for empty outcomes", () => {
    const result = computeFailureRates([]);
    expect(result.oracleFailureRate).toBe(0);
    expect(result.staticFailureRate).toBe(0);
    expect(result.oracleAdjustedCount).toBe(0);
    expect(result.staticOnlyCount).toBe(0);
  });

  it("computes correct rates for mixed outcomes", () => {
    const outcomes = [
      makeRecord({ oracleAdjusted: true, outcome: "success" }),
      makeRecord({ oracleAdjusted: true, outcome: "failure" }),
      makeRecord({ oracleAdjusted: false, outcome: "success" }),
      makeRecord({ oracleAdjusted: false, outcome: "success" }),
      makeRecord({ oracleAdjusted: false, outcome: "failure" }),
    ];
    const result = computeFailureRates(outcomes);
    expect(result.oracleFailureRate).toBe(50);
    expect(result.staticFailureRate).toBeCloseTo(33.33, 1);
    expect(result.oracleAdjustedCount).toBe(2);
    expect(result.staticOnlyCount).toBe(3);
  });

  it("treats partial as failure", () => {
    const outcomes = [
      makeRecord({ oracleAdjusted: true, outcome: "partial" }),
      makeRecord({ oracleAdjusted: true, outcome: "success" }),
    ];
    const result = computeFailureRates(outcomes);
    expect(result.oracleFailureRate).toBe(50);
  });
});

// ── Constants ────────────────────────────────────────────────────

describe("constants", () => {
  it("DEFAULT_DECAY_HALF_LIFE is 20", () => {
    expect(DEFAULT_DECAY_HALF_LIFE).toBe(20);
  });

  it("MIN_SKIP_SAMPLES is 3", () => {
    expect(MIN_SKIP_SAMPLES).toBe(3);
  });

  it("DEFAULT_SKIP_RISK_THRESHOLD is 0.3", () => {
    expect(DEFAULT_SKIP_RISK_THRESHOLD).toBe(0.3);
  });

  it("DEFAULT_CIRCUIT_BREAKER_MIN_SAMPLES is 10", () => {
    expect(DEFAULT_CIRCUIT_BREAKER_MIN_SAMPLES).toBe(10);
  });

  it("CIRCUIT_BREAKER_MARGIN is 0.1", () => {
    expect(CIRCUIT_BREAKER_MARGIN).toBe(0.1);
  });
});

// ── computeCategoryStats ────────────────────────────────────────

describe("computeCategoryStats", () => {
  it("returns empty array for empty outcomes", () => {
    expect(computeCategoryStats([])).toEqual([]);
  });

  it("returns empty array when no (category, skill) pair has enough samples", () => {
    const outcomes = [
      makeRecord({ taskCategory: "bug-fix", skills: ["implement", "qa"], skippedSkills: [] }),
      makeRecord({ taskCategory: "bug-fix", skills: ["implement", "qa"], skippedSkills: [] }),
    ];
    // Only 2 samples per pair, below MIN_CATEGORY_SAMPLES=3
    expect(computeCategoryStats(outcomes)).toEqual([]);
  });

  it("produces stats when a (category, skill) pair has 3+ samples", () => {
    const outcomes = [
      makeRecord({ taskCategory: "visual-ux", skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "failure" }),
      makeRecord({ taskCategory: "visual-ux", skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "failure" }),
      makeRecord({ taskCategory: "visual-ux", skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "success" }),
    ];
    const stats = computeCategoryStats(outcomes);
    // design-review was skipped 3 times (2 failures) → skippedFailureRate ≈ 66.67%
    const dr = stats.find(s => s.skill === "design-review" && s.category === "visual-ux");
    expect(dr).toBeDefined();
    expect(dr!.skippedCount).toBe(3);
    expect(dr!.skippedFailureRate).toBeCloseTo(66.67, 0);
    expect(dr!.includedCount).toBe(0);
    expect(dr!.includedFailureRate).toBe(0);
  });

  it("tracks both skipped and included for the same skill", () => {
    const outcomes = [
      // Skipped design-review, failed
      makeRecord({ taskCategory: "visual-ux", skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "failure" }),
      makeRecord({ taskCategory: "visual-ux", skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "failure" }),
      // Included design-review, succeeded
      makeRecord({ taskCategory: "visual-ux", skills: ["design-review", "implement", "qa"], skippedSkills: [], outcome: "success" }),
    ];
    const stats = computeCategoryStats(outcomes);
    const dr = stats.find(s => s.skill === "design-review" && s.category === "visual-ux");
    expect(dr).toBeDefined();
    expect(dr!.skippedCount).toBe(2);
    expect(dr!.skippedFailureRate).toBe(100);
    expect(dr!.includedCount).toBe(1);
    expect(dr!.includedFailureRate).toBe(0);
  });

  it("sorts by failure rate delta (biggest gap first)", () => {
    const outcomes = [
      // visual-ux: skip design-review = always fails
      makeRecord({ taskCategory: "visual-ux", skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "failure" }),
      makeRecord({ taskCategory: "visual-ux", skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "failure" }),
      makeRecord({ taskCategory: "visual-ux", skills: ["design-review", "implement", "qa"], skippedSkills: [], outcome: "success" }),
      // refactor: skip design-review = no failures
      makeRecord({ taskCategory: "refactor", skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "success" }),
      makeRecord({ taskCategory: "refactor", skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "success" }),
      makeRecord({ taskCategory: "refactor", skills: ["design-review", "implement", "qa"], skippedSkills: [], outcome: "success" }),
    ];
    const stats = computeCategoryStats(outcomes);
    // visual-ux delta = 100 - 0 = 100, refactor delta = 0 - 0 = 0
    const categories = stats.filter(s => s.skill === "design-review").map(s => s.category);
    expect(categories[0]).toBe("visual-ux");
  });

  it("groups undefined taskCategory as 'unknown'", () => {
    const outcomes = [
      makeRecord({ skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "failure" }),
      makeRecord({ skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "failure" }),
      makeRecord({ skills: ["implement", "qa"], skippedSkills: ["design-review"], outcome: "success" }),
    ];
    // taskCategory is undefined on makeRecord by default
    const stats = computeCategoryStats(outcomes);
    const dr = stats.find(s => s.skill === "design-review");
    expect(dr).toBeDefined();
    expect(dr!.category).toBe("unknown");
  });

  it("handles multiple categories independently", () => {
    const outcomes = [
      makeRecord({ taskCategory: "bug-fix", skills: ["implement", "qa"], skippedSkills: [], outcome: "success" }),
      makeRecord({ taskCategory: "bug-fix", skills: ["implement", "qa"], skippedSkills: [], outcome: "success" }),
      makeRecord({ taskCategory: "bug-fix", skills: ["implement", "qa"], skippedSkills: [], outcome: "success" }),
      makeRecord({ taskCategory: "visual-ux", skills: ["implement", "qa"], skippedSkills: [], outcome: "failure" }),
      makeRecord({ taskCategory: "visual-ux", skills: ["implement", "qa"], skippedSkills: [], outcome: "failure" }),
      makeRecord({ taskCategory: "visual-ux", skills: ["implement", "qa"], skippedSkills: [], outcome: "failure" }),
    ];
    const stats = computeCategoryStats(outcomes);
    const bugFixQa = stats.find(s => s.category === "bug-fix" && s.skill === "qa");
    const visualQa = stats.find(s => s.category === "visual-ux" && s.skill === "qa");
    expect(bugFixQa).toBeDefined();
    expect(bugFixQa!.includedFailureRate).toBe(0);
    expect(visualQa).toBeDefined();
    expect(visualQa!.includedFailureRate).toBe(100);
  });

  it("failure rate is 0 when all outcomes are success", () => {
    const outcomes = [
      makeRecord({ taskCategory: "refactor", skills: ["implement", "qa"], skippedSkills: [], outcome: "success" }),
      makeRecord({ taskCategory: "refactor", skills: ["implement", "qa"], skippedSkills: [], outcome: "success" }),
      makeRecord({ taskCategory: "refactor", skills: ["implement", "qa"], skippedSkills: [], outcome: "success" }),
    ];
    const stats = computeCategoryStats(outcomes);
    for (const s of stats) {
      expect(s.includedFailureRate).toBe(0);
      expect(s.skippedFailureRate).toBe(0);
    }
  });

  it("treats 'partial' outcome as non-failure (stricter than computeSkipRiskScores)", () => {
    const outcomes = [
      makeRecord({ taskCategory: "infra", skills: ["implement"], skippedSkills: ["qa"], outcome: "partial" as "success" | "partial" | "failure" }),
      makeRecord({ taskCategory: "infra", skills: ["implement"], skippedSkills: ["qa"], outcome: "partial" as "success" | "partial" | "failure" }),
      makeRecord({ taskCategory: "infra", skills: ["implement"], skippedSkills: ["qa"], outcome: "success" }),
    ];
    const stats = computeCategoryStats(outcomes);
    const qa = stats.find(s => s.skill === "qa" && s.category === "infra");
    expect(qa).toBeDefined();
    // "partial" does NOT count as failure — only "failure" does
    expect(qa!.skippedFailureRate).toBe(0);
  });

  it("MIN_CATEGORY_SAMPLES constant is 3", () => {
    expect(MIN_CATEGORY_SAMPLES).toBe(3);
  });
});
