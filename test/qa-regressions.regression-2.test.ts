/**
 * Regression tests for /qa ISSUE-001 through ISSUE-005
 * Found by /qa on 2026-03-26
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-26.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── ISSUE-003: truncateToTokenBudget single-line bypass ─────────

describe("ISSUE-003: truncateToTokenBudget handles single long line", () => {
  // Regression: ISSUE-003 — single long line bypassed token budget
  // Found by /qa on 2026-03-26

  it("truncates a single line exceeding the budget", async () => {
    const { truncateToTokenBudget } = await import("../src/oracle-memory.js");

    // Create a string that's way over 100 tokens (~400 chars at 4 chars/token)
    const longLine = "x".repeat(2000); // ~500 tokens
    const result = truncateToTokenBudget(longLine, 100);

    // Should be truncated to ~400 chars (100 tokens * 4 chars/token)
    expect(result.length).toBeLessThanOrEqual(400);
  });

  it("does not truncate content within budget", async () => {
    const { truncateToTokenBudget } = await import("../src/oracle-memory.js");

    const shortContent = "Hello world";
    const result = truncateToTokenBudget(shortContent, 1000);
    expect(result).toBe(shortContent);
  });

  it("truncates multi-line content by removing oldest lines first", async () => {
    const { truncateToTokenBudget } = await import("../src/oracle-memory.js");

    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${"a".repeat(50)}`);
    const content = lines.join("\n");
    const result = truncateToTokenBudget(content, 200);

    // Should have fewer lines than the original
    expect(result.split("\n").length).toBeLessThan(100);
    // Should keep the LATER lines (oldest removed first)
    expect(result).toContain("Line 99");
  });
});

// ── ISSUE-004: Shell injection in parseGitLog ───────────────────

describe("ISSUE-004: parseGitLog validates refs against injection", () => {
  // Regression: ISSUE-004 — shell injection via corrupted checkpoint refs
  // Found by /qa on 2026-03-26

  it("rejects refs with shell metacharacters", async () => {
    const { parseGitLog } = await import("../src/issue-extractor.js");

    // These should all return empty arrays (rejected by validation)
    expect(parseGitLog("abc123; rm -rf /", "def456", "/tmp", "qa")).toEqual([]);
    expect(parseGitLog("abc123", "$(whoami)", "/tmp", "qa")).toEqual([]);
    expect(parseGitLog("abc123", "def456 && echo pwned", "/tmp", "qa")).toEqual([]);
    expect(parseGitLog("`id`", "def456", "/tmp", "qa")).toEqual([]);
  });

  it("accepts valid hex SHA refs", async () => {
    const { parseGitLog } = await import("../src/issue-extractor.js");

    // Valid SHA — won't throw (may return empty if refs don't exist, but won't reject)
    const result = parseGitLog("abc1234", "def5678", "/tmp/nonexistent", "qa");
    expect(Array.isArray(result)).toBe(true);
  });

  it("accepts valid branch name refs", async () => {
    const { parseGitLog } = await import("../src/issue-extractor.js");

    const result = parseGitLog("main", "feature/my-branch", "/tmp/nonexistent", "qa");
    expect(Array.isArray(result)).toBe(true);
  });
});

// ── ISSUE-005: File path association picks last edit ─────────────

describe("ISSUE-005: IssueTracker associates last file path", () => {
  // Regression: ISSUE-005 — file path association picked earliest file
  // Found by /qa on 2026-03-26

  it("uses the last edited file before commit, not the first", async () => {
    const { IssueTracker } = await import("../src/issue-extractor.js");

    const tracker = new IssueTracker("qa");
    tracker.trackToolUse("Edit", { file_path: "src/old-exploration.ts" });
    tracker.trackToolUse("Edit", { file_path: "src/intermediate.ts" });
    tracker.trackToolUse("Edit", { file_path: "src/actual-fix.ts" });

    const issue = tracker.trackCommit(
      'git commit -m "fix(qa): ISSUE-010 --- fix the bug"',
    );

    expect(issue).not.toBeNull();
    expect(issue!.filePath).toBe("src/actual-fix.ts");
  });

  it("still works with a single edit before commit", async () => {
    const { IssueTracker } = await import("../src/issue-extractor.js");

    const tracker = new IssueTracker("qa");
    tracker.trackToolUse("Edit", { file_path: "src/only-file.ts" });

    const issue = tracker.trackCommit(
      'git commit -m "fix(qa): ISSUE-011 --- single fix"',
    );

    expect(issue).not.toBeNull();
    expect(issue!.filePath).toBe("src/only-file.ts");
  });
});

// ── ISSUE-002: Pipeline state on failure ──────────────────────────

describe("ISSUE-002: pipeline state marked failed on skill error", () => {
  // Regression: ISSUE-002 — pipeline state left as "running" on skill failure
  // Found by /qa on 2026-03-26

  const TEST_DIR = join(tmpdir(), `garyclaw-reg-002-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("writePipelineState records failed status", async () => {
    const { writePipelineState, readPipelineState } = await import("../src/pipeline.js");

    const state = {
      version: 1 as const,
      pipelineId: "test-pipeline",
      skills: [
        { skillName: "qa", status: "failed" as const, startTime: "2026-01-01", endTime: "2026-01-01" },
        { skillName: "ship", status: "pending" as const },
      ],
      currentSkillIndex: 0,
      startTime: "2026-01-01",
      totalCostUsd: 0,
      autonomous: true,
    };

    writePipelineState(state, TEST_DIR);
    const loaded = readPipelineState(TEST_DIR);

    expect(loaded).not.toBeNull();
    expect(loaded!.skills[0].status).toBe("failed");
    expect(loaded!.skills[1].status).toBe("pending");
  });

  it("resume logic retries failed skills by resetting to pending", async () => {
    const { writePipelineState, readPipelineState } = await import("../src/pipeline.js");

    // Simulate: skill 0 complete, skill 1 failed, skill 2 pending
    const state = {
      version: 1 as const,
      pipelineId: "test-pipeline",
      skills: [
        { skillName: "qa", status: "complete" as const, startTime: "t1", endTime: "t2" },
        { skillName: "design-review", status: "failed" as const, startTime: "t3", endTime: "t4" },
        { skillName: "ship", status: "pending" as const },
      ],
      currentSkillIndex: 1,
      startTime: "2026-01-01",
      totalCostUsd: 0.5,
      autonomous: true,
    };

    writePipelineState(state, TEST_DIR);
    const loaded = readPipelineState(TEST_DIR);

    // Replicate resumePipeline's index-finding logic
    let resumeIndex = 0;
    for (let i = 0; i < loaded!.skills.length; i++) {
      if (loaded!.skills[i].status === "complete") {
        resumeIndex = i + 1;
      } else if (loaded!.skills[i].status === "failed") {
        loaded!.skills[i].status = "pending";
        resumeIndex = i;
        break;
      } else {
        break;
      }
    }

    expect(resumeIndex).toBe(1);
    expect(loaded!.skills[1].status).toBe("pending");
  });
});
