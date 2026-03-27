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
import { join } from "node:path";

import type { GaryClawConfig, PipelineSkillEntry } from "./types.js";

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
 */
export async function buildImplementPrompt(
  config: GaryClawConfig,
  previousSkills: PipelineSkillEntry[],
  projectDir: string,
): Promise<string> {
  const lines: string[] = [];

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

    // Implementation order
    const steps = extractImplementationOrder(doc.content);
    if (steps.length > 0) {
      lines.push("## Implementation Order");
      lines.push("");
      for (const step of steps) {
        lines.push(step);
      }
      lines.push("");
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
