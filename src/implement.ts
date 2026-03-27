/**
 * Implement skill — builds features from design docs.
 *
 * Constructs a purpose-built prompt from:
 * 1. The most recently modified design doc in docs/designs/
 * 2. Review findings from previous pipeline skills
 * 3. Implementation order extracted from the design doc
 * 4. Strict commit/test rules
 *
 * Executes via the standard orchestrator (gets relay, checkpointing, Oracle for free).
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import type { Checkpoint, GaryClawConfig, ImplementProgress, PipelineSkillEntry } from "./types.js";

// ── Design doc discovery ────────────────────────────────────────

export interface DesignDoc {
  path: string;
  content: string;
}

/**
 * Find the most recently modified .md file in docs/designs/.
 * Returns null if the directory doesn't exist or contains no .md files.
 */
export function findDesignDoc(projectDir: string): DesignDoc | null {
  const designsDir = join(projectDir, "docs", "designs");
  if (!existsSync(designsDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(designsDir);
  } catch {
    return null;
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return null;

  // Find most recently modified
  let newest: { path: string; mtime: number } | null = null;
  for (const file of mdFiles) {
    const fullPath = join(designsDir, file);
    try {
      const stat = statSync(fullPath);
      if (!newest || stat.mtimeMs > newest.mtime) {
        newest = { path: fullPath, mtime: stat.mtimeMs };
      }
    } catch {
      continue;
    }
  }

  if (!newest) return null;

  try {
    const content = readFileSync(newest.path, "utf-8");
    return { path: newest.path, content };
  } catch {
    return null;
  }
}

/**
 * Load a design doc from an explicit path (absolute or relative to projectDir).
 */
export function loadDesignDoc(docPath: string, projectDir: string): DesignDoc | null {
  const resolved = docPath.startsWith("/") ? docPath : join(projectDir, docPath);
  if (!existsSync(resolved)) return null;
  try {
    const content = readFileSync(resolved, "utf-8");
    return { path: resolved, content };
  } catch {
    return null;
  }
}

// ── Implementation order extraction ─────────────────────────────

/**
 * Extract numbered steps from the "Implementation order" or
 * "Implementation Order" section of a design doc.
 */
export function extractImplementationOrder(designDoc: string): string[] {
  const match = designDoc.match(
    /## Implementation [Oo]rder[ \t]*\r?\n([\s\S]*?)(?=\n## |$)/,
  );
  if (!match) return [];

  return match[1]
    .split("\n")
    .filter((line) => /^\d+\./.test(line.trim()))
    .map((line) => line.trim());
}

/**
 * Validate implementation order extraction results.
 * Returns a warning message when a design doc exists but has no
 * numbered implementation steps, or null if everything looks fine.
 */
export function validateImplementationOrder(
  steps: string[],
  hasDesignDoc: boolean,
): string | null {
  if (steps.length > 0) return null;
  if (!hasDesignDoc) return null;
  return (
    "⚠️ WARNING: Design doc found but no implementation order section detected. " +
    "The design doc is missing a '## Implementation Order' section with numbered steps (e.g. '1. Create types'). " +
    "Without explicit steps, implementation order will be inferred from the design doc content, which may produce unpredictable results. " +
    "Consider adding a '## Implementation Order' section to the design doc."
  );
}

// ── Review context formatting ───────────────────────────────────

export interface FormatReviewOptions {
  /** When true, filter decisions to only actionable ones (low confidence or action keywords). */
  actionableOnly?: boolean;
}

const ACTION_KEYWORDS = ["add", "fix", "change", "create", "remove", "switch", "replace"];

/**
 * Check whether a decision is actionable based on confidence and keywords.
 * A decision is actionable if:
 * - confidence <= 7 (low confidence = needs attention), OR
 * - chosen or question text contains action keywords
 */
function isActionableDecision(d: { question: string; chosen: string; confidence: number }): boolean {
  if (d.confidence <= 7) return true;
  const text = `${d.question} ${d.chosen}`.toLowerCase();
  return ACTION_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * Format all review decisions, findings, and issues from previous
 * pipeline skills into prompt context.
 */
export function formatReviewContext(
  skills: PipelineSkillEntry[],
  options?: FormatReviewOptions,
): string {
  const lines: string[] = [];

  for (const skill of skills) {
    if (!skill.report) continue;
    const r = skill.report;

    // Filter decisions upfront so the hasContent check accounts for actionableOnly
    const decisions = options?.actionableOnly
      ? r.decisions.filter(isActionableDecision)
      : r.decisions;
    const hasContent =
      decisions.length > 0 || r.findings.length > 0 || r.issues.length > 0;
    if (!hasContent) continue;

    lines.push(`### /${skill.skillName}`);
    lines.push("");

    if (decisions.length > 0) {
      lines.push(`**Decisions (${decisions.length}):**`);
      for (const d of decisions) {
        lines.push(`- ${d.question} -> ${d.chosen} (confidence: ${d.confidence}/10)`);
        if (d.rationale) lines.push(`  Rationale: ${d.rationale}`);
      }
      lines.push("");
    }

    if (r.findings.length > 0) {
      lines.push(`**Findings (${r.findings.length}):**`);
      for (const f of r.findings) {
        lines.push(`- [${f.category}] ${f.description}`);
      }
      lines.push("");
    }

    if (r.issues.length > 0) {
      const open = r.issues.filter((i) => i.status === "open");
      const fixed = r.issues.filter((i) => i.status === "fixed");
      lines.push(`**Issues:** ${r.issues.length} total (${fixed.length} fixed, ${open.length} open)`);
      for (const issue of open) {
        lines.push(`- ${issue.id} [${issue.severity}]: ${issue.description}`);
        if (issue.filePath) lines.push(`  File: ${issue.filePath}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

// ── Prompt builder ──────────────────────────────────────────────

const IMPLEMENT_RULES = `## Rules

1. **Follow the implementation order exactly.** Step 1 first, then step 2, etc.
2. **Types first.** If step 1 is types.ts, start there. All interfaces must compile before any module that uses them.
3. **One commit per step.** Each step in the implementation order gets one atomic commit. Write the source module + its test file together, then commit both.
4. **Run tests after every commit.** \`npm test\` must pass before moving to the next step. If tests fail, fix them before proceeding.
5. **Commit message format:** Match the project's existing commit style.
6. **Do not modify code outside the design doc's scope.** If you find a bug unrelated to the implementation, note it but don't fix it.
7. **Use existing patterns.** Look at how existing modules are structured (types.ts for interfaces, dependency injection for testability, vi.fn() for mocks).
8. **Test strategy:** All tests synthetic — mock external dependencies. Follow the pattern in existing test files.`;

/**
 * Build the full implementation prompt from design doc + review context.
 *
 * When `resumeCheckpoint` is provided (pipeline resume case), completed steps
 * from the checkpoint's implementProgress are filtered out of the Implementation
 * Order section so the session only sees remaining work.
 */
export async function buildImplementPrompt(
  config: GaryClawConfig,
  previousSkills: PipelineSkillEntry[],
  projectDir: string,
  resumeCheckpoint?: Checkpoint | null,
): Promise<string> {
  const lines: string[] = [];
  const progress = resumeCheckpoint?.implementProgress ?? null;

  lines.push(
    "You are implementing a reviewed and approved design. Your job is to write the code, write the tests, and commit each module atomically.",
  );
  lines.push("");

  // Design doc: use explicit path from config if provided, else auto-discover
  const doc = config.designDoc
    ? loadDesignDoc(config.designDoc, projectDir)
    : findDesignDoc(projectDir);
  if (doc) {
    lines.push("## Design Document");
    lines.push("");
    lines.push(doc.content);
    lines.push("");

    // Implementation order — filter to remaining steps when resuming
    const steps = extractImplementationOrder(doc.content);
    if (steps.length > 0) {
      if (progress && progress.completedSteps.length > 0) {
        // Pipeline resume: show only remaining steps
        const completedSet = new Set(progress.completedSteps);
        const remaining = steps.filter((_, idx) => !completedSet.has(idx + 1));

        lines.push("## Implementation Order (Remaining)");
        lines.push("");
        lines.push(
          `Steps ${progress.completedSteps.join(", ")} complete (${progress.completedSteps.length}/${progress.totalSteps}). Resume at step ${progress.currentStep}.`,
        );
        lines.push("");
        for (const step of remaining) {
          lines.push(step);
        }
        lines.push("");
      } else {
        lines.push("## Implementation Order");
        lines.push("");
        for (const step of steps) {
          lines.push(step);
        }
        lines.push("");
      }
    }

    // Warn if design doc exists but has no implementation steps
    const warning = validateImplementationOrder(steps, true);
    if (warning) {
      lines.push(warning);
      lines.push("");
    }
  } else {
    lines.push("## Design Document");
    lines.push("");
    lines.push(
      "No design doc found in docs/designs/. Implement based on the review context below.",
    );
    lines.push("");
  }

  // Review context — filter to actionable decisions only
  const reviewContext = formatReviewContext(previousSkills, { actionableOnly: true });
  if (reviewContext) {
    lines.push("## Review Findings");
    lines.push("");
    lines.push(reviewContext);
    lines.push("");
  }

  // Rules
  lines.push(IMPLEMENT_RULES);
  lines.push("");

  return lines.join("\n");
}

// ── Step detection for relay tracking ────────────────────────────

/**
 * Extract key tokens from a step description for fuzzy matching.
 * Filters out common stop words and short tokens, keeping file names,
 * module names, and meaningful verbs.
 */
export function extractStepTokens(step: string): string[] {
  // Remove leading step number and punctuation: "1. Create types.ts" → "Create types.ts"
  const cleaned = step.replace(/^\d+\.\s*\*?\*?\s*/, "").replace(/\*\*/g, "");

  // Extract file-name-like tokens (e.g., types.ts, dashboard.ts) — high signal
  const fileTokens = cleaned.match(/[\w-]+\.\w+/g) ?? [];

  // Extract regular words, keeping only meaningful ones (length >= 3)
  const STOP_WORDS = new Set([
    "the", "and", "for", "with", "into", "from", "that", "this", "will",
    "new", "add", "all", "use", "get", "set", "has", "not", "but", "are",
    "was", "been", "have", "each", "when", "step", "create", "optional",
  ]);

  const words = cleaned
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());

  // File tokens first (higher signal), then word tokens, deduplicated
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of [...fileTokens.map((f) => f.toLowerCase()), ...words]) {
    if (!seen.has(t)) {
      seen.add(t);
      result.push(t);
    }
  }
  return result;
}

/**
 * Match a commit message to a step index using two-tier matching.
 *
 * Tier 1: Exact step number match (e.g., "step 1: ...", "1. ...")
 * Tier 2: Fuzzy token overlap (2+ key tokens from the step description)
 *
 * Returns the 1-indexed step number, or null if no match.
 */
export function matchCommitToStep(
  commitMessage: string,
  steps: string[],
): number | null {
  const msg = commitMessage.toLowerCase();

  // Tier 1: Exact step number match
  // Matches: "step 1: ...", "step 1. ...", "1. ...", "1: ..."
  const stepNumMatch = msg.match(/^(?:step\s+)?(\d+)[.:]/i);
  if (stepNumMatch) {
    const num = parseInt(stepNumMatch[1], 10);
    if (num >= 1 && num <= steps.length) {
      return num;
    }
  }

  // Tier 2: Fuzzy token matching — score each step, pick highest with 2+ matches
  let bestStep: number | null = null;
  let bestScore = 0;

  for (let i = 0; i < steps.length; i++) {
    const tokens = extractStepTokens(steps[i]);
    if (tokens.length === 0) continue;

    let score = 0;
    for (const token of tokens) {
      if (msg.includes(token)) {
        score++;
      }
    }

    if (score >= 2 && score > bestScore) {
      bestScore = score;
      bestStep = i + 1; // 1-indexed
    }
  }

  return bestStep;
}

/**
 * Detect completed implementation steps by scanning git log for commits
 * that match step descriptions.
 *
 * @param steps - The implementation order steps (raw strings from design doc)
 * @param projectDir - Git repo directory
 * @param designDocPath - Path to the design doc
 * @param sinceCommit - Only scan commits after this SHA (optional)
 * @returns ImplementProgress with completed/remaining step info
 */
export function detectCompletedSteps(
  steps: string[],
  projectDir: string,
  designDocPath: string,
  sinceCommit?: string,
): ImplementProgress {
  const totalSteps = steps.length;
  const completedSteps: number[] = [];
  const stepCommits: Record<number, string> = {};

  if (totalSteps === 0) {
    return {
      completedSteps: [],
      currentStep: 1,
      totalSteps: 0,
      stepCommits: {},
      designDocPath,
    };
  }

  // Get git log
  let logOutput: string;
  try {
    const args = sinceCommit
      ? ["log", "--oneline", `${sinceCommit}..HEAD`]
      : ["log", "--oneline", "--max-count=50"];

    logOutput = execFileSync("git", args, {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 10_000,
    });
  } catch {
    // Git log failed — return empty progress (conservative)
    return {
      completedSteps: [],
      currentStep: 1,
      totalSteps,
      stepCommits: {},
      designDocPath,
    };
  }

  // Parse each commit line: "abc1234 commit message"
  const lines = logOutput.trim().split("\n").filter(Boolean);
  // Process oldest-first so later commits for the same step overwrite earlier ones
  for (const line of lines.reverse()) {
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx < 0) continue;
    const sha = line.slice(0, spaceIdx);
    const message = line.slice(spaceIdx + 1);

    const stepNum = matchCommitToStep(message, steps);
    if (stepNum !== null && !completedSteps.includes(stepNum)) {
      completedSteps.push(stepNum);
      stepCommits[stepNum] = sha;
    }
  }

  // Sort completed steps
  completedSteps.sort((a, b) => a - b);

  // currentStep = min of incomplete steps, or totalSteps + 1 if all done
  const incompleteSteps = [];
  for (let i = 1; i <= totalSteps; i++) {
    if (!completedSteps.includes(i)) {
      incompleteSteps.push(i);
    }
  }
  const currentStep = incompleteSteps.length > 0
    ? incompleteSteps[0]
    : totalSteps + 1;

  return {
    completedSteps,
    currentStep,
    totalSteps,
    stepCommits,
    designDocPath,
  };
}
