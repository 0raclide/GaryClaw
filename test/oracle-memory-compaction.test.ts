import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OracleMemoryConfig, DecisionOutcome } from "../src/types.js";
import {
  compactOutcomeEntry,
  stripCompactMarker,
  compactDecisionOutcomes,
  writeDecisionOutcomesRolling,
  readDecisionOutcomes,
  parseDecisionOutcomes,
  COMPACT_MARKER,
  RECENT_KEEP_FULL,
  PATTERNS_BUDGET_TOKENS,
} from "../src/oracle-memory.js";
import { normalizeQuestion, OracleCache } from "../src/oracle-cache.js";

const BASE_DIR = join(tmpdir(), `garyclaw-compaction-${Date.now()}`);

function makeConfig(): OracleMemoryConfig {
  return {
    globalDir: join(BASE_DIR, "global", "oracle-memory"),
    projectDir: join(BASE_DIR, "project", ".garyclaw", "oracle-memory"),
  };
}

function makeOutcome(overrides: Partial<DecisionOutcome> = {}): DecisionOutcome {
  return {
    decisionId: `d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    question: "GaryClaw is a CLI tool with 2,978 vitest tests at /Users/chris/Desktop/GaryClaw. Should we use approach A or approach B for implementing the relay engine?",
    chosen: "Approach A",
    confidence: 8,
    principle: "Explicit over clever",
    outcome: "success",
    ...overrides,
  };
}

let config: OracleMemoryConfig;

beforeEach(() => {
  config = makeConfig();
  mkdirSync(config.globalDir, { recursive: true });
  mkdirSync(config.projectDir, { recursive: true });
});

afterEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

describe("compactOutcomeEntry", () => {
  it("compacts long question to keyword bag with [compact] prefix", () => {
    const outcome = makeOutcome();
    const compacted = compactOutcomeEntry(outcome);

    expect(compacted.question).toMatch(/^\[compact\] /);
    // Normalized keyword bag should be much shorter than original
    expect(compacted.question.length).toBeLessThan(outcome.question.length);
    // Should contain key terms
    expect(compacted.question).toContain("approach");
    expect(compacted.question).toContain("relay");
  });

  it("preserves already-compacted entries (idempotent)", () => {
    const outcome = makeOutcome();
    const compacted1 = compactOutcomeEntry(outcome);
    const compacted2 = compactOutcomeEntry(compacted1);

    expect(compacted2).toEqual(compacted1);
    // Question should not get double-prefixed
    expect(compacted2.question).not.toMatch(/^\[compact\] \[compact\] /);
  });

  it("preserves all non-question fields unchanged", () => {
    const outcome = makeOutcome({
      decisionId: "d-test-123",
      chosen: "Approach B",
      confidence: 9,
      principle: "P3",
      outcome: "failure",
      outcomeDetail: "Tests failed",
      relatedFilePath: "src/foo.ts",
      jobId: "job-42",
    });
    const compacted = compactOutcomeEntry(outcome);

    expect(compacted.decisionId).toBe("d-test-123");
    expect(compacted.chosen).toBe("Approach B");
    expect(compacted.confidence).toBe(9);
    expect(compacted.principle).toBe("P3");
    expect(compacted.outcome).toBe("failure");
    expect(compacted.outcomeDetail).toBe("Tests failed");
    expect(compacted.relatedFilePath).toBe("src/foo.ts");
    expect(compacted.jobId).toBe("job-42");
  });

  it("handles empty question string", () => {
    const outcome = makeOutcome({ question: "" });
    const compacted = compactOutcomeEntry(outcome);
    expect(compacted.question).toBe("[compact] ");
  });
});

describe("stripCompactMarker", () => {
  it("strips [compact] prefix from compacted question", () => {
    expect(stripCompactMarker("[compact] approach cli relay")).toBe("approach cli relay");
  });

  it("returns uncompacted question unchanged", () => {
    const original = "Should we use approach A or B?";
    expect(stripCompactMarker(original)).toBe(original);
  });
});

describe("compactDecisionOutcomes", () => {
  it("returns unchanged when entries <= RECENT_KEEP_FULL", () => {
    const outcomes = Array.from({ length: RECENT_KEEP_FULL }, (_, i) =>
      makeOutcome({ decisionId: `d-${i}` }),
    );
    const result = compactDecisionOutcomes(outcomes);
    expect(result).toEqual(outcomes);
    // No entry should have [compact] prefix
    for (const o of result) {
      expect(o.question).not.toMatch(/^\[compact\] /);
    }
  });

  it("compacts entries beyond RECENT_KEEP_FULL cutoff", () => {
    const outcomes = Array.from({ length: 20 }, (_, i) =>
      makeOutcome({ decisionId: `d-${i}` }),
    );
    const result = compactDecisionOutcomes(outcomes);

    // First 10 should be compacted
    for (let i = 0; i < 10; i++) {
      expect(result[i].question).toMatch(/^\[compact\] /);
    }
  });

  it("preserves last RECENT_KEEP_FULL entries with full text", () => {
    const outcomes = Array.from({ length: 20 }, (_, i) =>
      makeOutcome({ decisionId: `d-${i}` }),
    );
    const result = compactDecisionOutcomes(outcomes);

    // Last 10 should keep full text
    for (let i = 10; i < 20; i++) {
      expect(result[i].question).not.toMatch(/^\[compact\] /);
      expect(result[i]).toEqual(outcomes[i]);
    }
  });

  it("handles exactly RECENT_KEEP_FULL + 1 entries", () => {
    const outcomes = Array.from({ length: RECENT_KEEP_FULL + 1 }, (_, i) =>
      makeOutcome({ decisionId: `d-${i}` }),
    );
    const result = compactDecisionOutcomes(outcomes);

    // First entry compacted, rest full
    expect(result[0].question).toMatch(/^\[compact\] /);
    for (let i = 1; i <= RECENT_KEEP_FULL; i++) {
      expect(result[i].question).not.toMatch(/^\[compact\] /);
    }
  });
});

describe("writeDecisionOutcomesRolling integration", () => {
  it("compacts entries on write (end-to-end)", () => {
    const outcomes = Array.from({ length: 15 }, (_, i) =>
      makeOutcome({ decisionId: `d-${i}` }),
    );
    writeDecisionOutcomesRolling(config, outcomes);

    const content = readFileSync(
      join(config.projectDir, "decision-outcomes.md"),
      "utf-8",
    );

    // First 5 entries should have [compact] marker
    const parsed = parseDecisionOutcomes(content);
    expect(parsed.length).toBe(15);

    for (let i = 0; i < 5; i++) {
      expect(parsed[i].question).toMatch(/^\[compact\] /);
    }
    // Last 10 should keep full text
    for (let i = 5; i < 15; i++) {
      expect(parsed[i].question).not.toMatch(/^\[compact\] /);
    }
  });

  it("caps Patterns section to PATTERNS_BUDGET_TOKENS", () => {
    // Create >50 entries to trigger patterns section
    const outcomes = Array.from({ length: 60 }, (_, i) =>
      makeOutcome({
        decisionId: `d-${i}`,
        outcome: i % 3 === 0 ? "failure" : "success",
      }),
    );
    writeDecisionOutcomesRolling(config, outcomes);

    const content = readFileSync(
      join(config.projectDir, "decision-outcomes.md"),
      "utf-8",
    );

    // Should have Patterns section
    expect(content).toContain("## Patterns");
    // Patterns section should be bounded
    const patternsMatch = content.match(/## Patterns.*?\n([\s\S]*?)(?=\n## Recent)/);
    expect(patternsMatch).not.toBeNull();
    const patternsText = patternsMatch![1];
    // Patterns should fit within budget (budget * 4 chars)
    expect(patternsText.length).toBeLessThanOrEqual(PATTERNS_BUDGET_TOKENS * 4 + 100); // small margin
  });

  it("backward compat: reads existing uncompacted file correctly", () => {
    // Write an uncompacted file directly
    const outcomes = Array.from({ length: 5 }, (_, i) =>
      makeOutcome({ decisionId: `d-compat-${i}` }),
    );
    writeDecisionOutcomesRolling(config, outcomes);

    // Read it back — should parse fine (no compaction for <=10 entries)
    const parsed = readDecisionOutcomes(config);
    expect(parsed.length).toBe(5);
    for (const o of parsed) {
      expect(o.question).not.toMatch(/^\[compact\] /);
    }
  });

  it("mixed compacted + uncompacted entries round-trip", () => {
    // Write 15 entries (5 compacted, 10 full)
    const outcomes = Array.from({ length: 15 }, (_, i) =>
      makeOutcome({ decisionId: `d-rt-${i}` }),
    );
    writeDecisionOutcomesRolling(config, outcomes);

    // Read back
    const parsed = readDecisionOutcomes(config);
    expect(parsed.length).toBe(15);

    // Write again — compacted entries should stay compacted (idempotent)
    writeDecisionOutcomesRolling(config, parsed);
    const parsed2 = readDecisionOutcomes(config);
    expect(parsed2.length).toBe(15);

    // Same compaction pattern
    for (let i = 0; i < 5; i++) {
      expect(parsed2[i].question).toMatch(/^\[compact\] /);
      expect(parsed2[i].question).toBe(parsed[i].question);
    }
  });
});

describe("warmFromOutcomes cache key stability", () => {
  it("compacted entry produces same cache key as original uncompacted entry", () => {
    const originalQuestion = "GaryClaw is a CLI tool with 2,978 vitest tests at /Users/chris/Desktop/GaryClaw. Should we use approach A or approach B for implementing the relay engine?";

    // Normalize the original question (what warm start does for uncompacted)
    const normalizedOriginal = normalizeQuestion(originalQuestion);

    // Compact the entry
    const compacted = compactOutcomeEntry(makeOutcome({ question: originalQuestion }));
    // Strip the [compact] prefix and normalize (what warm start should do for compacted)
    const strippedQ = stripCompactMarker(compacted.question);
    const normalizedCompacted = normalizeQuestion(strippedQ);

    // Cache keys should match
    expect(normalizedCompacted).toBe(normalizedOriginal);

    // Verify via actual OracleCache warm-start
    const cache1 = new OracleCache({ minHits: 2 });
    const uncompactedOutcomes = Array.from({ length: 2 }, () =>
      makeOutcome({ question: originalQuestion }),
    );
    cache1.warmFromOutcomes(uncompactedOutcomes);
    const result1 = cache1.lookup(originalQuestion, []);

    const cache2 = new OracleCache({ minHits: 2 });
    const compactedOutcomes = Array.from({ length: 2 }, () => ({
      ...makeOutcome({ question: originalQuestion }),
      question: compacted.question,
    }));
    cache2.warmFromOutcomes(compactedOutcomes);
    const result2 = cache2.lookup(originalQuestion, []);

    // Both should produce a hit with the same chosen answer
    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result1!.chosen).toBe(result2!.chosen);
  });
});

describe("exported constants", () => {
  it("COMPACT_MARKER is the expected prefix", () => {
    expect(COMPACT_MARKER).toBe("[compact] ");
  });

  it("RECENT_KEEP_FULL is 10", () => {
    expect(RECENT_KEEP_FULL).toBe(10);
  });

  it("PATTERNS_BUDGET_TOKENS is 2000", () => {
    expect(PATTERNS_BUDGET_TOKENS).toBe(2_000);
  });
});
