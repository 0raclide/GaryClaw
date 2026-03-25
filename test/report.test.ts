import { describe, it, expect, beforeEach } from "vitest";
import {
  mergeIssues,
  mergeFindings,
  mergeDecisions,
  buildReport,
  formatReportMarkdown,
} from "../src/report.js";
import {
  createMockCheckpoint,
  createMockIssue,
  createMockFinding,
  createMockDecision,
  resetCounters,
} from "./helpers.js";

beforeEach(() => {
  resetCounters();
});

describe("report", () => {
  describe("mergeIssues", () => {
    it("merges issues from multiple checkpoints", () => {
      const cp1 = createMockCheckpoint({
        issues: [
          createMockIssue({ id: "QA-001", status: "open" }),
          createMockIssue({ id: "QA-002", status: "open" }),
        ],
      });
      const cp2 = createMockCheckpoint({
        issues: [
          createMockIssue({ id: "QA-003", status: "open" }),
        ],
      });

      const merged = mergeIssues([cp1, cp2]);
      expect(merged).toHaveLength(3);
    });

    it("deduplicates by id, later session wins", () => {
      const cp1 = createMockCheckpoint({
        issues: [
          createMockIssue({ id: "QA-001", status: "open", description: "old desc" }),
        ],
      });
      const cp2 = createMockCheckpoint({
        issues: [
          createMockIssue({ id: "QA-001", status: "fixed", description: "new desc", fixCommit: "abc" }),
        ],
      });

      const merged = mergeIssues([cp1, cp2]);
      expect(merged).toHaveLength(1);
      expect(merged[0].status).toBe("fixed");
      expect(merged[0].description).toBe("new desc");
      expect(merged[0].fixCommit).toBe("abc");
    });

    it("handles empty checkpoints", () => {
      const merged = mergeIssues([]);
      expect(merged).toEqual([]);
    });

    it("handles checkpoints with no issues", () => {
      const cp = createMockCheckpoint({ issues: [] });
      const merged = mergeIssues([cp]);
      expect(merged).toEqual([]);
    });
  });

  describe("mergeFindings", () => {
    it("merges findings from multiple checkpoints", () => {
      const cp1 = createMockCheckpoint({
        findings: [createMockFinding({ description: "Finding A" })],
      });
      const cp2 = createMockCheckpoint({
        findings: [createMockFinding({ description: "Finding B" })],
      });

      const merged = mergeFindings([cp1, cp2]);
      expect(merged).toHaveLength(2);
    });

    it("deduplicates by normalized description", () => {
      const cp1 = createMockCheckpoint({
        findings: [createMockFinding({ description: "Performance Issue" })],
      });
      const cp2 = createMockCheckpoint({
        findings: [createMockFinding({ description: "performance issue" })],
      });

      const merged = mergeFindings([cp1, cp2]);
      expect(merged).toHaveLength(1);
    });

    it("handles empty array", () => {
      expect(mergeFindings([])).toEqual([]);
    });
  });

  describe("mergeDecisions", () => {
    it("concatenates all decisions without dedup", () => {
      const cp1 = createMockCheckpoint({
        decisions: [createMockDecision({ question: "Q1?" })],
      });
      const cp2 = createMockCheckpoint({
        decisions: [createMockDecision({ question: "Q1?" })], // Same question, different timestamp
      });

      const merged = mergeDecisions([cp1, cp2]);
      expect(merged).toHaveLength(2);
    });

    it("handles empty array", () => {
      expect(mergeDecisions([])).toEqual([]);
    });
  });

  describe("buildReport", () => {
    it("combines all merged data with metadata", () => {
      const cp1 = createMockCheckpoint({
        issues: [createMockIssue({ id: "QA-001", status: "open" })],
        findings: [createMockFinding()],
        decisions: [createMockDecision()],
      });
      const cp2 = createMockCheckpoint({
        issues: [
          createMockIssue({ id: "QA-001", status: "fixed" }),
          createMockIssue({ id: "QA-002", status: "open" }),
        ],
        findings: [createMockFinding({ description: "New finding" })],
        decisions: [createMockDecision()],
      });

      const report = buildReport([cp1, cp2], {
        runId: "run-42",
        skillName: "qa",
        startTime: "2026-03-25T10:00:00Z",
        endTime: "2026-03-25T10:30:00Z",
        totalSessions: 2,
        totalTurns: 25,
        estimatedCostUsd: 0.15,
        relayPoints: [
          { sessionIndex: 0, timestamp: "2026-03-25T10:15:00Z", reason: "context at 87%", contextSize: 870_000 },
        ],
      });

      expect(report.runId).toBe("run-42");
      expect(report.issues).toHaveLength(2); // QA-001 deduped
      expect(report.issues.find((i) => i.id === "QA-001")!.status).toBe("fixed");
      expect(report.findings.length).toBeGreaterThanOrEqual(1);
      expect(report.decisions).toHaveLength(2);
      expect(report.relayPoints).toHaveLength(1);
      expect(report.totalSessions).toBe(2);
    });
  });

  describe("formatReportMarkdown", () => {
    it("generates readable markdown", () => {
      const report = buildReport(
        [
          createMockCheckpoint({
            issues: [
              createMockIssue({ id: "QA-001", status: "fixed", severity: "critical", fixCommit: "abc123" }),
              createMockIssue({ id: "QA-002", status: "open", severity: "high" }),
            ],
            findings: [createMockFinding({ category: "performance", description: "Slow API" })],
            decisions: [createMockDecision({ question: "Fix approach?", chosen: "Option A" })],
          }),
        ],
        {
          runId: "run-1",
          skillName: "qa",
          startTime: "2026-03-25T10:00:00Z",
          endTime: "2026-03-25T10:30:00Z",
          totalSessions: 1,
          totalTurns: 15,
          estimatedCostUsd: 0.045,
          relayPoints: [],
        },
      );

      const md = formatReportMarkdown(report);

      expect(md).toContain("# GaryClaw Run Report — qa");
      expect(md).toContain("run-1");
      expect(md).toContain("$0.045");
      expect(md).toContain("## Issues Summary");
      expect(md).toContain("| Fixed | 1 |");
      expect(md).toContain("| Open | 1 |");
      expect(md).toContain("## Open Issues (1)");
      expect(md).toContain("## Fixed Issues (1)");
      expect(md).toContain("## Findings (1)");
      expect(md).toContain("[performance]");
      expect(md).toContain("## Decisions (1)");
      expect(md).toContain("Generated by GaryClaw");
    });

    it("includes relay points when present", () => {
      const report = buildReport([], {
        runId: "run-1",
        skillName: "qa",
        startTime: "2026-03-25T10:00:00Z",
        endTime: "2026-03-25T10:30:00Z",
        totalSessions: 2,
        totalTurns: 30,
        estimatedCostUsd: 0.09,
        relayPoints: [
          { sessionIndex: 0, timestamp: "t", reason: "context at 87%", contextSize: 870_000 },
        ],
      });

      const md = formatReportMarkdown(report);
      expect(md).toContain("## Relay Points (1)");
      expect(md).toContain("870K tokens");
    });

    it("omits sections with no data", () => {
      const report = buildReport([], {
        runId: "run-1",
        skillName: "qa",
        startTime: "t1",
        endTime: "t2",
        totalSessions: 1,
        totalTurns: 5,
        estimatedCostUsd: 0,
        relayPoints: [],
      });

      const md = formatReportMarkdown(report);
      expect(md).not.toContain("## Open Issues");
      expect(md).not.toContain("## Fixed Issues");
      expect(md).not.toContain("## Findings");
      expect(md).not.toContain("## Relay Points");
      expect(md).not.toContain("## Decisions");
    });
  });
});
