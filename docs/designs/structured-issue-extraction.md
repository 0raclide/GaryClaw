# Structured Issue Extraction

**Author:** GaryClaw team
**Date:** 2026-03-25
**Status:** Implemented
**Phase:** Post-Phase 3 enhancement

---

## Problem

GaryClaw reports show **"Issues: 0"** in the structured summary even though git commits prove bugs were found and fixed during skill execution. This was identified as a "Known Gap" during E2E testing (Test 5: Artifact Inspection).

**Root cause:** Skills like `/qa` and `/design-review` commit fixes directly to git but don't emit structured issue data. The orchestrator has an explicit TODO at `src/orchestrator.ts:528`:

```typescript
issues: prevIssues, // TODO: parse from skill output in Phase 2
```

Issues are never populated — they're always empty arrays carried forward from previous checkpoints (which also started empty). This means checkpoints, relay prompts, reports, and pipeline context handoffs all lack issue data despite real work being done.

### Evidence from E2E Tests

**Test 3 (Autonomous QA):** 4 bugs found and fixed, 0 reported in structured data:
```
fix(qa): ISSUE-004 — fix unreadable text with proper font size and contrast
fix(qa): ISSUE-003 — fix 5000px div causing horizontal overflow
fix(qa): ISSUE-002 — gracefully hide missing image instead of showing 404
fix(qa): ISSUE-001 — replace broken link with valid home link
```

**Test 2 (Pipeline):** design-review fixed 4 findings, 0 in pipeline report:
```
style(design): FINDING-008 — remove dead .hidden-text rule
style(design): FINDING-005 — add hover, focus-visible, and active states
style(design): FINDING-004 — fix undersized touch targets
style(design): FINDING-007 — move inline styles to CSS
```

---

## Data Available in the SDK Stream

From spike testing and E2E observation:

1. **Assistant messages** contain `message.content[]` with:
   - **Text blocks** (`{ type: 'text', text }`) — Claude's reasoning
   - **Tool use blocks** (`{ type: 'tool_use', name, input }`) — full tool inputs including complete Bash commands, file paths for Read/Edit/Write

2. **No tool_result messages** in the SDK stream — tool execution happens in the CLI bridge. We can see `git commit -m '...'` commands in tool_use inputs but not command output.

3. **The existing `extractToolUse()`** function (orchestrator.ts:71-85) already reads tool_use blocks and extracts `block.name` + `block.input`. Currently it only summarizes for UI display (truncated to 80 chars).

### Commit Message Formats (Observed)

| Skill | Pattern | Example |
|-------|---------|---------|
| qa | `fix(qa): ISSUE-NNN — description` | `fix(qa): ISSUE-001 — replace broken link with valid home link` |
| design-review | `style(design): FINDING-NNN — description` | `style(design): FINDING-005 — add hover, focus-visible, and active states` |
| Non-issue | `chore: description` | `chore: add design review report` |

**Tool call sequence when fixing:** Read → Edit/Write → Bash(`git add`) → Bash(`git commit -m "..."`)

---

## Design

### Approach: Hybrid Extraction

**Primary — Real-time stream parsing:**
- Watch SDK message stream in the orchestrator loop
- When a `tool_use` block with `name === "Bash"` appears, check `input.command` for `git commit` patterns
- Extract issue ID + description from the commit message
- Track recent Edit/Write file paths to associate with the issue
- Emit `issue_extracted` event for live progress

**Secondary — Post-hoc git log verification:**
- At checkpoint build time, run `git log --oneline {previousGitHead}..HEAD`
- Parse any commits missed by stream parsing (e.g., subagent commits, multi-line heredoc commits)
- Deduplicate against stream-extracted issues by ID

### New Module: `src/issue-extractor.ts`

```typescript
// ── Pure functions ──

/**
 * Parse a single commit message into an Issue, or null if not an issue commit.
 */
export function parseCommitMessage(msg: string, skillName: string): Issue | null;

/**
 * Infer severity from commit type prefix.
 * fix(qa) → "high", style(design) → "medium", refactor → "low", default → "medium"
 */
export function inferSeverity(commitType: string): IssueSeverity;

/**
 * Extract the git commit message from a Bash command string.
 * Handles: git commit -m "msg", git commit -m 'msg', heredoc patterns.
 */
export function extractCommitMessage(bashCommand: string): string | null;

// ── Stateful tracker ──

export class IssueTracker {
  constructor(skillName: string);

  /** Track a tool_use event — buffers Edit/Write file paths. */
  trackToolUse(toolName: string, input: Record<string, unknown>): void;

  /**
   * Check if a Bash command contains a git commit. If so, extract the issue
   * and associate recent file paths. Returns the extracted Issue or null.
   */
  trackCommit(bashCommand: string): Issue | null;

  /** Get all issues extracted so far. */
  getIssues(): Issue[];

  /** Merge issues from git log that weren't caught by stream parsing. */
  mergeGitLogIssues(gitLogIssues: Issue[]): void;
}

// ── Git log verification ──

/**
 * Run git log and parse issue commits between two refs.
 * Returns issues not already in the tracker.
 */
export function parseGitLog(
  baseHead: string,
  currentHead: string,
  projectDir: string,
  skillName: string,
): Issue[];
```

### Commit Parsing Regex

```typescript
// Generic pattern: {type}({scope}): {ID} {separator} {description}
// Separator: "---" or "—" (em dash)
const ISSUE_COMMIT_REGEX =
  /^(fix|style|refactor)\(([^)]+)\):\s+((?:ISSUE|FINDING|BUG|FIX)-\d{3,4})\s+(?:---|—)\s+(.+)$/;

// Extract git commit message from Bash command
const GIT_COMMIT_MSG_REGEX =
  /git\s+commit\s+(?:[^-]*\s+)?-m\s+(['"])((?:(?!\1).)*)\1/;
```

### Severity Inference

| Commit Type | Default Severity | Rationale |
|-------------|-----------------|-----------|
| `fix` | `high` | Bug fix — functional issue |
| `style` | `medium` | Design/visual issue |
| `refactor` | `low` | Code improvement, not user-facing |
| Unknown | `medium` | Safe default |

### File Path Association

The IssueTracker maintains a rolling buffer of recently edited file paths:

1. When `trackToolUse("Edit", { file_path: "..." })` or `trackToolUse("Write", { file_path: "..." })` is called → push `file_path` to buffer
2. When `trackCommit()` detects a commit → associate the first buffered file path with the issue's `filePath` field, then clear the buffer
3. Buffer cleared on each commit to prevent cross-contamination

---

## Integration

### 1. Types (`src/types.ts`)

Add new event variant:

```typescript
export type OrchestratorEvent =
  // ... existing variants ...
  | { type: "issue_extracted"; issue: Issue }
```

### 2. Orchestrator (`src/orchestrator.ts`)

**a) Import and create tracker:**

```typescript
import { IssueTracker, extractCommitMessage, parseGitLog } from "./issue-extractor.js";

// In runSkillInternal, before session loop:
const issueTracker = new IssueTracker(config.skillName);
```

**b) Extract ALL tool_use blocks (not just first):**

Add `extractAllToolUse()` that returns every tool_use block from a message with full input, not just the first one truncated.

**c) Feed tool_use events in the message loop:**

```typescript
// After existing extractToolUse call (for UI)
const allToolUses = extractAllToolUse(msg);
for (const tu of allToolUses) {
  issueTracker.trackToolUse(tu.toolName, tu.input);
  if (tu.toolName === "Bash" && typeof tu.input.command === "string") {
    const issue = issueTracker.trackCommit(tu.input.command);
    if (issue) {
      callbacks.onEvent({ type: "issue_extracted", issue });
    }
  }
}
```

**d) Replace the TODO in `buildCheckpoint()`:**

```typescript
// Before (line 528):
issues: prevIssues, // TODO: parse from skill output in Phase 2

// After:
issues: [...prevIssues, ...issueTracker.getIssues()],
```

Pass `issueTracker` to `buildCheckpoint()` as a new parameter.

**e) Git log verification at checkpoint time:**

```typescript
// In buildCheckpoint, after getting gitHead:
const prevHead = previousCheckpoints.length > 0
  ? previousCheckpoints[previousCheckpoints.length - 1].gitHead
  : null;
if (prevHead && prevHead !== "unknown" && gitHead !== "unknown") {
  const gitLogIssues = parseGitLog(prevHead, gitHead, config.projectDir, config.skillName);
  issueTracker.mergeGitLogIssues(gitLogIssues);
}
```

### 3. No changes needed

- **checkpoint.ts** — Already handles non-empty `issues[]` with tiered relay prompt rendering
- **relay.ts** — Uses checkpoint data as-is
- **report.ts** — Already merges/deduplicates issues and formats in markdown
- **pipeline.ts** — Already passes issues in context handoff

### 4. CLI (`src/cli.ts`)

Handle new `issue_extracted` event in the display callback:

```typescript
case "issue_extracted":
  console.log(`  ${chalk.green("✓")} ${event.issue.id}: ${event.issue.description}`);
  break;
```

---

## Test Plan

**File:** `test/issue-extractor.test.ts`

All tests use synthetic data — no SDK calls, no git commands.

### parseCommitMessage (~8 tests)
- QA issue: `fix(qa): ISSUE-001 --- description` → Issue with id, severity high, status fixed
- Design finding: `style(design): FINDING-005 — description` → Issue with severity medium
- Refactor: `refactor(qa): ISSUE-010 --- cleanup` → severity low
- Non-issue commit: `chore: add report` → null
- Merge commit: `Merge branch 'feature'` → null
- Missing ID: `fix(qa): description only` → null
- Multiline message (first line only): correct parsing
- Unknown prefix: `feat(qa): ISSUE-001 --- new thing` → null (only fix/style/refactor)

### extractCommitMessage (~5 tests)
- Double-quoted: `git commit -m "fix(qa): ISSUE-001 --- desc"` → extracted
- Single-quoted: `git commit -m 'fix(qa): ISSUE-001 --- desc'` → extracted
- With flags: `git commit -am "msg"` or `git commit --allow-empty -m "msg"` → extracted
- No -m flag: `git commit` → null
- Multi-command: `git add . && git commit -m "msg"` → extracted

### IssueTracker (~10 tests)
- Track Edit → track Bash commit → issue has filePath from Edit
- Track Write → track Bash commit → issue has filePath from Write
- Multiple Edits → commit → uses first Edit file path
- Commit without prior Edit → issue has no filePath
- File buffer clears after commit → next commit has no stale filePath
- getIssues() returns accumulated issues in order
- Duplicate commit messages → only one issue (dedup by ID)
- mergeGitLogIssues skips IDs already tracked
- mergeGitLogIssues adds new IDs
- Non-commit Bash commands → no issue extracted

### inferSeverity (~3 tests)
- fix → high, style → medium, refactor → low, unknown → medium

**Expected total: ~25 tests**

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Commit format changes | Low | Regex is lenient, fallback to git log |
| Heredoc commits missed by stream parsing | Medium | Git log verification catches them |
| Subagent commits not in stream | Medium | Git log verification catches them |
| False positive parsing | Low | Strict regex requires ID format |
| Performance impact of git log | Low | Single exec per checkpoint, not per turn |

---

## Scope

**In scope:**
- Issue extraction from git commit messages (stream + git log)
- File path association via tool_use buffer
- Severity inference from commit type
- Integration into orchestrator, checkpoint, CLI display

**Out of scope (future):**
- Screenshot path extraction
- Finding extraction from assistant text (non-commit sources)
- Issue status transitions (open → fixed detection from subsequent commits)
- Custom commit format configuration
