/**
 * Step tracking tests — detectCompletedSteps, matchCommitToStep,
 * extractStepTokens, formatImplementProgress, relay prompt integration,
 * buildCheckpoint integration, buildImplementPrompt resume awareness.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractStepTokens,
  matchCommitToStep,
  detectCompletedSteps,
  extractImplementationOrder,
  buildImplementPrompt,
  findDesignDoc,
} from "../src/implement.js";

import {
  generateRelayPrompt,
  formatImplementProgress,
  validateCheckpoint,
} from "../src/checkpoint.js";

import {
  createMockCheckpoint,
  createMockTokenUsageSnapshot,
  resetCounters,
} from "./helpers.js";

import type { ImplementProgress, Checkpoint, GaryClawConfig, PipelineSkillEntry } from "../src/types.js";

const TEST_DIR = join(tmpdir(), `garyclaw-step-tracking-${Date.now()}`);
const DESIGNS_DIR = join(TEST_DIR, "docs", "designs");

function createMockProgress(overrides: Partial<ImplementProgress> = {}): ImplementProgress {
  return {
    completedSteps: [1, 2],
    currentStep: 3,
    totalSteps: 5,
    stepCommits: { 1: "abc1234", 2: "def5678" },
    designDocPath: "/path/to/design.md",
    ...overrides,
  };
}

function createMockConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skillName: "implement",
    projectDir: TEST_DIR,
    maxTurnsPerSegment: 15,
    relayThresholdRatio: 0.85,
    checkpointDir: join(TEST_DIR, ".garyclaw"),
    settingSources: [],
    env: {},
    askTimeoutMs: 30000,
    maxRelaySessions: 10,
    autonomous: true,
    ...overrides,
  };
}

const SAMPLE_STEPS = [
  "1. **Add `implementProgress` to types.ts.** New optional field on Checkpoint.",
  "2. **Add step detection logic to implement.ts.** New exported function `detectCompletedSteps`.",
  "3. **Wire step detection into orchestrator checkpoint building.**",
  "4. **Inject step progress into relay prompt.**",
  "5. **Update `buildImplementPrompt` for pipeline resume awareness.**",
  "6. **Tests.** New test file `test/step-tracking.test.ts`.",
];

beforeEach(() => {
  resetCounters();
  mkdirSync(DESIGNS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── extractStepTokens ────────────────────────────────────────────

describe("extractStepTokens", () => {
  it("extracts file names as high-signal tokens", () => {
    const tokens = extractStepTokens("1. **Add DashboardData to types.ts**");
    expect(tokens).toContain("types.ts");
  });

  it("extracts meaningful words, filtering stop words", () => {
    const tokens = extractStepTokens("1. Wire dashboard generation into job-runner completion path");
    expect(tokens).toContain("dashboard");
    expect(tokens).toContain("job-runner");
    expect(tokens).not.toContain("into");
    expect(tokens).not.toContain("the");
  });

  it("removes step number prefix and markdown bold", () => {
    const tokens = extractStepTokens("3. **Wire step detection into orchestrator.**");
    expect(tokens).not.toContain("3");
    expect(tokens).toContain("detection");
    expect(tokens).toContain("orchestrator");
  });

  it("returns empty array for empty string", () => {
    expect(extractStepTokens("")).toEqual([]);
  });

  it("deduplicates tokens", () => {
    const tokens = extractStepTokens("1. Add types.ts changes to types.ts");
    const typesCount = tokens.filter((t) => t === "types.ts").length;
    expect(typesCount).toBe(1);
  });

  it("handles hyphenated module names", () => {
    const tokens = extractStepTokens("3. Wire into job-runner and oracle-memory");
    expect(tokens).toContain("job-runner");
    expect(tokens).toContain("oracle-memory");
  });
});

// ── matchCommitToStep ────────────────────────────────────────────

describe("matchCommitToStep", () => {
  describe("Tier 1: exact step number", () => {
    it('matches "step 1: ..." format', () => {
      expect(matchCommitToStep("step 1: create types.ts", SAMPLE_STEPS)).toBe(1);
    });

    it('matches "Step 3: ..." format (case insensitive)', () => {
      expect(matchCommitToStep("Step 3: wire step detection", SAMPLE_STEPS)).toBe(3);
    });

    it('matches "1. ..." format (leading number with dot)', () => {
      expect(matchCommitToStep("1. Add DashboardData interface", SAMPLE_STEPS)).toBe(1);
    });

    it('matches "2: ..." format (number with colon)', () => {
      expect(matchCommitToStep("2: add step detection logic", SAMPLE_STEPS)).toBe(2);
    });

    it("rejects step number out of range", () => {
      expect(matchCommitToStep("step 99: something", SAMPLE_STEPS)).toBeNull();
    });

    it("rejects step number 0", () => {
      expect(matchCommitToStep("step 0: init", SAMPLE_STEPS)).toBeNull();
    });
  });

  describe("Tier 2: fuzzy token matching", () => {
    it("matches by file name + module name tokens", () => {
      const result = matchCommitToStep(
        "feat: add DashboardData interface to types.ts",
        SAMPLE_STEPS,
      );
      expect(result).toBe(1); // matches step 1 via "types.ts"
    });

    it("matches by action + module tokens", () => {
      const result = matchCommitToStep(
        "feat: wire dashboard generation into job-runner completion path",
        ["1. Add types", "2. Create dashboard.ts", "3. Wire into job-runner"],
      );
      expect(result).toBe(3); // "wire" + "job-runner"
    });

    it("returns null when fewer than 2 tokens match", () => {
      const result = matchCommitToStep("fix: typo in readme", SAMPLE_STEPS);
      expect(result).toBeNull();
    });

    it("picks highest-scoring step when multiple match", () => {
      const steps = [
        "1. Add dashboard module with aggregation",
        "2. Wire dashboard into job-runner and orchestrator",
      ];
      // "dashboard" matches both, but "orchestrator" only matches step 2
      const result = matchCommitToStep(
        "feat: wire dashboard into orchestrator",
        steps,
      );
      expect(result).toBe(2);
    });
  });

  it("returns null for empty commit message", () => {
    expect(matchCommitToStep("", SAMPLE_STEPS)).toBeNull();
  });

  it("returns null for empty steps array", () => {
    expect(matchCommitToStep("step 1: something", [])).toBeNull();
  });
});

// ── detectCompletedSteps ─────────────────────────────────────────

describe("detectCompletedSteps", () => {
  // We test with mocked execFileSync since we don't have a real git repo in tmp
  it("returns empty progress when steps array is empty", () => {
    const result = detectCompletedSteps([], TEST_DIR, "/design.md");
    expect(result.completedSteps).toEqual([]);
    expect(result.currentStep).toBe(1);
    expect(result.totalSteps).toBe(0);
  });

  it("returns empty progress when git log fails (no git repo)", () => {
    const result = detectCompletedSteps(SAMPLE_STEPS, TEST_DIR, "/design.md");
    expect(result.completedSteps).toEqual([]);
    expect(result.currentStep).toBe(1);
    expect(result.totalSteps).toBe(6);
    expect(result.designDocPath).toBe("/design.md");
  });

  it("returns correct designDocPath in result", () => {
    const result = detectCompletedSteps(
      SAMPLE_STEPS,
      TEST_DIR,
      "/project/docs/designs/my-design.md",
    );
    expect(result.designDocPath).toBe("/project/docs/designs/my-design.md");
  });

  it("preserves totalSteps count from input", () => {
    const steps = ["1. First", "2. Second", "3. Third"];
    const result = detectCompletedSteps(steps, TEST_DIR, "/d.md");
    expect(result.totalSteps).toBe(3);
  });
});

// ── formatImplementProgress ──────────────────────────────────────

describe("formatImplementProgress", () => {
  it("renders completed steps with SHAs", () => {
    const progress = createMockProgress();
    const text = formatImplementProgress(progress);

    expect(text).toContain("2/5 steps complete");
    expect(text).toContain("✅ Step 1 (abc1234)");
    expect(text).toContain("✅ Step 2 (def5678)");
  });

  it("renders remaining steps with resume marker", () => {
    const progress = createMockProgress();
    const text = formatImplementProgress(progress);

    expect(text).toContain("⬜ Step 3 ← resume here");
    expect(text).toContain("⬜ Step 4");
    expect(text).toContain("⬜ Step 5");
  });

  it("omits remaining section when all steps complete", () => {
    const progress = createMockProgress({
      completedSteps: [1, 2, 3, 4, 5],
      currentStep: 6,
      totalSteps: 5,
      stepCommits: { 1: "a", 2: "b", 3: "c", 4: "d", 5: "e" },
    });
    const text = formatImplementProgress(progress);

    expect(text).toContain("5/5 steps complete");
    expect(text).not.toContain("Remaining");
    expect(text).not.toContain("⬜");
  });

  it("handles no completed steps", () => {
    const progress = createMockProgress({
      completedSteps: [],
      currentStep: 1,
      stepCommits: {},
    });
    const text = formatImplementProgress(progress);

    expect(text).toContain("0/5 steps complete");
    expect(text).not.toContain("Completed");
    expect(text).toContain("⬜ Step 1 ← resume here");
  });

  it("handles single-step design", () => {
    const progress = createMockProgress({
      completedSteps: [1],
      currentStep: 2,
      totalSteps: 1,
      stepCommits: { 1: "abc" },
    });
    const text = formatImplementProgress(progress);

    expect(text).toContain("1/1 steps complete");
    expect(text).toContain("✅ Step 1");
    expect(text).not.toContain("⬜");
  });

  it("handles non-sequential completion (steps 1,3 done, 2 not)", () => {
    const progress = createMockProgress({
      completedSteps: [1, 3],
      currentStep: 2,
      totalSteps: 5,
      stepCommits: { 1: "a", 3: "c" },
    });
    const text = formatImplementProgress(progress);

    expect(text).toContain("2/5 steps complete");
    expect(text).toContain("✅ Step 1");
    expect(text).toContain("✅ Step 3");
    expect(text).toContain("⬜ Step 2 ← resume here");
    expect(text).toContain("⬜ Step 4");
    expect(text).toContain("⬜ Step 5");
  });

  it("uses 'unknown' for missing commit SHA", () => {
    const progress = createMockProgress({
      completedSteps: [1],
      currentStep: 2,
      stepCommits: {},  // no SHA recorded
    });
    const text = formatImplementProgress(progress);
    expect(text).toContain("✅ Step 1 (unknown)");
  });
});

// ── generateRelayPrompt with implementProgress ──────────────────

describe("generateRelayPrompt with implementProgress", () => {
  it("includes implementation progress section when present", () => {
    const checkpoint = createMockCheckpoint({
      skillName: "implement",
      implementProgress: createMockProgress(),
    });
    const prompt = generateRelayPrompt(checkpoint);

    expect(prompt).toContain("## Implementation Progress");
    expect(prompt).toContain("2/5 steps complete");
    expect(prompt).toContain("✅ Step 1");
    expect(prompt).toContain("⬜ Step 3 ← resume here");
  });

  it("uses implement-specific instructions when progress present", () => {
    const checkpoint = createMockCheckpoint({
      skillName: "implement",
      implementProgress: createMockProgress(),
    });
    const prompt = generateRelayPrompt(checkpoint);

    expect(prompt).toContain("Resume implementation at step 3");
    expect(prompt).toContain("Design doc:");
    expect(prompt).not.toContain("Start with the highest-severity open issue");
  });

  it("uses all-complete instructions when all steps done", () => {
    const checkpoint = createMockCheckpoint({
      skillName: "implement",
      implementProgress: createMockProgress({
        completedSteps: [1, 2, 3, 4, 5],
        currentStep: 6,
        totalSteps: 5,
      }),
    });
    const prompt = generateRelayPrompt(checkpoint);

    expect(prompt).toContain("All implementation steps complete");
    expect(prompt).toContain("verify tests pass");
    expect(prompt).not.toContain("Resume implementation at step");
  });

  it("uses default instructions when implementProgress is absent (backward compat)", () => {
    const checkpoint = createMockCheckpoint({ skillName: "qa" });
    const prompt = generateRelayPrompt(checkpoint);

    expect(prompt).not.toContain("## Implementation Progress");
    expect(prompt).toContain("Continue the qa skill");
    expect(prompt).toContain("Start with the highest-severity open issue");
  });

  it("uses default instructions for implement skill without progress", () => {
    const checkpoint = createMockCheckpoint({ skillName: "implement" });
    // No implementProgress field
    const prompt = generateRelayPrompt(checkpoint);

    expect(prompt).not.toContain("## Implementation Progress");
    expect(prompt).toContain("Continue the implement skill");
  });

  it("keeps step progress within token budget", () => {
    const progress = createMockProgress({
      completedSteps: [1, 2, 3],
      currentStep: 4,
      totalSteps: 5,
      stepCommits: { 1: "a".repeat(7), 2: "b".repeat(7), 3: "c".repeat(7) },
    });
    const checkpoint = createMockCheckpoint({
      skillName: "implement",
      implementProgress: progress,
    });
    const prompt = generateRelayPrompt(checkpoint, { maxTokens: 10_000 });

    // The prompt should fit within the budget
    expect(prompt.length / 3.5).toBeLessThan(10_000);
  });
});

// ── validateCheckpoint backward compatibility ────────────────────

describe("validateCheckpoint with implementProgress", () => {
  it("validates checkpoint without implementProgress (backward compat)", () => {
    const cp = createMockCheckpoint();
    expect(validateCheckpoint(cp)).toBe(true);
  });

  it("validates checkpoint with implementProgress", () => {
    const cp = createMockCheckpoint({
      implementProgress: createMockProgress(),
    });
    expect(validateCheckpoint(cp)).toBe(true);
  });

  it("validates checkpoint with empty implementProgress fields", () => {
    const cp = createMockCheckpoint({
      implementProgress: {
        completedSteps: [],
        currentStep: 1,
        totalSteps: 3,
        stepCommits: {},
        designDocPath: "/d.md",
      },
    });
    expect(validateCheckpoint(cp)).toBe(true);
  });
});

// ── buildImplementPrompt with resume checkpoint ──────────────────

describe("buildImplementPrompt with resume checkpoint", () => {
  const DESIGN_CONTENT = `# Design: Test Feature

## Implementation Order

1. **Add types to types.ts.**
2. **Create module.ts with core logic.**
3. **Wire into orchestrator.**
4. **Add tests.**
5. **Update docs.**
`;

  function writeDesignDoc(): void {
    writeFileSync(join(DESIGNS_DIR, "test-feature.md"), DESIGN_CONTENT, "utf-8");
  }

  it("shows all steps when no resume checkpoint", async () => {
    writeDesignDoc();
    const config = createMockConfig();
    const prompt = await buildImplementPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("## Implementation Order");
    expect(prompt).not.toContain("(Remaining)");
    expect(prompt).toContain("1. **Add types to types.ts.**");
    expect(prompt).toContain("5. **Update docs.**");
  });

  it("shows all steps when resume checkpoint has no implementProgress", async () => {
    writeDesignDoc();
    const config = createMockConfig();
    const checkpoint = createMockCheckpoint();
    const prompt = await buildImplementPrompt(config, [], TEST_DIR, checkpoint);

    expect(prompt).toContain("## Implementation Order");
    expect(prompt).not.toContain("(Remaining)");
  });

  it("filters to remaining steps when resume checkpoint has progress", async () => {
    writeDesignDoc();
    const config = createMockConfig();
    const checkpoint = createMockCheckpoint({
      implementProgress: {
        completedSteps: [1, 2],
        currentStep: 3,
        totalSteps: 5,
        stepCommits: { 1: "aaa", 2: "bbb" },
        designDocPath: join(DESIGNS_DIR, "test-feature.md"),
      },
    });
    const prompt = await buildImplementPrompt(config, [], TEST_DIR, checkpoint);

    expect(prompt).toContain("## Implementation Order (Remaining)");
    expect(prompt).toContain("Steps 1, 2 complete (2/5)");
    expect(prompt).toContain("Resume at step 3");
    // Extract the "Implementation Order (Remaining)" section specifically
    const orderSection = prompt.split("## Implementation Order (Remaining)")[1]?.split("## ")[0] ?? "";
    // Remaining steps should be in that section
    expect(orderSection).toContain("3. **Wire into orchestrator.**");
    expect(orderSection).toContain("4. **Add tests.**");
    expect(orderSection).toContain("5. **Update docs.**");
    // Completed steps should NOT be in the remaining section
    expect(orderSection).not.toContain("1. **Add types to types.ts.**");
    expect(orderSection).not.toContain("2. **Create module.ts");
  });

  it("shows all steps when checkpoint has empty completedSteps", async () => {
    writeDesignDoc();
    const config = createMockConfig();
    const checkpoint = createMockCheckpoint({
      implementProgress: {
        completedSteps: [],
        currentStep: 1,
        totalSteps: 5,
        stepCommits: {},
        designDocPath: join(DESIGNS_DIR, "test-feature.md"),
      },
    });
    const prompt = await buildImplementPrompt(config, [], TEST_DIR, checkpoint);

    // Empty completedSteps → show all steps (no filtering)
    expect(prompt).toContain("## Implementation Order");
    expect(prompt).not.toContain("(Remaining)");
  });

  it("accepts null resume checkpoint gracefully", async () => {
    writeDesignDoc();
    const config = createMockConfig();
    const prompt = await buildImplementPrompt(config, [], TEST_DIR, null);

    expect(prompt).toContain("## Implementation Order");
    expect(prompt).not.toContain("(Remaining)");
  });
});

// ── ImplementProgress type on Checkpoint ─────────────────────────

describe("ImplementProgress on Checkpoint", () => {
  it("checkpoint round-trips with implementProgress via JSON", () => {
    const cp = createMockCheckpoint({
      implementProgress: createMockProgress(),
    });

    const json = JSON.stringify(cp);
    const parsed = JSON.parse(json) as Checkpoint;

    expect(parsed.implementProgress).toBeDefined();
    expect(parsed.implementProgress!.completedSteps).toEqual([1, 2]);
    expect(parsed.implementProgress!.currentStep).toBe(3);
    expect(parsed.implementProgress!.totalSteps).toBe(5);
    expect(parsed.implementProgress!.stepCommits[1]).toBe("abc1234");
  });

  it("checkpoint without implementProgress has undefined field", () => {
    const cp = createMockCheckpoint();
    expect(cp.implementProgress).toBeUndefined();
  });
});
