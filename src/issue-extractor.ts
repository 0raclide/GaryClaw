/**
 * Structured Issue Extraction — extracts issues from SDK message stream
 * and git log by parsing commit messages from gstack skill conventions.
 *
 * Hybrid approach:
 * 1. Real-time: parse git commit -m commands from Bash tool_use blocks
 * 2. Post-hoc: verify via git log between checkpoint refs
 */

import { execFileSync } from "node:child_process";
import type { Issue, IssueSeverity } from "./types.js";

/**
 * Validate that a string looks like a git ref (hex SHA or branch name).
 * Rejects anything with shell metacharacters to prevent injection.
 */
function isValidGitRef(ref: string): boolean {
  return /^[a-zA-Z0-9._\-/]+$/.test(ref);
}

// ── Regex patterns ─────────────────────────────────────────────────

/**
 * Generic commit pattern: {type}({scope}): {ID} {separator} {description}
 * Supports "---" and "—" (em dash) as separators.
 */
const ISSUE_COMMIT_REGEX =
  /^(fix|style|refactor)\(([^)]+)\):\s+((?:ISSUE|FINDING|BUG|FIX)-\d{3,4})\s+(?:---|—)\s+(.+)$/;

/**
 * Extract the -m argument from a git commit command.
 * Handles double-quoted, single-quoted, and bare (next-arg) styles.
 */
const GIT_COMMIT_MSG_REGEX =
  /git\s+commit\s+[^;|&]*?-\w*m\s+(['"])((?:(?!\1).)*)\1/;

// ── Severity inference ─────────────────────────────────────────────

const SEVERITY_MAP: Record<string, IssueSeverity> = {
  fix: "high",
  style: "medium",
  refactor: "low",
};

/**
 * Infer issue severity from the commit type prefix.
 */
export function inferSeverity(commitType: string): IssueSeverity {
  return SEVERITY_MAP[commitType] ?? "medium";
}

// ── Commit message parsing ─────────────────────────────────────────

/**
 * Extract the git commit message from a Bash command string.
 * Returns the message text or null if no git commit -m found.
 */
export function extractCommitMessage(bashCommand: string): string | null {
  const match = bashCommand.match(GIT_COMMIT_MSG_REGEX);
  return match ? match[2] : null;
}

/**
 * Parse a single commit message into an Issue, or null if it doesn't
 * match the gstack issue commit convention.
 */
export function parseCommitMessage(
  msg: string,
  _skillName: string,
): Issue | null {
  // Only parse the first line (in case of multiline messages)
  const firstLine = msg.split("\n")[0].trim();
  const match = firstLine.match(ISSUE_COMMIT_REGEX);
  if (!match) return null;

  const [, commitType, , id, description] = match;

  return {
    id,
    severity: inferSeverity(commitType),
    description,
    status: "fixed",
  };
}

// ── Stateful issue tracker ─────────────────────────────────────────

export class IssueTracker {
  private skillName: string;
  private issues: Map<string, Issue> = new Map();
  private recentFilePaths: string[] = [];

  constructor(skillName: string) {
    this.skillName = skillName;
  }

  /**
   * Track a tool_use event. Buffers Edit/Write file paths for
   * association with the next commit.
   */
  trackToolUse(toolName: string, input: Record<string, unknown>): void {
    if (
      (toolName === "Edit" || toolName === "Write") &&
      typeof input.file_path === "string"
    ) {
      this.recentFilePaths.push(input.file_path);
    }
  }

  /**
   * Check if a Bash command contains a git commit. If so, parse it
   * and return the extracted Issue (or null).
   */
  trackCommit(bashCommand: string): Issue | null {
    const commitMsg = extractCommitMessage(bashCommand);
    if (!commitMsg) return null;

    const issue = parseCommitMessage(commitMsg, this.skillName);
    if (!issue) return null;

    // Skip duplicates
    if (this.issues.has(issue.id)) return null;

    // Associate the last recent file path — the most recent Edit/Write
    // before the commit is typically the actual fix target
    if (this.recentFilePaths.length > 0) {
      issue.filePath = this.recentFilePaths[this.recentFilePaths.length - 1];
    }

    // Clear file buffer after commit
    this.recentFilePaths = [];

    this.issues.set(issue.id, issue);
    return issue;
  }

  /**
   * Get all issues extracted so far, in insertion order.
   */
  getIssues(): Issue[] {
    return Array.from(this.issues.values());
  }

  /**
   * Merge issues discovered via git log that weren't caught by
   * stream parsing. Only adds issues with new IDs.
   */
  mergeGitLogIssues(gitLogIssues: Issue[]): void {
    for (const issue of gitLogIssues) {
      if (!this.issues.has(issue.id)) {
        this.issues.set(issue.id, issue);
      }
    }
  }
}

// ── Git log verification ───────────────────────────────────────────

/**
 * Parse issue commits from git log between two refs.
 * Returns issues found in commits between baseHead and currentHead.
 */
export function parseGitLog(
  baseHead: string,
  currentHead: string,
  projectDir: string,
  skillName: string,
): Issue[] {
  try {
    // Validate refs to prevent shell injection from corrupted checkpoint data
    if (!isValidGitRef(baseHead) || !isValidGitRef(currentHead)) {
      return [];
    }

    const output = execFileSync(
      "git",
      ["log", "--oneline", `${baseHead}..${currentHead}`],
      { cwd: projectDir, encoding: "utf-8", timeout: 5000 },
    );

    const issues: Issue[] = [];
    for (const line of output.trim().split("\n")) {
      if (!line) continue;
      // git log --oneline: "abc1234 fix(qa): ISSUE-001 --- description"
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) continue;

      const hash = line.slice(0, spaceIdx);
      const msg = line.slice(spaceIdx + 1);
      const issue = parseCommitMessage(msg, skillName);
      if (issue) {
        issue.fixCommit = hash;
        issues.push(issue);
      }
    }
    return issues;
  } catch {
    // Non-fatal — may not be a git repo or refs may be invalid
    return [];
  }
}

// ── Helper to extract all tool_use blocks from an SDK message ──────

export interface ToolUseBlock {
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Extract ALL tool_use blocks from an SDK assistant message.
 * Returns full input objects (not truncated summaries).
 */
export function extractAllToolUse(msg: any): ToolUseBlock[] {
  if (msg.type !== "assistant") return [];
  const content = msg.message?.content;
  if (!Array.isArray(content)) return [];

  const blocks: ToolUseBlock[] = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      blocks.push({
        toolName: block.name ?? "unknown",
        input: block.input ?? {},
      });
    }
  }
  return blocks;
}
