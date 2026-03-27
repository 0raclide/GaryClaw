import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeCheckpoint,
  readCheckpoint,
  validateCheckpoint,
  generateRelayPrompt,
  estimateTokens,
} from "../src/checkpoint.js";
import {
  createMockCheckpoint,
  createMockIssue,
  createMockDecision,
  createMockFinding,
  resetCounters,
} from "./helpers.js";

const TEST_DIR = join(tmpdir(), `garyclaw-test-${Date.now()}`);

beforeEach(() => {
  resetCounters();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("checkpoint", () => {
  describe("writeCheckpoint", () => {
    it("creates a valid JSON file", () => {
      const cp = createMockCheckpoint();
      writeCheckpoint(cp, TEST_DIR);

      const path = join(TEST_DIR, "checkpoint.json");
      expect(existsSync(path)).toBe(true);

      const data = JSON.parse(readFileSync(path, "utf-8"));
      expect(data.version).toBe(1);
      expect(data.runId).toBe("test-run-001");
    });

    it("rotates previous checkpoint", () => {
      const cp1 = createMockCheckpoint({ runId: "run-1" });
      writeCheckpoint(cp1, TEST_DIR);

      const cp2 = createMockCheckpoint({ runId: "run-2" });
      writeCheckpoint(cp2, TEST_DIR);

      const currentPath = join(TEST_DIR, "checkpoint.json");
      const prevPath = join(TEST_DIR, "checkpoint.prev.json");

      expect(existsSync(prevPath)).toBe(true);

      const current = JSON.parse(readFileSync(currentPath, "utf-8"));
      const prev = JSON.parse(readFileSync(prevPath, "utf-8"));

      expect(current.runId).toBe("run-2");
      expect(prev.runId).toBe("run-1");
    });

    it("creates directory if it doesn't exist", () => {
      const nestedDir = join(TEST_DIR, "a", "b", "c");
      const cp = createMockCheckpoint();
      writeCheckpoint(cp, nestedDir);
      expect(existsSync(join(nestedDir, "checkpoint.json"))).toBe(true);
    });
  });

  describe("readCheckpoint", () => {
    it("reads a valid checkpoint", () => {
      const cp = createMockCheckpoint({ skillName: "design-review" });
      writeCheckpoint(cp, TEST_DIR);

      const result = readCheckpoint(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.skillName).toBe("design-review");
    });

    it("returns null for missing directory", () => {
      const result = readCheckpoint(join(TEST_DIR, "nonexistent"));
      expect(result).toBeNull();
    });

    it("falls back to prev when current is corrupt", () => {
      // Write valid checkpoint first
      const cp = createMockCheckpoint({ runId: "valid-prev" });
      writeCheckpoint(cp, TEST_DIR);

      // Write a second one (first becomes prev)
      const cp2 = createMockCheckpoint({ runId: "will-corrupt" });
      writeCheckpoint(cp2, TEST_DIR);

      // Corrupt current
      writeFileSync(join(TEST_DIR, "checkpoint.json"), "{invalid json", "utf-8");

      const result = readCheckpoint(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.runId).toBe("valid-prev");
    });

    it("returns null when both are corrupt", () => {
      writeFileSync(join(TEST_DIR, "checkpoint.json"), "{bad", "utf-8");
      writeFileSync(join(TEST_DIR, "checkpoint.prev.json"), "{also bad", "utf-8");

      const result = readCheckpoint(TEST_DIR);
      expect(result).toBeNull();
    });

    it("returns null when current has invalid schema", () => {
      writeFileSync(
        join(TEST_DIR, "checkpoint.json"),
        JSON.stringify({ version: 2, runId: "wrong-version" }),
        "utf-8",
      );

      const result = readCheckpoint(TEST_DIR);
      expect(result).toBeNull();
    });
  });

  describe("validateCheckpoint", () => {
    it("accepts valid checkpoint", () => {
      const cp = createMockCheckpoint();
      expect(validateCheckpoint(cp)).toBe(true);
    });

    it("rejects null", () => {
      expect(validateCheckpoint(null)).toBe(false);
    });

    it("rejects wrong version", () => {
      const cp = createMockCheckpoint();
      (cp as any).version = 2;
      expect(validateCheckpoint(cp)).toBe(false);
    });

    it("rejects missing required fields", () => {
      expect(validateCheckpoint({ version: 1 })).toBe(false);
      expect(validateCheckpoint({ version: 1, timestamp: "x" })).toBe(false);
    });

    it("rejects non-object", () => {
      expect(validateCheckpoint("string")).toBe(false);
      expect(validateCheckpoint(42)).toBe(false);
    });

    it("accepts checkpoint without codebaseSummary (backward compatible)", () => {
      const cp = createMockCheckpoint();
      expect(validateCheckpoint(cp)).toBe(true);
      expect(cp.codebaseSummary).toBeUndefined();
    });

    it("accepts checkpoint with valid codebaseSummary", () => {
      const cp = createMockCheckpoint({
        codebaseSummary: {
          observations: ["Uses kebab-case"],
          failedApproaches: ["Tried X but Y"],
          lastSessionIndex: 1,
        },
      });
      expect(validateCheckpoint(cp)).toBe(true);
    });

    it("rejects checkpoint with invalid codebaseSummary (not an object)", () => {
      const cp = createMockCheckpoint() as any;
      cp.codebaseSummary = "invalid";
      expect(validateCheckpoint(cp)).toBe(false);
    });

    it("rejects checkpoint with invalid codebaseSummary (null)", () => {
      const cp = createMockCheckpoint() as any;
      cp.codebaseSummary = null;
      expect(validateCheckpoint(cp)).toBe(false);
    });

    it("rejects checkpoint with codebaseSummary missing observations array", () => {
      const cp = createMockCheckpoint() as any;
      cp.codebaseSummary = { failedApproaches: [], lastSessionIndex: 0 };
      expect(validateCheckpoint(cp)).toBe(false);
    });

    it("rejects checkpoint with codebaseSummary missing failedApproaches array", () => {
      const cp = createMockCheckpoint() as any;
      cp.codebaseSummary = { observations: [], lastSessionIndex: 0 };
      expect(validateCheckpoint(cp)).toBe(false);
    });

    it("rejects checkpoint with codebaseSummary missing lastSessionIndex", () => {
      const cp = createMockCheckpoint() as any;
      cp.codebaseSummary = { observations: [], failedApproaches: [] };
      expect(validateCheckpoint(cp)).toBe(false);
    });
  });

  describe("generateRelayPrompt", () => {
    it("includes open issues in full", () => {
      const cp = createMockCheckpoint({
        issues: [
          createMockIssue({ status: "open", description: "Nav menu overlap bug", severity: "critical" }),
        ],
      });
      const prompt = generateRelayPrompt(cp);
      expect(prompt).toContain("Nav menu overlap bug");
      expect(prompt).toContain("[critical]");
      expect(prompt).toContain("Open Issues (1 remaining)");
    });

    it("includes recently fixed in full", () => {
      const issues = Array.from({ length: 3 }, (_, i) =>
        createMockIssue({ status: "fixed", fixCommit: `abc${i}` }),
      );
      const cp = createMockCheckpoint({ issues });
      const prompt = generateRelayPrompt(cp);
      expect(prompt).toContain("Recently Fixed");
      expect(prompt).toContain("abc0");
    });

    it("summarizes older fixed issues", () => {
      // 8 fixed: last 5 get full treatment, first 3 summarized
      const issues = Array.from({ length: 8 }, (_, i) =>
        createMockIssue({
          status: "fixed",
          fixCommit: `fix${i}`,
          description: `Issue number ${i} with a long description`,
        }),
      );
      const cp = createMockCheckpoint({ issues });
      const prompt = generateRelayPrompt(cp);
      expect(prompt).toContain("Previously Fixed (3 summarized)");
      expect(prompt).toContain("Recently Fixed");
    });

    it("includes decisions with tiered treatment", () => {
      const decisions = Array.from({ length: 8 }, (_, i) =>
        createMockDecision({
          question: `Decision question number ${i}?`,
          chosen: `Option ${i}`,
        }),
      );
      const cp = createMockCheckpoint({ decisions });
      const prompt = generateRelayPrompt(cp);
      expect(prompt).toContain("Recent Decisions");
      expect(prompt).toContain("Older Decisions (3 summarized)");
    });

    it("includes findings", () => {
      const cp = createMockCheckpoint({
        findings: [createMockFinding({ description: "Performance issue detected", category: "performance" })],
      });
      const prompt = generateRelayPrompt(cp);
      expect(prompt).toContain("[performance] Performance issue detected");
    });

    it("stays under 10K tokens with 30 issues", () => {
      const openIssues = Array.from({ length: 12 }, (_, i) =>
        createMockIssue({
          status: "open",
          description: `Navigation menu z-index causes overlap with modal dialog on mobile viewports - issue variant ${i}`,
        }),
      );
      const fixedIssues = Array.from({ length: 18 }, (_, i) =>
        createMockIssue({
          status: "fixed",
          fixCommit: `abc${i}`,
          description: `Form submit button disabled after validation error even when fields corrected - variant ${i}`,
        }),
      );
      const decisions = Array.from({ length: 10 }, (_, i) =>
        createMockDecision({ question: `Should we restructure the stacking context for variant ${i}?` }),
      );

      const cp = createMockCheckpoint({
        issues: [...openIssues, ...fixedIssues],
        decisions,
      });

      const prompt = generateRelayPrompt(cp);
      const tokens = estimateTokens(prompt);
      expect(tokens).toBeLessThan(10_000);
    });

    it("truncates oldest fixed when over budget", () => {
      // Create many issues to push over budget with a very low max
      const fixedIssues = Array.from({ length: 50 }, (_, i) =>
        createMockIssue({
          status: "fixed",
          fixCommit: `fix${i}`,
          description: `A very long description that takes up space for issue ${i}. Lorem ipsum dolor sit amet.`,
        }),
      );
      const cp = createMockCheckpoint({ issues: fixedIssues });

      // Very tight budget
      const prompt = generateRelayPrompt(cp, { maxTokens: 500 });
      const tokens = estimateTokens(prompt);
      expect(tokens).toBeLessThanOrEqual(500);
    });

    it("includes skipped/deferred issues", () => {
      const cp = createMockCheckpoint({
        issues: [createMockIssue({ status: "skipped", description: "Low priority cosmetic" })],
      });
      const prompt = generateRelayPrompt(cp);
      expect(prompt).toContain("Skipped/Deferred");
      expect(prompt).toContain("Low priority cosmetic");
    });

    it("includes session context metadata", () => {
      const cp = createMockCheckpoint({
        runId: "run-42",
        skillName: "qa",
        gitBranch: "feature/fix",
        gitHead: "deadbeef",
      });
      const prompt = generateRelayPrompt(cp);
      expect(prompt).toContain("run-42");
      expect(prompt).toContain("feature/fix");
      expect(prompt).toContain("deadbeef");
      expect(prompt).toContain("Continuing qa Run");
    });

    it("includes codebase summary section when present", () => {
      const cp = createMockCheckpoint({
        codebaseSummary: {
          observations: ["Uses kebab-case naming", "Types in types.ts with zero imports"],
          failedApproaches: ["Tried require() but failed in ESM"],
          lastSessionIndex: 2,
        },
      });
      const prompt = generateRelayPrompt(cp);
      expect(prompt).toContain("Codebase Context (carried from sessions 0-2)");
      expect(prompt).toContain("Approaches that failed");
      expect(prompt).toContain("Tried require() but failed in ESM");
      expect(prompt).toContain("Observations:");
      expect(prompt).toContain("Uses kebab-case naming");
    });

    it("omits codebase summary section when not present", () => {
      const cp = createMockCheckpoint();
      const prompt = generateRelayPrompt(cp);
      expect(prompt).not.toContain("Codebase Context");
    });

    it("relay prompt with summary stays under 10K tokens", () => {
      const cp = createMockCheckpoint({
        issues: Array.from({ length: 10 }, (_, i) =>
          createMockIssue({ status: "open", description: `Issue ${i} description` }),
        ),
        codebaseSummary: {
          observations: Array.from({ length: 20 }, (_, i) => `Observation ${i}: this is a codebase pattern`),
          failedApproaches: Array.from({ length: 5 }, (_, i) => `Failed approach ${i}: tried X but Y`),
          lastSessionIndex: 3,
        },
      });
      const prompt = generateRelayPrompt(cp);
      expect(estimateTokens(prompt)).toBeLessThan(10_000);
    });
  });

  describe("estimateTokens", () => {
    it("estimates token count from text length", () => {
      // 350 chars / 3.5 = 100 tokens
      const text = "a".repeat(350);
      expect(estimateTokens(text)).toBe(100);
    });

    it("rounds up", () => {
      expect(estimateTokens("ab")).toBe(1); // 2/3.5 = 0.57 → ceil = 1
    });

    it("returns 0 for empty string", () => {
      expect(estimateTokens("")).toBe(0);
    });
  });
});
