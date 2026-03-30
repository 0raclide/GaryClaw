import { describe, it, expect } from "vitest";
import {
  normalizeQuestion,
  normalizeOptions,
  computeCacheKey,
  OracleCache,
} from "../src/oracle-cache.js";
import type { CachedDecision, OracleCacheStats } from "../src/oracle-cache.js";
import type { DecisionOutcome } from "../src/types.js";

// ── normalizeQuestion ─────────────────────────────────────────

describe("normalizeQuestion", () => {
  it("strips filler words and sorts keywords", () => {
    const result = normalizeQuestion("What is the best approach for QA?");
    expect(result).toBe("approach best qa");
  });

  it("strips file paths", () => {
    const result = normalizeQuestion("Should I edit /src/foo/bar.ts or not?");
    expect(result).toBe("edit");
  });

  it("strips relative file paths", () => {
    const result = normalizeQuestion("Check ./src/components/Header.tsx for issues");
    expect(result).toBe("check issues");
  });

  it("strips numbers", () => {
    const result = normalizeQuestion("There are 2,978 vitest tests in 184 files");
    expect(result).toBe("files tests vitest");
  });

  it("strips ISO timestamps", () => {
    const result = normalizeQuestion("Last updated at 2026-03-30T12:34:56.789Z");
    expect(result).toBe("last updated");
  });

  it("strips dates", () => {
    const result = normalizeQuestion("Created on 2026-03-30");
    expect(result).toBe("created");
  });

  it("strips long backtick-quoted strings", () => {
    const result = normalizeQuestion("Error: `This is a very long error message that exceeds twenty chars` happened");
    expect(result).toBe("error happened");
  });

  it("strips long double-quoted strings", () => {
    const result = normalizeQuestion('The config says "this is a very long quoted value here" for key');
    expect(result).toBe("config key says");
  });

  it("strips long single-quoted strings", () => {
    const result = normalizeQuestion("Got 'this is a really long single quoted string here' from API");
    expect(result).toBe("api got");
  });

  it("preserves short quoted strings", () => {
    const result = normalizeQuestion("Should I use `npm` or `yarn`?");
    expect(result).toBe("npm use yarn");
  });

  it("deduplicates keywords", () => {
    const result = normalizeQuestion("test test test testing");
    expect(result).toBe("test testing");
  });

  it("handles the canonical 'CLI tool no web UI' pattern", () => {
    const v1 = normalizeQuestion(
      "GaryClaw is a CLI tool with no web UI. What should QA do?"
    );
    const v2 = normalizeQuestion(
      "This is a CLI-based tool without a web UI. How should the /qa skill approach testing?"
    );
    const v3 = normalizeQuestion(
      "The project has 2,978 vitest tests and no web UI. What QA approach works for a CLI tool?"
    );

    // All three variants should share the core keywords
    expect(v1).toContain("cli");
    expect(v1).toContain("qa");
    expect(v1).toContain("web");
    expect(v1).toContain("ui");
    expect(v2).toContain("cli");
    expect(v2).toContain("qa");
    expect(v2).toContain("web");
    expect(v2).toContain("ui");
    expect(v3).toContain("cli");
    expect(v3).toContain("qa");
    expect(v3).toContain("web");
    expect(v3).toContain("ui");
  });

  it("returns empty string for all-filler input", () => {
    const result = normalizeQuestion("is it the a an");
    expect(result).toBe("");
  });

  it("filters single-character words", () => {
    const result = normalizeQuestion("I a b c test");
    expect(result).toBe("test");
  });
});

// ── normalizeOptions ──────────────────────────────────────────

describe("normalizeOptions", () => {
  it("sorts option labels alphabetically and joins with pipe", () => {
    const result = normalizeOptions([
      { label: "Run tests" },
      { label: "Deploy" },
      { label: "Ask user" },
    ]);
    expect(result).toBe("Ask user|Deploy|Run tests");
  });

  it("handles single option", () => {
    const result = normalizeOptions([{ label: "Yes" }]);
    expect(result).toBe("Yes");
  });

  it("handles empty options", () => {
    const result = normalizeOptions([]);
    expect(result).toBe("");
  });
});

// ── computeCacheKey ───────────────────────────────────────────

describe("computeCacheKey", () => {
  it("concatenates question and options with newline", () => {
    const key = computeCacheKey("cli qa tool", "Deploy|Run tests");
    expect(key).toBe("cli qa tool\nDeploy|Run tests");
  });

  it("handles empty options", () => {
    const key = computeCacheKey("cli qa tool", "");
    expect(key).toBe("cli qa tool\n");
  });

  it("deterministic for same input", () => {
    const k1 = computeCacheKey("abc", "X|Y");
    const k2 = computeCacheKey("abc", "X|Y");
    expect(k1).toBe(k2);
  });
});

// ── OracleCache ───────────────────────────────────────────────

describe("OracleCache", () => {
  function makeCache(minHits = 5): OracleCache {
    return new OracleCache({ minHits });
  }

  const options = [
    { label: "Run tests", description: "Run the test suite" },
    { label: "Browser QA", description: "Open browser and test" },
  ];

  describe("lookup and record", () => {
    it("returns null for unknown question", () => {
      const cache = makeCache();
      expect(cache.lookup("What should I do?", options)).toBeNull();
    });

    it("does not promote before minHits", () => {
      const cache = makeCache(3);
      for (let i = 0; i < 2; i++) {
        cache.record("What should I do?", options, "Run tests");
      }
      expect(cache.lookup("What should I do?", options)).toBeNull();
    });

    it("promotes at exactly minHits", () => {
      const cache = makeCache(3);
      for (let i = 0; i < 3; i++) {
        cache.record("What should I do?", options, "Run tests", "P7");
      }
      const result = cache.lookup("What should I do?", options);
      expect(result).not.toBeNull();
      expect(result!.chosen).toBe("Run tests");
      expect(result!.confidence).toBe(10);
      expect(result!.rationale).toContain("Cached:");
      expect(result!.rationale).toContain("3 times");
      expect(result!.principle).toContain("P7");
    });

    it("increments hitCount on each lookup", () => {
      const cache = makeCache(2);
      cache.record("question", options, "Run tests", "P1");
      cache.record("question", options, "Run tests", "P1");

      const r1 = cache.lookup("question", options);
      expect(r1!.hitCount).toBe(1);

      const r2 = cache.lookup("question", options);
      expect(r2!.hitCount).toBe(2);
    });

    it("returns a copy of the cached decision (not a reference)", () => {
      const cache = makeCache(2);
      cache.record("question", options, "Run tests");
      cache.record("question", options, "Run tests");

      const r1 = cache.lookup("question", options);
      const r2 = cache.lookup("question", options);
      expect(r1).not.toBe(r2); // Different object references
    });

    it("normalizes question for matching", () => {
      const cache = makeCache(2);
      cache.record("What should I do with /src/foo.ts?", options, "Run tests");
      cache.record("What should I do with /src/bar.ts?", options, "Run tests");

      // Both normalize to the same keywords
      const result = cache.lookup("What should I do?", options);
      expect(result).not.toBeNull();
      expect(result!.chosen).toBe("Run tests");
    });

    it("only promotes the most-answered choice", () => {
      const cache = makeCache(3);
      cache.record("question", options, "Run tests");
      cache.record("question", options, "Run tests");
      cache.record("question", options, "Browser QA");
      cache.record("question", options, "Run tests"); // 3rd hit

      const result = cache.lookup("question", options);
      expect(result!.chosen).toBe("Run tests");
    });

    it("does not re-promote after invalidation even with continued recording", () => {
      const cache = makeCache(2);
      cache.record("question", options, "Run tests");
      cache.record("question", options, "Run tests");
      expect(cache.lookup("question", options)).not.toBeNull();

      cache.invalidate("question", options);
      expect(cache.lookup("question", options)).toBeNull();

      // Recording again should not immediately re-promote (counts were cleared)
      cache.record("question", options, "Run tests");
      expect(cache.lookup("question", options)).toBeNull();
    });
  });

  describe("warmFromOutcomes", () => {
    function makeOutcome(overrides: Partial<DecisionOutcome> = {}): DecisionOutcome {
      return {
        decisionId: `d-${Date.now()}`,
        timestamp: new Date().toISOString(),
        question: "What QA approach for CLI tool with no web UI?",
        chosen: "Run the test suite",
        confidence: 9,
        principle: "P7",
        outcome: "success",
        ...overrides,
      };
    }

    it("promotes answers with minHits+ identical occurrences", () => {
      const cache = makeCache(3);
      const outcomes = Array.from({ length: 3 }, () => makeOutcome());
      cache.warmFromOutcomes(outcomes);

      // Warm start uses question-only key; lookup should fall back to it
      const result = cache.lookup("What QA approach for CLI tool with no web UI?", []);
      expect(result).not.toBeNull();
      expect(result!.chosen).toBe("Run the test suite");
    });

    it("does not promote below minHits", () => {
      const cache = makeCache(5);
      const outcomes = Array.from({ length: 4 }, () => makeOutcome());
      cache.warmFromOutcomes(outcomes);

      const result = cache.lookup("What QA approach for CLI tool with no web UI?", []);
      expect(result).toBeNull();
    });

    it("handles multiple question patterns", () => {
      const cache = makeCache(2);
      const outcomes = [
        makeOutcome({ question: "Should I commit?", chosen: "Yes" }),
        makeOutcome({ question: "Should I commit?", chosen: "Yes" }),
        makeOutcome({ question: "Clean the tree?", chosen: "Skip" }),
        makeOutcome({ question: "Clean the tree?", chosen: "Skip" }),
      ];
      cache.warmFromOutcomes(outcomes);

      expect(cache.lookup("Should I commit?", [])!.chosen).toBe("Yes");
      expect(cache.lookup("Clean the tree?", [])!.chosen).toBe("Skip");
    });

    it("does not promote mixed answers", () => {
      const cache = makeCache(3);
      const outcomes = [
        makeOutcome({ chosen: "Run the test suite" }),
        makeOutcome({ chosen: "Run the test suite" }),
        makeOutcome({ chosen: "Browser test" }),
      ];
      cache.warmFromOutcomes(outcomes);

      // Neither answer has 3 hits
      const result = cache.lookup("What QA approach for CLI tool with no web UI?", []);
      expect(result).toBeNull();
    });

    it("warm start entries are accessible via question-only fallback", () => {
      const cache = makeCache(2);
      const outcomes = [
        makeOutcome({ question: "Which approach?", chosen: "Run tests" }),
        makeOutcome({ question: "Which approach?", chosen: "Run tests" }),
      ];
      cache.warmFromOutcomes(outcomes);

      // Lookup with options should fall back to question-only key
      const result = cache.lookup("Which approach?", [{ label: "Run tests" }, { label: "Deploy" }]);
      expect(result).not.toBeNull();
      expect(result!.chosen).toBe("Run tests");
    });

    it("preserves most recent principle", () => {
      const cache = makeCache(2);
      const outcomes = [
        makeOutcome({ principle: "P1" }),
        makeOutcome({ principle: "P7" }),
      ];
      cache.warmFromOutcomes(outcomes);

      const result = cache.lookup("What QA approach for CLI tool with no web UI?", []);
      expect(result!.principle).toContain("P7");
    });

    it("handles empty outcomes array", () => {
      const cache = makeCache(3);
      cache.warmFromOutcomes([]);
      expect(cache.stats().entries).toBe(0);
    });
  });

  describe("invalidate", () => {
    it("clears promoted decision", () => {
      const cache = makeCache(2);
      cache.record("question", options, "Run tests");
      cache.record("question", options, "Run tests");
      expect(cache.lookup("question", options)).not.toBeNull();

      cache.invalidate("question", options);
      expect(cache.lookup("question", options)).toBeNull();
    });

    it("clears question-only key too (warm start entries)", () => {
      const cache = makeCache(2);
      const outcomes: DecisionOutcome[] = [
        { decisionId: "d-1", timestamp: "", question: "question", chosen: "Yes", confidence: 9, principle: "P1", outcome: "success" },
        { decisionId: "d-2", timestamp: "", question: "question", chosen: "Yes", confidence: 9, principle: "P1", outcome: "success" },
      ];
      cache.warmFromOutcomes(outcomes);
      expect(cache.lookup("question", [])).not.toBeNull();

      // Invalidate with options — should also clear question-only key
      cache.invalidate("question", options);
      expect(cache.lookup("question", [])).toBeNull();
    });

    it("is a no-op for unknown question", () => {
      const cache = makeCache(2);
      // Should not throw
      cache.invalidate("never seen this", options);
      expect(cache.stats().entries).toBe(0);
    });
  });

  describe("stats", () => {
    it("tracks hits and misses", () => {
      const cache = makeCache(2);
      cache.record("deploy production server", options, "A");
      cache.record("deploy production server", options, "A");

      cache.lookup("deploy production server", options); // hit
      cache.lookup("deploy production server", options); // hit
      cache.lookup("completely unrelated question about testing", options); // miss

      const stats = cache.stats();
      expect(stats.totalHits).toBe(2);
      expect(stats.totalMisses).toBe(1);
    });

    it("counts promoted entries", () => {
      const cache = makeCache(2);
      cache.record("deploy production server", options, "A");
      cache.record("deploy production server", options, "A");
      cache.record("run integration tests", options, "B");
      cache.record("run integration tests", options, "B");

      const stats = cache.stats();
      expect(stats.entries).toBe(2);
      expect(stats.promotedEntries).toBe(2);
    });

    it("returns zeroes for fresh cache", () => {
      const stats = makeCache().stats();
      expect(stats.entries).toBe(0);
      expect(stats.promotedEntries).toBe(0);
      expect(stats.totalHits).toBe(0);
      expect(stats.totalMisses).toBe(0);
    });
  });
});
