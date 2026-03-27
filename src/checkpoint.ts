/**
 * Checkpoint manager — atomic write with 2-rotation, read with fallback,
 * relay prompt generation with tiered strategy.
 */

import { writeFileSync, readFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Checkpoint, ImplementProgress, Issue, Decision } from "./types.js";
import { formatCodebaseSummaryForRelay } from "./codebase-summary.js";

const CHECKPOINT_FILE = "checkpoint.json";
const CHECKPOINT_PREV = "checkpoint.prev.json";

/**
 * Estimate token count from text. Conservative: ~3.5 chars per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Write checkpoint atomically: write to tmp file, rotate current→prev, rename tmp→current.
 */
export function writeCheckpoint(checkpoint: Checkpoint, dir: string): void {
  mkdirSync(dir, { recursive: true });

  const currentPath = join(dir, CHECKPOINT_FILE);
  const prevPath = join(dir, CHECKPOINT_PREV);
  const tmpPath = join(dir, `checkpoint.tmp.${randomBytes(4).toString("hex")}.json`);

  const data = JSON.stringify(checkpoint, null, 2);

  // Write to tmp first
  writeFileSync(tmpPath, data, "utf-8");

  // Rotate: current → prev
  if (existsSync(currentPath)) {
    try {
      renameSync(currentPath, prevPath);
    } catch {
      // prev rotation failure is non-fatal
    }
  }

  // Promote: tmp → current
  renameSync(tmpPath, currentPath);
}

/**
 * Read checkpoint. Try current first, fall back to prev if current is corrupt.
 * Returns null if both are missing or corrupt.
 */
export function readCheckpoint(dir: string): Checkpoint | null {
  const currentPath = join(dir, CHECKPOINT_FILE);
  const prevPath = join(dir, CHECKPOINT_PREV);

  // Try current
  const current = tryReadCheckpoint(currentPath);
  if (current) return current;

  // Fall back to prev
  const prev = tryReadCheckpoint(prevPath);
  if (prev) return prev;

  return null;
}

function tryReadCheckpoint(path: string): Checkpoint | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    if (validateCheckpoint(data)) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Type guard: validates checkpoint has required fields and correct version.
 */
export function validateCheckpoint(data: unknown): data is Checkpoint {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  const baseValid =
    d.version === 1 &&
    typeof d.timestamp === "string" &&
    typeof d.runId === "string" &&
    typeof d.skillName === "string" &&
    Array.isArray(d.issues) &&
    Array.isArray(d.findings) &&
    Array.isArray(d.decisions) &&
    typeof d.gitBranch === "string" &&
    typeof d.gitHead === "string" &&
    typeof d.tokenUsage === "object" &&
    d.tokenUsage !== null &&
    Array.isArray(d.screenshotPaths);
  if (!baseValid) return false;

  // codebaseSummary is optional — backward compatible
  if (d.codebaseSummary !== undefined) {
    if (typeof d.codebaseSummary !== "object" || d.codebaseSummary === null) return false;
    const cs = d.codebaseSummary as Record<string, unknown>;
    if (!Array.isArray(cs.observations) || !Array.isArray(cs.failedApproaches)) return false;
  }

  return true;
}

/**
 * Generate a relay prompt from a checkpoint using tiered strategy:
 * - Open issues: full details
 * - Last 5 fixed: full details
 * - Older fixed: one-line summary
 * - Last 5 decisions: full details
 * - Older decisions: one-line summary
 *
 * Truncates oldest fixed issues if prompt exceeds maxTokens.
 */
export function generateRelayPrompt(
  checkpoint: Checkpoint,
  opts: { maxTokens?: number } = {},
): string {
  const maxTokens = opts.maxTokens ?? 10_000;

  const openIssues = checkpoint.issues.filter((i) => i.status === "open");
  const fixedIssues = checkpoint.issues.filter((i) => i.status === "fixed");
  const skippedIssues = checkpoint.issues.filter(
    (i) => i.status === "skipped" || i.status === "deferred",
  );

  // Split fixed into recent (last 5) and older
  const recentFixed = fixedIssues.slice(-5);
  const olderFixed = fixedIssues.slice(0, -5);

  // Split decisions into recent (last 5) and older
  const recentDecisions = checkpoint.decisions.slice(-5);
  const olderDecisions = checkpoint.decisions.slice(0, -5);

  let prompt = buildPromptText(
    checkpoint,
    openIssues,
    recentFixed,
    olderFixed,
    skippedIssues,
    recentDecisions,
    olderDecisions,
  );

  // Truncate oldest fixed if over budget
  let truncatedOlderFixed = olderFixed;
  while (estimateTokens(prompt) > maxTokens && truncatedOlderFixed.length > 0) {
    truncatedOlderFixed = truncatedOlderFixed.slice(1);
    prompt = buildPromptText(
      checkpoint,
      openIssues,
      recentFixed,
      truncatedOlderFixed,
      skippedIssues,
      recentDecisions,
      olderDecisions,
    );
  }

  return prompt;
}

function buildPromptText(
  checkpoint: Checkpoint,
  openIssues: Issue[],
  recentFixed: Issue[],
  olderFixed: Issue[],
  skippedIssues: Issue[],
  recentDecisions: Decision[],
  olderDecisions: Decision[],
): string {
  let text = `# GaryClaw Relay — Continuing ${checkpoint.skillName} Run

## Session Context
Run ID: ${checkpoint.runId}
Session #${checkpoint.tokenUsage.sessionCount + 1} (previous sessions: ${checkpoint.tokenUsage.sessionCount})
Git branch: ${checkpoint.gitBranch} @ ${checkpoint.gitHead}
Total cost so far: $${checkpoint.tokenUsage.estimatedCostUsd.toFixed(3)}

## Open Issues (${openIssues.length} remaining)
`;

  for (const issue of openIssues) {
    text += `\n### ${issue.id} [${issue.severity}]\n${issue.description}\n`;
    if (issue.filePath) text += `- File: ${issue.filePath}\n`;
    if (issue.screenshotPath) text += `- Screenshot: ${issue.screenshotPath}\n`;
  }

  if (recentFixed.length > 0) {
    text += `\n## Recently Fixed (last ${recentFixed.length})\n`;
    for (const issue of recentFixed) {
      text += `\n### ${issue.id} [${issue.severity}] — FIXED (${issue.fixCommit ?? "unknown"})\n${issue.description}\n`;
      if (issue.filePath) text += `- File: ${issue.filePath}\n`;
    }
  }

  if (olderFixed.length > 0) {
    text += `\n## Previously Fixed (${olderFixed.length} summarized)\n`;
    for (const issue of olderFixed) {
      text += `- ${issue.id}: Fixed ${issue.description.slice(0, 60)}${issue.description.length > 60 ? "..." : ""} in ${issue.filePath ?? "unknown"} (${issue.fixCommit ?? "no commit"})\n`;
    }
  }

  if (skippedIssues.length > 0) {
    text += `\n## Skipped/Deferred (${skippedIssues.length})\n`;
    for (const issue of skippedIssues) {
      text += `- ${issue.id} [${issue.severity}]: ${issue.description.slice(0, 60)}${issue.description.length > 60 ? "..." : ""} (${issue.status})\n`;
    }
  }

  if (recentDecisions.length > 0) {
    text += `\n## Recent Decisions (last ${recentDecisions.length})\n`;
    for (const d of recentDecisions) {
      text += `\n**Q:** ${d.question}\n**A:** ${d.chosen} (confidence: ${d.confidence}/10)\n**Why:** ${d.rationale} [${d.principle}]\n`;
    }
  }

  if (olderDecisions.length > 0) {
    text += `\n## Older Decisions (${olderDecisions.length} summarized)\n`;
    for (const d of olderDecisions) {
      text += `- "${d.question.slice(0, 50)}${d.question.length > 50 ? "..." : ""}" → ${d.chosen} [${d.principle}]\n`;
    }
  }

  if (checkpoint.findings.length > 0) {
    text += `\n## Findings\n`;
    for (const f of checkpoint.findings) {
      text += `- [${f.category}] ${f.description}`;
      if (f.actionTaken) text += ` → ${f.actionTaken}`;
      text += "\n";
    }
  }

  // Codebase summary section (carried across relay boundaries)
  if (checkpoint.codebaseSummary) {
    text += formatCodebaseSummaryForRelay(checkpoint.codebaseSummary);
  }

  // Implementation progress section (implement skill only)
  if (checkpoint.implementProgress) {
    text += formatImplementProgress(checkpoint.implementProgress);
  }

  // Instructions — implement-aware when step progress is available
  if (checkpoint.implementProgress) {
    const prog = checkpoint.implementProgress;
    if (prog.currentStep > prog.totalSteps) {
      text += `\n## Instructions
All implementation steps complete — verify tests pass and finalize.
Run \`npm test\` to confirm all tests pass. If any fail, fix them before finishing.
`;
    } else {
      text += `\n## Instructions
Resume implementation at step ${prog.currentStep}. Follow the implementation order exactly.
For each step: implement the code, write tests, run \`npm test\`, commit atomically.
Design doc: ${prog.designDocPath}
`;
    }
  } else {
    text += `\n## Instructions
Continue the ${checkpoint.skillName} skill. Start with the highest-severity open issue.
For each issue: read the file, understand the bug, fix it, commit, verify.
`;
  }

  return text;
}

/**
 * Format implementation progress into a compact relay prompt section.
 * Lists completed steps with commit SHAs and remaining steps.
 */
export function formatImplementProgress(progress: ImplementProgress): string {
  const { completedSteps, currentStep, totalSteps, stepCommits } = progress;

  let text = `\n## Implementation Progress (${completedSteps.length}/${totalSteps} steps complete)\n`;

  if (completedSteps.length > 0) {
    text += "\n**Completed:**\n";
    for (const stepNum of completedSteps) {
      const sha = stepCommits[stepNum] ?? "unknown";
      text += `- ✅ Step ${stepNum} (${sha})\n`;
    }
  }

  if (currentStep <= totalSteps) {
    text += "\n**Remaining:**\n";
    for (let i = 1; i <= totalSteps; i++) {
      if (!completedSteps.includes(i)) {
        text += `- ⬜ Step ${i}${i === currentStep ? " ← resume here" : ""}\n`;
      }
    }
  }

  return text;
}
