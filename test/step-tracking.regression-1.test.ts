/**
 * Regression tests for detectCompletedSteps happy path.
 *
 * Mocks execFileSync to simulate git log output without needing a real repo.
 * Covers: sinceCommit arg construction, multi-commit parsing, reverse ordering,
 * step dedup, non-sequential completion, tie-breaking.
 *
 * Regression: ISSUE-001 — detectCompletedSteps happy path had zero unit coverage
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before importing implement.ts
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import { detectCompletedSteps } from "../src/implement.js";

const mockExecFileSync = vi.mocked(execFileSync);

const SAMPLE_STEPS = [
  "1. **Add `ImplementProgress` to types.ts.** New optional field on Checkpoint.",
  "2. **Add step detection logic to implement.ts.** New exported function `detectCompletedSteps`.",
  "3. **Wire step detection into orchestrator checkpoint building.**",
  "4. **Inject step progress into relay prompt.**",
  "5. **Update `buildImplementPrompt` for pipeline resume awareness.**",
  "6. **Tests.** New test file `test/step-tracking.test.ts`.",
];

const TEST_DIR = "/fake/project";

beforeEach(() => {
  mockExecFileSync.mockReset();
});

describe("detectCompletedSteps happy path (mocked git)", () => {
  it("parses single commit matching step 1 via exact number", () => {
    mockExecFileSync.mockReturnValue("abc1234 step 1: add ImplementProgress to types.ts\n");

    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    expect(result.completedSteps).toEqual([1]);
    expect(result.currentStep).toBe(2);
    expect(result.totalSteps).toBe(6);
    expect(result.stepCommits[1]).toBe("abc1234");
  });

  it("parses multiple commits matching different steps", () => {
    mockExecFileSync.mockReturnValue(
      [
        "abc1234 step 1: add ImplementProgress to types.ts",
        "def5678 step 2: add detectCompletedSteps to implement.ts",
        "ghi9012 step 3: wire step detection into orchestrator",
      ].join("\n") + "\n",
    );

    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    expect(result.completedSteps).toEqual([1, 2, 3]);
    expect(result.currentStep).toBe(4);
    expect(result.stepCommits[1]).toBe("abc1234");
    expect(result.stepCommits[2]).toBe("def5678");
    expect(result.stepCommits[3]).toBe("ghi9012");
  });

  it("processes commits oldest-first (reverses git log output)", () => {
    // Git log returns newest-first. detectCompletedSteps reverses to process oldest first.
    // If step 1 has two commits, the later one (first in git log) should win.
    mockExecFileSync.mockReturnValue(
      [
        "newer11 step 1: fix types.ts export",   // newer commit (listed first by git log)
        "older22 step 1: add types.ts interface", // older commit
      ].join("\n") + "\n",
    );

    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    // After reverse, older22 is processed first, then newer11 tries to add step 1 again
    // but completedSteps.includes(1) prevents it. So older22's SHA is kept.
    // Wait, re-reading the code: stepCommits[stepNum] = sha overwrites, but
    // completedSteps.includes(stepNum) prevents the second push. So first match wins
    // after reversal = the OLDER commit's SHA is kept.
    expect(result.completedSteps).toEqual([1]);
    expect(result.stepCommits[1]).toBe("older22");
  });

  it("deduplicates steps — same step matched twice keeps first SHA", () => {
    mockExecFileSync.mockReturnValue(
      [
        "bbb2222 feat: implement.ts detection logic with detectCompletedSteps",
        "aaa1111 feat: add implement.ts step detection function detectCompletedSteps",
      ].join("\n") + "\n",
    );

    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    // Both commits fuzzy-match step 2 (implement.ts + detectCompletedSteps tokens).
    // After reverse, aaa1111 is processed first and wins.
    expect(result.completedSteps).toContain(2);
    expect(result.stepCommits[2]).toBe("aaa1111");
  });

  it("handles non-sequential step completion (steps 1,3 done, 2 not)", () => {
    mockExecFileSync.mockReturnValue(
      [
        "abc1234 step 1: types.ts",
        "def5678 step 3: wire orchestrator",
      ].join("\n") + "\n",
    );

    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    expect(result.completedSteps).toEqual([1, 3]);
    expect(result.currentStep).toBe(2); // first incomplete step
    expect(result.stepCommits[1]).toBe("abc1234");
    expect(result.stepCommits[3]).toBe("def5678");
  });

  it("returns all-complete when every step has a commit", () => {
    mockExecFileSync.mockReturnValue(
      [
        "a11 step 1: types",
        "b22 step 2: implement",
        "c33 step 3: orchestrator",
        "d44 step 4: relay prompt",
        "e55 step 5: buildImplementPrompt",
        "f66 step 6: tests",
      ].join("\n") + "\n",
    );

    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    expect(result.completedSteps).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.currentStep).toBe(7); // totalSteps + 1
  });

  it("uses sinceCommit arg when provided", () => {
    mockExecFileSync.mockReturnValue("abc1234 step 1: types\n");

    detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md", "deadbeef");

    // Verify execFileSync was called with the sinceCommit..HEAD range
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["log", "--oneline", "deadbeef..HEAD"],
      expect.objectContaining({
        cwd: TEST_DIR,
        encoding: "utf-8",
        timeout: 10_000,
      }),
    );
  });

  it("uses --max-count=50 when no sinceCommit provided", () => {
    mockExecFileSync.mockReturnValue("abc1234 step 1: types\n");

    detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["log", "--oneline", "--max-count=50"],
      expect.objectContaining({
        cwd: TEST_DIR,
      }),
    );
  });

  it("handles empty git log output (no commits)", () => {
    mockExecFileSync.mockReturnValue("");

    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    expect(result.completedSteps).toEqual([]);
    expect(result.currentStep).toBe(1);
    expect(result.totalSteps).toBe(6);
  });

  it("skips commit lines with no space (malformed)", () => {
    mockExecFileSync.mockReturnValue(
      [
        "abc1234",                                 // no space — skipped
        "def5678 step 2: add detection logic",     // valid
      ].join("\n") + "\n",
    );

    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    expect(result.completedSteps).toEqual([2]);
    expect(result.currentStep).toBe(1);
  });

  it("matches commits via fuzzy tokens (tier 2) when no step number", () => {
    mockExecFileSync.mockReturnValue(
      "abc1234 feat: add relay prompt injection with step progress\n",
    );

    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    // "relay" + "prompt" + "progress" + "step" → should match step 4
    // "Inject step progress into relay prompt" → tokens: inject, progress, relay, prompt
    expect(result.completedSteps).toContain(4);
  });

  it("ignores commits that don't match any step", () => {
    mockExecFileSync.mockReturnValue(
      [
        "abc1234 chore: update package.json",
        "def5678 fix: typo in README",
        "ghi9012 step 1: add types.ts",
      ].join("\n") + "\n",
    );

    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    // Only step 1 should be detected
    expect(result.completedSteps).toEqual([1]);
    expect(Object.keys(result.stepCommits)).toHaveLength(1);
  });

  it("sorts completed steps numerically", () => {
    mockExecFileSync.mockReturnValue(
      [
        "ccc step 5: buildImplementPrompt resume",
        "bbb step 3: wire orchestrator",
        "aaa step 1: add types.ts",
      ].join("\n") + "\n",
    );

    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");

    // Should be sorted [1, 3, 5] regardless of commit order
    expect(result.completedSteps).toEqual([1, 3, 5]);
    expect(result.currentStep).toBe(2);
  });
});
