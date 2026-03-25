import { describe, it, expect, beforeEach } from "vitest";
import {
  parseCommitMessage,
  extractCommitMessage,
  inferSeverity,
  IssueTracker,
  extractAllToolUse,
  parseGitLog,
} from "../src/issue-extractor.js";

// ── parseCommitMessage ─────────────────────────────────────────────

describe("parseCommitMessage", () => {
  it("parses QA issue commit with triple-dash separator", () => {
    const issue = parseCommitMessage(
      "fix(qa): ISSUE-001 --- replace broken link with valid home link",
      "qa",
    );
    expect(issue).not.toBeNull();
    expect(issue!.id).toBe("ISSUE-001");
    expect(issue!.severity).toBe("high");
    expect(issue!.description).toBe("replace broken link with valid home link");
    expect(issue!.status).toBe("fixed");
  });

  it("parses design-review finding with em dash separator", () => {
    const issue = parseCommitMessage(
      "style(design): FINDING-005 — add hover, focus-visible, and active states",
      "design-review",
    );
    expect(issue).not.toBeNull();
    expect(issue!.id).toBe("FINDING-005");
    expect(issue!.severity).toBe("medium");
    expect(issue!.description).toBe("add hover, focus-visible, and active states");
  });

  it("parses refactor commit with low severity", () => {
    const issue = parseCommitMessage(
      "refactor(qa): ISSUE-010 --- extract validation logic",
      "qa",
    );
    expect(issue).not.toBeNull();
    expect(issue!.severity).toBe("low");
  });

  it("returns null for chore commits", () => {
    expect(parseCommitMessage("chore: add design review report", "qa")).toBeNull();
  });

  it("returns null for merge commits", () => {
    expect(parseCommitMessage("Merge branch 'feature' into main", "qa")).toBeNull();
  });

  it("returns null for commits missing issue ID", () => {
    expect(parseCommitMessage("fix(qa): description only without ID", "qa")).toBeNull();
  });

  it("parses only the first line of multiline messages", () => {
    const issue = parseCommitMessage(
      "fix(qa): ISSUE-002 --- fix overflow\n\nDetailed explanation here",
      "qa",
    );
    expect(issue).not.toBeNull();
    expect(issue!.id).toBe("ISSUE-002");
    expect(issue!.description).toBe("fix overflow");
  });

  it("returns null for unsupported commit types", () => {
    expect(parseCommitMessage("feat(qa): ISSUE-001 --- new feature", "qa")).toBeNull();
    expect(parseCommitMessage("test(qa): ISSUE-001 --- add test", "qa")).toBeNull();
  });

  it("handles 4-digit issue IDs", () => {
    const issue = parseCommitMessage(
      "fix(qa): ISSUE-1234 --- large project fix",
      "qa",
    );
    expect(issue).not.toBeNull();
    expect(issue!.id).toBe("ISSUE-1234");
  });

  it("handles BUG and FIX prefixes", () => {
    expect(parseCommitMessage("fix(qa): BUG-001 --- fix it", "qa")!.id).toBe("BUG-001");
    expect(parseCommitMessage("fix(qa): FIX-042 --- patch it", "qa")!.id).toBe("FIX-042");
  });
});

// ── extractCommitMessage ───────────────────────────────────────────

describe("extractCommitMessage", () => {
  it("extracts from double-quoted git commit", () => {
    expect(
      extractCommitMessage('git commit -m "fix(qa): ISSUE-001 --- desc"'),
    ).toBe("fix(qa): ISSUE-001 --- desc");
  });

  it("extracts from single-quoted git commit", () => {
    expect(
      extractCommitMessage("git commit -m 'fix(qa): ISSUE-001 --- desc'"),
    ).toBe("fix(qa): ISSUE-001 --- desc");
  });

  it("extracts with flags before -m", () => {
    expect(
      extractCommitMessage('git commit --allow-empty -m "fix(qa): ISSUE-001 --- desc"'),
    ).toBe("fix(qa): ISSUE-001 --- desc");
  });

  it("returns null when no -m flag", () => {
    expect(extractCommitMessage("git commit")).toBeNull();
  });

  it("extracts from multi-command chain", () => {
    expect(
      extractCommitMessage('git add . && git commit -m "fix(qa): ISSUE-001 --- desc"'),
    ).toBe("fix(qa): ISSUE-001 --- desc");
  });

  it("returns null for non-git commands", () => {
    expect(extractCommitMessage("npm test")).toBeNull();
  });

  it("extracts with -am flag combination", () => {
    // -am is short for -a -m
    expect(
      extractCommitMessage('git commit -am "fix(qa): ISSUE-001 --- desc"'),
    ).toBe("fix(qa): ISSUE-001 --- desc");
  });
});

// ── inferSeverity ──────────────────────────────────────────────────

describe("inferSeverity", () => {
  it("maps fix to high", () => {
    expect(inferSeverity("fix")).toBe("high");
  });

  it("maps style to medium", () => {
    expect(inferSeverity("style")).toBe("medium");
  });

  it("maps refactor to low", () => {
    expect(inferSeverity("refactor")).toBe("low");
  });

  it("defaults unknown types to medium", () => {
    expect(inferSeverity("feat")).toBe("medium");
    expect(inferSeverity("chore")).toBe("medium");
  });
});

// ── IssueTracker ───────────────────────────────────────────────────

describe("IssueTracker", () => {
  let tracker: IssueTracker;

  beforeEach(() => {
    tracker = new IssueTracker("qa");
  });

  it("extracts issue from Edit → Bash(git commit) sequence", () => {
    tracker.trackToolUse("Edit", { file_path: "src/app.tsx" });
    const issue = tracker.trackCommit('git commit -m "fix(qa): ISSUE-001 --- fix link"');
    expect(issue).not.toBeNull();
    expect(issue!.id).toBe("ISSUE-001");
    expect(issue!.filePath).toBe("src/app.tsx");
  });

  it("extracts issue from Write → Bash(git commit) sequence", () => {
    tracker.trackToolUse("Write", { file_path: "src/index.html" });
    const issue = tracker.trackCommit('git commit -m "fix(qa): ISSUE-002 --- fix page"');
    expect(issue).not.toBeNull();
    expect(issue!.filePath).toBe("src/index.html");
  });

  it("uses first file path when multiple edits precede commit", () => {
    tracker.trackToolUse("Edit", { file_path: "src/a.ts" });
    tracker.trackToolUse("Edit", { file_path: "src/b.ts" });
    const issue = tracker.trackCommit('git commit -m "fix(qa): ISSUE-003 --- fix both"');
    expect(issue!.filePath).toBe("src/a.ts");
  });

  it("returns issue without filePath when no prior edits", () => {
    const issue = tracker.trackCommit('git commit -m "fix(qa): ISSUE-004 --- manual fix"');
    expect(issue).not.toBeNull();
    expect(issue!.filePath).toBeUndefined();
  });

  it("clears file buffer after commit", () => {
    tracker.trackToolUse("Edit", { file_path: "src/old.ts" });
    tracker.trackCommit('git commit -m "fix(qa): ISSUE-005 --- first"');

    const issue = tracker.trackCommit('git commit -m "fix(qa): ISSUE-006 --- second"');
    expect(issue).not.toBeNull();
    expect(issue!.filePath).toBeUndefined();
  });

  it("accumulates issues in insertion order", () => {
    tracker.trackCommit('git commit -m "fix(qa): ISSUE-001 --- first"');
    tracker.trackCommit('git commit -m "fix(qa): ISSUE-002 --- second"');
    tracker.trackCommit('git commit -m "fix(qa): ISSUE-003 --- third"');

    const issues = tracker.getIssues();
    expect(issues).toHaveLength(3);
    expect(issues[0].id).toBe("ISSUE-001");
    expect(issues[1].id).toBe("ISSUE-002");
    expect(issues[2].id).toBe("ISSUE-003");
  });

  it("deduplicates by issue ID", () => {
    tracker.trackCommit('git commit -m "fix(qa): ISSUE-001 --- first attempt"');
    const dup = tracker.trackCommit('git commit -m "fix(qa): ISSUE-001 --- second attempt"');
    expect(dup).toBeNull();
    expect(tracker.getIssues()).toHaveLength(1);
    expect(tracker.getIssues()[0].description).toBe("first attempt");
  });

  it("returns null for non-commit Bash commands", () => {
    expect(tracker.trackCommit("npm test")).toBeNull();
    expect(tracker.trackCommit("git status")).toBeNull();
    expect(tracker.trackCommit("git add .")).toBeNull();
  });

  it("returns null for non-issue commits", () => {
    expect(tracker.trackCommit('git commit -m "chore: update deps"')).toBeNull();
  });

  it("ignores non-Edit/Write tool uses for file buffering", () => {
    tracker.trackToolUse("Read", { file_path: "src/read-only.ts" });
    tracker.trackToolUse("Bash", { command: "ls" });
    const issue = tracker.trackCommit('git commit -m "fix(qa): ISSUE-007 --- fix"');
    expect(issue).not.toBeNull();
    expect(issue!.filePath).toBeUndefined();
  });

  describe("mergeGitLogIssues", () => {
    it("adds issues with new IDs from git log", () => {
      tracker.trackCommit('git commit -m "fix(qa): ISSUE-001 --- stream issue"');
      tracker.mergeGitLogIssues([
        {
          id: "ISSUE-002",
          severity: "high",
          description: "git log issue",
          status: "fixed",
          fixCommit: "abc1234",
        },
      ]);
      expect(tracker.getIssues()).toHaveLength(2);
      expect(tracker.getIssues()[1].id).toBe("ISSUE-002");
      expect(tracker.getIssues()[1].fixCommit).toBe("abc1234");
    });

    it("skips issues with IDs already tracked from stream", () => {
      tracker.trackCommit('git commit -m "fix(qa): ISSUE-001 --- stream"');
      tracker.mergeGitLogIssues([
        {
          id: "ISSUE-001",
          severity: "high",
          description: "git log version",
          status: "fixed",
          fixCommit: "xyz5678",
        },
      ]);
      expect(tracker.getIssues()).toHaveLength(1);
      expect(tracker.getIssues()[0].description).toBe("stream");
    });
  });
});

// ── extractAllToolUse ──────────────────────────────────────────────

describe("extractAllToolUse", () => {
  it("extracts all tool_use blocks from assistant message", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me fix this." },
          { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
          { type: "tool_use", name: "Bash", input: { command: "git add ." } },
        ],
      },
    };
    const blocks = extractAllToolUse(msg);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].toolName).toBe("Edit");
    expect(blocks[0].input.file_path).toBe("src/a.ts");
    expect(blocks[1].toolName).toBe("Bash");
    expect(blocks[1].input.command).toBe("git add .");
  });

  it("returns empty array for non-assistant messages", () => {
    expect(extractAllToolUse({ type: "result" })).toEqual([]);
    expect(extractAllToolUse({ type: "user" })).toEqual([]);
  });

  it("returns empty array when no tool_use blocks", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Just thinking." }],
      },
    };
    expect(extractAllToolUse(msg)).toEqual([]);
  });

  it("handles missing content gracefully", () => {
    expect(extractAllToolUse({ type: "assistant", message: {} })).toEqual([]);
    expect(extractAllToolUse({ type: "assistant" })).toEqual([]);
  });

  it("defaults unknown tool name to 'unknown'", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", input: { x: 1 } }],
      },
    };
    const blocks = extractAllToolUse(msg);
    expect(blocks[0].toolName).toBe("unknown");
  });
});
