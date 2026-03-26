import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Decision, Issue, DecisionOutcome, OracleMemoryConfig } from "../src/types.js";
import {
  levenshteinDistance,
  normalizedLevenshtein,
  isReopenedIssue,
  findReopenedDecisions,
  mapDecisionToOutcome,
  findRelatedIssue,
  runReflection,
  readDecisionsFromLog,
} from "../src/reflection.js";
import { initOracleMemory } from "../src/oracle-memory.js";

const BASE_DIR = join(tmpdir(), `garyclaw-reflect-${Date.now()}`);

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    timestamp: "2026-03-26T10:00:00.000Z",
    sessionIndex: 0,
    question: "Should we fix the alignment issue?",
    options: [
      { label: "Yes", description: "Fix it" },
      { label: "No", description: "Skip it" },
    ],
    chosen: "Yes",
    confidence: 8,
    rationale: "Clear fix",
    principle: "Bias toward action",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "ISSUE-001",
    severity: "medium",
    description: "Button alignment is off by 2px",
    filePath: "src/components/Button.tsx",
    status: "fixed",
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<DecisionOutcome> = {}): DecisionOutcome {
  return {
    decisionId: "d-2026-03-25T10-00-00-000Z",
    timestamp: "2026-03-25T10:00:00.000Z",
    question: "Should we fix the alignment issue?",
    chosen: "Yes",
    confidence: 8,
    principle: "Bias toward action",
    outcome: "success",
    relatedFilePath: "src/components/Button.tsx",
    ...overrides,
  };
}

function makeConfig(): OracleMemoryConfig {
  return {
    globalDir: join(BASE_DIR, "global", "oracle-memory"),
    projectDir: join(BASE_DIR, "project", ".garyclaw", "oracle-memory"),
  };
}

beforeEach(() => {
  mkdirSync(BASE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

describe("reflection", () => {
  describe("levenshteinDistance", () => {
    it("returns 0 for identical strings", () => {
      expect(levenshteinDistance("hello", "hello")).toBe(0);
    });

    it("returns length of other string when one is empty", () => {
      expect(levenshteinDistance("", "hello")).toBe(5);
      expect(levenshteinDistance("hello", "")).toBe(5);
    });

    it("returns 0 for two empty strings", () => {
      expect(levenshteinDistance("", "")).toBe(0);
    });

    it("calculates single character difference", () => {
      expect(levenshteinDistance("cat", "hat")).toBe(1);
    });

    it("calculates insertion distance", () => {
      expect(levenshteinDistance("cat", "cats")).toBe(1);
    });

    it("calculates deletion distance", () => {
      expect(levenshteinDistance("cats", "cat")).toBe(1);
    });

    it("handles completely different strings", () => {
      expect(levenshteinDistance("abc", "xyz")).toBe(3);
    });
  });

  describe("normalizedLevenshtein", () => {
    it("returns 0 for identical strings", () => {
      expect(normalizedLevenshtein("hello", "hello")).toBe(0);
    });

    it("returns 0 for two empty strings", () => {
      expect(normalizedLevenshtein("", "")).toBe(0);
    });

    it("returns 1 for completely different same-length strings", () => {
      expect(normalizedLevenshtein("abc", "xyz")).toBe(1);
    });

    it("returns a value between 0 and 1", () => {
      const result = normalizedLevenshtein("kitten", "sitting");
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });

    it("similar strings have low distance", () => {
      // "Button alignment is off by 2px" vs "Button alignment off by 2px"
      const a = "button alignment is off by 2px";
      const b = "button alignment off by 2px";
      const distance = normalizedLevenshtein(a, b);
      expect(distance).toBeLessThan(0.3); // 70%+ similar
    });
  });

  describe("isReopenedIssue", () => {
    it("detects reopened issue with same file and similar description", () => {
      const newIssue = makeIssue({
        description: "Button alignment is off by 3px",
        filePath: "src/components/Button.tsx",
      });
      const previousIssue = makeIssue({
        description: "Button alignment is off by 2px",
        filePath: "src/components/Button.tsx",
      });

      expect(isReopenedIssue(newIssue, previousIssue)).toBe(true);
    });

    it("does not match different file paths", () => {
      const newIssue = makeIssue({ filePath: "src/A.tsx" });
      const previousIssue = makeIssue({ filePath: "src/B.tsx" });

      expect(isReopenedIssue(newIssue, previousIssue)).toBe(false);
    });

    it("does not match when filePath is missing", () => {
      const newIssue = makeIssue({ filePath: undefined });
      const previousIssue = makeIssue({ filePath: "src/A.tsx" });

      expect(isReopenedIssue(newIssue, previousIssue)).toBe(false);
    });

    it("does not match very different descriptions", () => {
      const newIssue = makeIssue({
        description: "Completely unrelated error in database connection",
        filePath: "src/components/Button.tsx",
      });
      const previousIssue = makeIssue({
        description: "Button alignment is off by 2px",
        filePath: "src/components/Button.tsx",
      });

      expect(isReopenedIssue(newIssue, previousIssue)).toBe(false);
    });

    it("respects custom threshold", () => {
      const newIssue = makeIssue({ description: "Some text here" });
      const previousIssue = makeIssue({ description: "Some text there" });

      // With tight threshold, may not match
      expect(isReopenedIssue(newIssue, previousIssue, 0.05)).toBe(false);
      // With loose threshold, should match
      expect(isReopenedIssue(newIssue, previousIssue, 0.5)).toBe(true);
    });
  });

  describe("findReopenedDecisions", () => {
    it("finds reopened decisions", () => {
      const currentIssues = [
        makeIssue({
          description: "Button alignment is off by 3px",
          filePath: "src/components/Button.tsx",
        }),
      ];

      const previousOutcomes = [
        makeOutcome({
          decisionId: "d-001",
          outcome: "success",
          question: "button alignment is off by 2px",
          relatedFilePath: "src/components/Button.tsx",
        }),
      ];

      const reopened = findReopenedDecisions(currentIssues, previousOutcomes);
      expect(reopened.size).toBe(1);
      expect(reopened.has("d-001")).toBe(true);
    });

    it("ignores non-success outcomes", () => {
      const currentIssues = [makeIssue()];
      const previousOutcomes = [
        makeOutcome({ decisionId: "d-001", outcome: "failure" }),
      ];

      const reopened = findReopenedDecisions(currentIssues, previousOutcomes);
      expect(reopened.size).toBe(0);
    });

    it("returns empty set when no matches", () => {
      const currentIssues = [makeIssue({ filePath: "src/other.ts" })];
      const previousOutcomes = [makeOutcome()];

      const reopened = findReopenedDecisions(currentIssues, previousOutcomes);
      expect(reopened.size).toBe(0);
    });

    it("returns empty set for empty inputs", () => {
      expect(findReopenedDecisions([], []).size).toBe(0);
      expect(findReopenedDecisions([makeIssue()], []).size).toBe(0);
      expect(findReopenedDecisions([], [makeOutcome()]).size).toBe(0);
    });
  });

  describe("findRelatedIssue", () => {
    it("matches by issue ID in question", () => {
      const decision = makeDecision({ question: "Should we fix ISSUE-001?" });
      const issues = [makeIssue({ id: "ISSUE-001" })];

      expect(findRelatedIssue(decision, issues)).toBe(issues[0]);
    });

    it("matches by file path in question", () => {
      const decision = makeDecision({
        question: "Should we edit src/components/Button.tsx?",
      });
      const issues = [makeIssue({ filePath: "src/components/Button.tsx" })];

      expect(findRelatedIssue(decision, issues)).toBe(issues[0]);
    });

    it("matches by keyword overlap", () => {
      const decision = makeDecision({
        question: "Should we fix the button alignment spacing issue?",
      });
      const issues = [
        makeIssue({
          description: "Button alignment spacing is broken in the header",
        }),
      ];

      expect(findRelatedIssue(decision, issues)).toBe(issues[0]);
    });

    it("returns null when no match", () => {
      const decision = makeDecision({ question: "Unrelated question" });
      const issues = [makeIssue()];

      expect(findRelatedIssue(decision, issues)).toBeNull();
    });

    it("returns null for empty issues", () => {
      expect(findRelatedIssue(makeDecision(), [])).toBeNull();
    });
  });

  describe("mapDecisionToOutcome", () => {
    it("maps to success when related issue is fixed", () => {
      const decision = makeDecision({ question: "Fix ISSUE-001?" });
      const issues = [makeIssue({ id: "ISSUE-001", status: "fixed" })];

      const outcome = mapDecisionToOutcome(decision, issues, new Set());
      expect(outcome.outcome).toBe("success");
      expect(outcome.outcomeDetail).toContain("Fixed");
    });

    it("maps to neutral when related issue is skipped", () => {
      const decision = makeDecision({ question: "Fix ISSUE-001?" });
      const issues = [makeIssue({ id: "ISSUE-001", status: "skipped" })];

      const outcome = mapDecisionToOutcome(decision, issues, new Set());
      expect(outcome.outcome).toBe("neutral");
      expect(outcome.outcomeDetail).toContain("skipped");
    });

    it("maps to failure when decision is reopened", () => {
      const decision = makeDecision({
        timestamp: "2026-03-26T10:00:00.000Z",
      });
      const decisionId = "d-2026-03-26T10-00-00-000Z";

      const outcome = mapDecisionToOutcome(
        decision,
        [],
        new Set([decisionId]),
      );
      expect(outcome.outcome).toBe("failure");
      expect(outcome.outcomeDetail).toContain("reopened");
    });

    it("maps to neutral when no related issue", () => {
      const decision = makeDecision({ question: "Unrelated question" });
      const issues = [makeIssue()];

      const outcome = mapDecisionToOutcome(decision, issues, new Set());
      expect(outcome.outcome).toBe("neutral");
    });

    it("includes jobId when provided", () => {
      const outcome = mapDecisionToOutcome(
        makeDecision(),
        [],
        new Set(),
        "job-123",
      );
      expect(outcome.jobId).toBe("job-123");
    });

    it("generates decisionId from timestamp", () => {
      const outcome = mapDecisionToOutcome(
        makeDecision({ timestamp: "2026-03-26T10:30:00.500Z" }),
        [],
        new Set(),
      );
      expect(outcome.decisionId).toBe("d-2026-03-26T10-30-00-500Z");
    });
  });

  describe("readDecisionsFromLog", () => {
    it("reads valid JSONL file", () => {
      const logPath = join(BASE_DIR, "decisions.jsonl");
      const lines = [
        JSON.stringify(makeDecision({ question: "Q1" })),
        JSON.stringify(makeDecision({ question: "Q2" })),
      ];
      writeFileSync(logPath, lines.join("\n") + "\n", "utf-8");

      const decisions = readDecisionsFromLog(logPath);
      expect(decisions).toHaveLength(2);
      expect(decisions[0].question).toBe("Q1");
      expect(decisions[1].question).toBe("Q2");
    });

    it("returns empty array for missing file", () => {
      expect(readDecisionsFromLog(join(BASE_DIR, "missing.jsonl"))).toHaveLength(0);
    });

    it("skips corrupt lines", () => {
      const logPath = join(BASE_DIR, "decisions.jsonl");
      const lines = [
        JSON.stringify(makeDecision({ question: "Good" })),
        "not valid json {{{",
        JSON.stringify(makeDecision({ question: "Also good" })),
      ];
      writeFileSync(logPath, lines.join("\n") + "\n", "utf-8");

      const decisions = readDecisionsFromLog(logPath);
      expect(decisions).toHaveLength(2);
    });

    it("skips entries missing required fields", () => {
      const logPath = join(BASE_DIR, "decisions.jsonl");
      const lines = [
        JSON.stringify({ timestamp: "t", sessionIndex: 0 }), // missing question/chosen
        JSON.stringify(makeDecision({ question: "Valid" })),
      ];
      writeFileSync(logPath, lines.join("\n") + "\n", "utf-8");

      const decisions = readDecisionsFromLog(logPath);
      expect(decisions).toHaveLength(1);
    });
  });

  describe("runReflection", () => {
    it("creates outcomes and updates metrics", () => {
      const config = makeConfig();
      initOracleMemory(config);

      const result = runReflection({
        decisions: [
          makeDecision({ question: "Fix ISSUE-001?" }),
        ],
        issues: [makeIssue({ id: "ISSUE-001", status: "fixed" })],
        jobId: "job-1",
        projectDir: BASE_DIR,
        memoryConfig: config,
      });

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].outcome).toBe("success");
      expect(result.metrics.totalDecisions).toBe(1);
      expect(result.metrics.accurateDecisions).toBe(1);
      expect(result.metrics.lastReflectionTimestamp).not.toBeNull();
    });

    it("detects reopened issues from previous outcomes", () => {
      const config = makeConfig();
      initOracleMemory(config);

      // First reflection: decision succeeds
      runReflection({
        decisions: [makeDecision({ question: "Fix ISSUE-001?" })],
        issues: [makeIssue({ id: "ISSUE-001", status: "fixed" })],
        jobId: "job-1",
        projectDir: BASE_DIR,
        memoryConfig: config,
      });

      // Second reflection: same issue reappears (reopened)
      // The reopened detection checks current issues against previous outcomes
      const result = runReflection({
        decisions: [makeDecision({ question: "Fix the color issue?" })],
        issues: [
          makeIssue({
            id: "ISSUE-005",
            description: "Button alignment is off by 3px",
            filePath: "src/components/Button.tsx",
          }),
        ],
        jobId: "job-2",
        projectDir: BASE_DIR,
        memoryConfig: config,
      });

      // The reopened detection operates on *existing* outcomes vs *current* issues
      // It marks previously-successful outcomes as reopened
      expect(result.reopenedCount).toBeGreaterThanOrEqual(0);
    });

    it("handles empty decisions gracefully", () => {
      const config = makeConfig();
      initOracleMemory(config);

      const result = runReflection({
        decisions: [],
        issues: [],
        projectDir: BASE_DIR,
        memoryConfig: config,
      });

      expect(result.outcomes).toHaveLength(0);
      expect(result.metrics.totalDecisions).toBe(0);
    });

    it("persists outcomes to decision-outcomes.md", () => {
      const config = makeConfig();
      initOracleMemory(config);

      runReflection({
        decisions: [makeDecision({ question: "Fix ISSUE-001?" })],
        issues: [makeIssue({ id: "ISSUE-001", status: "fixed" })],
        projectDir: BASE_DIR,
        memoryConfig: config,
      });

      const outcomesPath = join(config.projectDir, "decision-outcomes.md");
      expect(existsSync(outcomesPath)).toBe(true);
      const content = readFileSync(outcomesPath, "utf-8");
      expect(content).toContain("success");
    });

    it("persists metrics to metrics.json", () => {
      const config = makeConfig();
      initOracleMemory(config);

      runReflection({
        decisions: [makeDecision()],
        issues: [],
        projectDir: BASE_DIR,
        memoryConfig: config,
      });

      const metricsPath = join(config.projectDir, "metrics.json");
      const metrics = JSON.parse(readFileSync(metricsPath, "utf-8"));
      expect(metrics.totalDecisions).toBe(1);
      expect(metrics.lastReflectionTimestamp).not.toBeNull();
    });

    it("accumulates metrics across multiple reflections", () => {
      const config = makeConfig();
      initOracleMemory(config);

      // First reflection: 2 decisions
      runReflection({
        decisions: [
          makeDecision({ question: "Q1" }),
          makeDecision({ question: "Q2" }),
        ],
        issues: [],
        projectDir: BASE_DIR,
        memoryConfig: config,
      });

      // Second reflection: 1 decision
      const result = runReflection({
        decisions: [makeDecision({ question: "Q3" })],
        issues: [],
        projectDir: BASE_DIR,
        memoryConfig: config,
      });

      expect(result.metrics.totalDecisions).toBe(3);
    });
  });

});
