/**
 * Prioritize skill — picks the single highest-impact backlog item.
 *
 * Reads TODOS.md, overnight goal, oracle metrics/outcomes, and pipeline
 * context to build a rich prompt. The orchestrator executes this prompt,
 * and Claude writes `.garyclaw/priority.md` with the top pick + scoring.
 *
 * Follows the implement.ts pattern: pure functions that build a prompt string,
 * dispatched from pipeline.ts via runSkillWithPrompt().
 */

import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import { safeReadText } from "./safe-json.js";
import { readOracleMemory, readMetrics, defaultMemoryConfig } from "./oracle-memory.js";
import { estimateTokens } from "./checkpoint.js";
import { readFailureRecords } from "./failure-taxonomy.js";
import { groupDecisionsByTopic, DEFAULT_AUTO_RESEARCH_CONFIG } from "./auto-research.js";
import { formatSkillCatalogForPrompt } from "./skill-catalog.js";
import { readPipelineOutcomes, computeCategoryStats } from "./pipeline-history.js";
import { buildProjectTypeSection } from "./project-type.js";
import { VALID_TASK_CATEGORIES, TASK_CATEGORY_DESCRIPTIONS } from "./types.js";
import type { GaryClawConfig, PipelineSkillEntry, OracleMetrics, Decision, DaemonState } from "./types.js";

// ── Token budget constants ───────────────────────────────────────

/** Total token budget for the prioritize prompt.
 *  Section caps sum to ~31K + ~6K fixed sections = ~37K max. 40K provides headroom. */
export const PRIORITIZE_PROMPT_BUDGET = 40_000;

/** Per-section token budgets for buildPrioritizePrompt().
 *  Total: ~36,300 tokens max, leaving headroom for Phase 2-4 instructions + overhead. */
export const PRIORITIZE_SECTION_BUDGETS = {
  todos:              12_000,
  capabilities:       3_500,
  vision:             1_500,
  oracleContext:      4_000,
  failurePatterns:    1_500,
  qualityTrends:      1_000,
  impactMeasurement:  800,
  skillCatalog:       1_500,
  pipelineStats:      1_500,
  reviewFindings:     1_500,
  pipelineContext:    1_000,
  overnightGoal:      1_000,
  projectType:        500,
  claimedItems:       500,
  preAssigned:        500,
} as const;

// ── TODOS filtering ──────────────────────────────────────────────

/**
 * Filter TODOS.md content to open items only.
 * Removes struck-through headings (## ~~) and their full blocks.
 * Keeps preamble text (e.g. "# TODOS" heading) before the first ## block.
 */
export function filterOpenTodos(content: string): string {
  const blocks = content.split(/^(?=## )/m);
  const hadStructuredItems = blocks.some(b => b.match(/^## /));
  const open = blocks.filter(b => !b.match(/^## ~~/));
  const result = open.join("\n").trim();
  // If there were structured ## blocks but none survived filtering (all struck-through),
  // return empty so the caller falls through to the "No TODOS.md found" path.
  if (hadStructuredItems && !open.some(b => b.match(/^## /))) return "";
  return result;
}

// ── Budget helpers ───────────────────────────────────────────────

/**
 * Truncate text to fit within a token budget.
 * Uses estimateTokens (chars/3.5) consistently for both measurement and target.
 *
 * NOTE: Do NOT use truncateToTokenBudget from oracle-memory.ts here — it uses
 * maxTokens * 4 for char budget while estimateTokens uses chars / 3.5, causing
 * ~14% overrun. This local helper uses estimateTokens consistently.
 *
 * keepEnd=true: drop from beginning (keep newest, for historical data like outcomes)
 * keepEnd=false (default): drop from end (keep beginning, for TODOS.md P1/P2 items, capabilities)
 */
export function truncateSection(content: string, maxTokens: number, keepEnd = false): string {
  if (estimateTokens(content) <= maxTokens) return content;
  const maxChars = Math.floor(maxTokens * 3.5);
  if (keepEnd) {
    const sliced = content.slice(-maxChars);
    const nl = sliced.indexOf("\n");
    return nl >= 0 && nl < sliced.length - 1
      ? "[...older entries truncated]\n" + sliced.slice(nl + 1)
      : "[...older entries truncated]\n" + sliced;
  } else {
    const sliced = content.slice(0, maxChars);
    const nl = sliced.lastIndexOf("\n");
    return nl > 0 ? sliced.slice(0, nl) + "\n[...truncated to fit token budget]" : sliced + "\n[...truncated to fit token budget]";
  }
}

/**
 * Add a section to the prompt lines if it fits within the remaining budget.
 * Returns tokens consumed. Truncates content if it exceeds sectionCap or remaining budget.
 * keepEnd: truncation direction (true=keep newest, false=keep beginning, default=false)
 */
export function addBudgetedSection(
  lines: string[],
  header: string,
  content: string,
  sectionCap: number,
  remainingBudget: number,
  keepEnd = false,
): number {
  if (!content || content.trim().length === 0) return 0;

  const effectiveCap = Math.min(sectionCap, remainingBudget);
  if (effectiveCap <= 0) return 0;

  const tokens = estimateTokens(content);
  const finalContent = tokens > effectiveCap
    ? truncateSection(content, effectiveCap, keepEnd)
    : content;

  if (header) {
    lines.push(header);
    lines.push("");
  }
  lines.push(finalContent);
  lines.push("");

  // Single estimate over the full block (header + newlines + content) for accuracy
  const block = header ? `${header}\n\n${finalContent}\n` : `${finalContent}\n`;
  return estimateTokens(block);
}

// ── TodoItem parsing ─────────────────────────────────────────────

export interface TodoItem {
  title: string;
  priority: number;          // 1-4 from P{N} prefix
  description: string;       // full block text (what/why/pros/cons/context)
  effort: string | null;     // XS/S/M/L/XL or null
  dependencies: string[];    // "Depends on:" entries
  context: string | null;    // "Context:" field
  status: string | null;     // e.g. "PARTIALLY FIXED"
}

/**
 * Parse TODOS.md markdown into structured items.
 * Each `## P{N}: Title` block becomes one TodoItem.
 */
export function parseTodoItems(content: string): TodoItem[] {
  const items: TodoItem[] = [];
  // Split on ## headings, capturing the heading line
  const blocks = content.split(/^(?=## P\d)/m);

  for (const block of blocks) {
    const headingMatch = block.match(/^## P(\d):\s*(.+?)(?:\s*—\s*(.+))?$/m);
    if (!headingMatch) continue;

    const priority = parseInt(headingMatch[1], 10);
    const titleWithStatus = headingMatch[2].trim();
    const status = headingMatch[3]?.trim() ?? null;

    // Extract effort
    const effortMatch = block.match(/\*\*Effort:\*\*\s*(XS|S|M|L|XL)/i);
    const effort = effortMatch ? effortMatch[1].toUpperCase() : null;

    // Extract dependencies
    const depsMatch = block.match(/\*\*Depends on:\*\*\s*(.+)/i);
    const dependencies = depsMatch
      ? depsMatch[1].split(/,\s*/).map((d) => d.trim())
      : [];

    // Extract context
    const contextMatch = block.match(/\*\*Context:\*\*\s*([\s\S]*?)(?=\n\*\*|$)/i);
    const context = contextMatch ? contextMatch[1].trim() : null;

    items.push({
      title: titleWithStatus,
      priority,
      description: block.trim(),
      effort,
      dependencies,
      context,
      status,
    });
  }

  return items;
}

// ── Overnight goal ───────────────────────────────────────────────

/**
 * Read overnight-goal.md from project root if it exists.
 * Returns content or null.
 */
export function loadOvernightGoal(projectDir: string): string | null {
  const goalPath = join(projectDir, "overnight-goal.md");
  return safeReadText(goalPath);
}

// ── Oracle context ───────────────────────────────────────────────

/**
 * Build a summary of oracle metrics and recent decision outcomes
 * for injection into the prioritize prompt.
 */
export function loadOracleContext(projectDir: string): string | null {
  const memConfig = defaultMemoryConfig(projectDir);
  const metrics = readMetrics(memConfig);
  const memory = readOracleMemory(memConfig, projectDir);

  const lines: string[] = [];

  // Metrics summary
  if (metrics.totalDecisions > 0) {
    lines.push("### Oracle Metrics");
    lines.push(`- Total decisions: ${metrics.totalDecisions}`);
    lines.push(`- Accuracy: ${metrics.accuracyPercent.toFixed(0)}% (${metrics.accurateDecisions} success, ${metrics.failedDecisions} failure, ${metrics.neutralDecisions} neutral)`);
    if (metrics.circuitBreakerTripped) {
      lines.push("- **Circuit breaker TRIPPED** — oracle memory disabled due to low accuracy");
    }
    lines.push("");
  }

  // Recent decision outcomes
  if (memory.decisionOutcomes) {
    lines.push("### Recent Decision Outcomes");
    lines.push(memory.decisionOutcomes);
    lines.push("");
  }

  if (lines.length === 0) return null;
  return lines.join("\n").trim();
}

/**
 * Format oracle metrics into a summary string (for testing/direct use).
 */
export function formatMetricsSummary(metrics: OracleMetrics): string {
  if (metrics.totalDecisions === 0) return "";

  const lines = [
    `- Total decisions: ${metrics.totalDecisions}`,
    `- Accuracy: ${metrics.accuracyPercent.toFixed(0)}% (${metrics.accurateDecisions} success, ${metrics.failedDecisions} failure, ${metrics.neutralDecisions} neutral)`,
  ];
  if (metrics.circuitBreakerTripped) {
    lines.push("- **Circuit breaker TRIPPED** — oracle memory disabled due to low accuracy");
  }
  return lines.join("\n");
}

// ── Pipeline context ─────────────────────────────────────────────

/**
 * Format previous skill findings for the prioritize prompt.
 * Focuses on open issues, QA failures, and deferred items.
 */
export function formatPipelineContext(skills: PipelineSkillEntry[]): string {
  const lines: string[] = [];

  for (const skill of skills) {
    if (!skill.report) continue;
    const r = skill.report;
    const hasContent =
      r.decisions.length > 0 || r.findings.length > 0 || r.issues.length > 0;
    if (!hasContent) continue;

    lines.push(`### /${skill.skillName}`);
    lines.push("");

    if (r.issues.length > 0) {
      const open = r.issues.filter((i) => i.status === "open");
      const fixed = r.issues.filter((i) => i.status === "fixed");
      const deferred = r.issues.filter((i) => i.status === "deferred");
      lines.push(`**Issues:** ${r.issues.length} total (${fixed.length} fixed, ${open.length} open, ${deferred.length} deferred)`);
      for (const issue of open) {
        lines.push(`- OPEN ${issue.id} [${issue.severity}]: ${issue.description}`);
        if (issue.filePath) lines.push(`  File: ${issue.filePath}`);
      }
      for (const issue of deferred) {
        lines.push(`- DEFERRED ${issue.id} [${issue.severity}]: ${issue.description}`);
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

    if (r.decisions.length > 0) {
      const recentDecisions = r.decisions.slice(-5);
      lines.push(`**Recent Decisions (${recentDecisions.length}):**`);
      for (const d of recentDecisions) {
        lines.push(`- ${d.question} → ${d.chosen} (${d.confidence}/10)`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

// ── Unresolved review findings ──────────────────────────────────

export interface ReviewFinding {
  jobId: string;
  skillName: string;
  question: string;
  accepted: string;
  confidence: number;
}

/**
 * Scan recent pipeline reports for eng/CEO review decisions that accepted
 * fixes ("fix", "implement", "add", "build") but were never implemented.
 *
 * Checks: if a decision says "Fix X" and no commit since then mentions X,
 * it's probably unresolved. We use a simple heuristic: decisions from review
 * skills in the last 5 jobs that contain action keywords.
 */
export function loadUnresolvedReviewFindings(checkpointDir: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const actionKeywords = /\bfix\b|\bimplement\b|\badd\b|\bbuild now\b|\bextract\b|\bvalidate\b|\breplace\b/i;
  const reviewSkills = ["plan-eng-review", "plan-ceo-review"];

  // Scan all instance job dirs
  const daemonsDir = join(checkpointDir, "daemons");
  const jobDirs: string[] = [];

  // Check both old flat layout and new instance layout
  const flatJobsDir = join(checkpointDir, "jobs");
  if (existsSync(flatJobsDir)) {
    try {
      for (const d of readdirSync(flatJobsDir)) {
        jobDirs.push(join(flatJobsDir, d));
      }
    } catch { /* ignore */ }
  }

  if (existsSync(daemonsDir)) {
    try {
      for (const inst of readdirSync(daemonsDir)) {
        const instJobsDir = join(daemonsDir, inst, "jobs");
        if (!existsSync(instJobsDir)) continue;
        try {
          for (const d of readdirSync(instJobsDir)) {
            jobDirs.push(join(instJobsDir, d));
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // Sort by dir name (contains timestamp) descending, take last 10
  // (more than 5 because old flat jobs may outnumber recent instance jobs)
  jobDirs.sort().reverse();
  const recentDirs = jobDirs.slice(0, 10);

  for (const jobDir of recentDirs) {
    const reportPath = join(jobDir, "pipeline-report.md");
    const report = safeReadText(reportPath);
    if (!report) continue;

    const jobId = jobDir.split("/").pop() ?? "unknown";

    // Extract decisions from the markdown report
    // Format: - **Q:** question → **A:** answer (N/10)
    const decisionPattern = /\*\*Q:\*\*\s*(.*?)\s*→\s*\*\*A:\*\*\s*(.*?)\s*\((\d+)\/10\)/g;
    let match;
    while ((match = decisionPattern.exec(report)) !== null) {
      const question = match[1];
      const answer = match[2];
      const confidence = parseInt(match[3], 10);

      // Only include decisions from review skills that accepted an action
      const isFromReview = reviewSkills.some((s) => report.includes(`/${s}`));
      if (!isFromReview) continue;
      if (!actionKeywords.test(answer)) continue;

      // Skip decisions that are meta (about running the next skill, committing, etc.)
      if (/run \/|ready to implement|commit my changes|skip|proceed/i.test(answer)) continue;

      findings.push({ jobId, skillName: "eng-review", question, accepted: answer, confidence });
    }
  }

  return findings;
}

// ── Deep context builders ───────────────────────────────────────

/**
 * Aggregate failure patterns from failures.jsonl across all instances.
 * Returns a markdown section summarizing top failure categories and affected skills.
 */
export function aggregateFailurePatterns(checkpointDir: string): string | null {
  const records = readFailureRecords(checkpointDir);
  if (records.length === 0) return null;

  // Count by category
  const byCategory = new Map<string, number>();
  for (const r of records) {
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
  }

  // Count by skill (first skill in each job's skill list)
  const bySkill = new Map<string, number>();
  for (const r of records) {
    const skill = r.skills?.[0] ?? "unknown";
    bySkill.set(skill, (bySkill.get(skill) ?? 0) + 1);
  }

  // Top 3 categories sorted by count
  const topCategories = Array.from(byCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // Top 3 skills sorted by count
  const topSkills = Array.from(bySkill.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const lines: string[] = [
    "### Failure Patterns",
    "",
    `${records.length} total failures recorded.`,
    "",
    "**By category:**",
  ];
  for (const [cat, count] of topCategories) {
    lines.push(`- ${cat}: ${count} failure${count !== 1 ? "s" : ""}`);
  }
  lines.push("");
  lines.push("**Most-affected skills:**");
  for (const [skill, count] of topSkills) {
    lines.push(`- ${skill}: ${count} failure${count !== 1 ? "s" : ""}`);
  }
  lines.push("");
  lines.push("Items that fix recurring failure patterns deserve a +2 scoring bonus.");

  return lines.join("\n");
}

/**
 * Analyze decision quality trends from oracle metrics and low-confidence decision clusters.
 * Returns a markdown section summarizing weak topic areas.
 */
export function getDecisionQualityTrends(projectDir: string): string | null {
  const memConfig = defaultMemoryConfig(projectDir);
  const metrics = readMetrics(memConfig);

  // Read decisions.jsonl for low-confidence topic clustering
  const decisionsPath = join(projectDir, ".garyclaw", "decisions.jsonl");
  const decisions: Decision[] = [];
  if (existsSync(decisionsPath)) {
    try {
      const content = readFileSync(decisionsPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const d = JSON.parse(trimmed) as Decision;
          if (d.question && typeof d.confidence === "number") {
            decisions.push(d);
          }
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }

  // Group low-confidence decisions by topic
  const groups = groupDecisionsByTopic(decisions, {
    ...DEFAULT_AUTO_RESEARCH_CONFIG,
    lowConfidenceThreshold: 7, // slightly higher threshold for quality trends
    minDecisionsToTrigger: 2,
  });

  const hasMetrics = metrics.totalDecisions > 0;
  const hasGroups = groups.length > 0;
  if (!hasMetrics && !hasGroups) return null;

  const lines: string[] = ["### Decision Quality Trends", ""];

  if (hasMetrics) {
    lines.push(`Oracle accuracy: ${metrics.accuracyPercent.toFixed(0)}% across ${metrics.totalDecisions} decisions.`);
    if (metrics.confidenceTrend.length > 0) {
      const avg = metrics.confidenceTrend.reduce((s, v) => s + v, 0) / metrics.confidenceTrend.length;
      lines.push(`Recent confidence trend: avg ${avg.toFixed(1)}/10 over last ${metrics.confidenceTrend.length} decisions.`);
    }
    lines.push("");
  }

  if (hasGroups) {
    lines.push("**Topics with low confidence (areas where the Oracle struggles):**");
    for (const g of groups.slice(0, 5)) {
      lines.push(`- ${g.topic}: avg ${g.avgConfidence.toFixed(1)}/10, ${g.decisions.length} decisions`);
    }
    lines.push("");
    lines.push("Items that build domain knowledge for weak topics deserve a +1 scoring bonus.");
  }

  return lines.join("\n");
}

/**
 * Measure recent impact by comparing average job cost of recent vs older jobs.
 * Returns a markdown section with impact signals.
 */
export function measureRecentImpact(checkpointDir: string): string | null {
  // Collect all jobs from daemon state files
  const allJobs: { costUsd: number; completedAt: string; skills: string[] }[] = [];

  const collectJobs = (statePath: string) => {
    if (!existsSync(statePath)) return;
    try {
      const content = readFileSync(statePath, "utf-8");
      const state = JSON.parse(content) as DaemonState;
      for (const j of state.jobs ?? []) {
        if (j.status === "complete" && j.completedAt && j.costUsd > 0) {
          allJobs.push({ costUsd: j.costUsd, completedAt: j.completedAt, skills: j.skills });
        }
      }
    } catch { /* ignore */ }
  };

  // Flat layout
  collectJobs(join(checkpointDir, "daemon-state.json"));

  // Per-instance layout
  const daemonsDir = join(checkpointDir, "daemons");
  if (existsSync(daemonsDir)) {
    try {
      for (const inst of readdirSync(daemonsDir)) {
        collectJobs(join(daemonsDir, inst, "daemon-state.json"));
      }
    } catch { /* ignore */ }
  }

  if (allJobs.length < 4) return null; // need at least 4 jobs for meaningful comparison

  // Sort by completion time
  allJobs.sort((a, b) => a.completedAt.localeCompare(b.completedAt));

  // Split into halves
  const midpoint = Math.floor(allJobs.length / 2);
  const olderJobs = allJobs.slice(0, midpoint);
  const recentJobs = allJobs.slice(midpoint);

  const olderAvgCost = olderJobs.reduce((s, j) => s + j.costUsd, 0) / olderJobs.length;
  const recentAvgCost = recentJobs.reduce((s, j) => s + j.costUsd, 0) / recentJobs.length;

  const costDelta = recentAvgCost - olderAvgCost;
  const costDeltaPct = olderAvgCost > 0 ? (costDelta / olderAvgCost) * 100 : 0;

  const lines: string[] = ["### Impact Measurement", ""];
  lines.push(`Comparing ${recentJobs.length} recent jobs vs ${olderJobs.length} older jobs:`);
  lines.push(`- Older avg cost: $${olderAvgCost.toFixed(2)}/job`);
  lines.push(`- Recent avg cost: $${recentAvgCost.toFixed(2)}/job`);

  if (costDelta < -0.01) {
    lines.push(`- **Cost improved** by ${Math.abs(costDeltaPct).toFixed(0)}% ($${Math.abs(costDelta).toFixed(2)}/job savings)`);
    lines.push("");
    lines.push("Recent optimizations are working. Continue investing in new capabilities over optimization.");
  } else if (costDelta > 0.01) {
    lines.push(`- **Cost increased** by ${costDeltaPct.toFixed(0)}% ($${costDelta.toFixed(2)}/job increase)`);
    lines.push("");
    lines.push("Costs are trending up. Prioritize measurement, profiling, or optimization work over new features.");
  } else {
    lines.push("- Cost is **stable** (within $0.01/job).");
    lines.push("");
    lines.push("Costs are flat. New features or capability improvements are the best use of effort.");
  }

  return lines.join("\n");
}

// ── Prompt builder ──────────────────────────────────────────────

const PRIORITIZE_RULES = `## Scoring Rubric

Score each backlog item on these dimensions:

| Dimension | Weight | Description |
|-----------|--------|-------------|
| Impact on autonomous run quality | 2x | How much does this improve GaryClaw's ability to run skills autonomously? |
| Wow factor | 2x | Would this make someone say "holy shit" or just "that's tidy"? Would someone star the repo for this? Genuine new capabilities and user-visible features score high. Internal plumbing and refactoring score low. |
| Unblocks other work | 2x | Does completing this enable other high-value items? |
| Effort efficiency | 1x | XS/S items score higher (quick wins); M items acceptable; L/XL score low |
| Dependency readiness | 2x | All dependencies must be met (0 if any dep is unmet) |
| Alignment with overnight goal | 1x | If an overnight goal exists, how well does this align? (0 if no goal) |

Weighted average = sum(score × weight) / sum(weights)

## Output Format

Write \`.garyclaw/priority.md\` with this exact structure:

\`\`\`markdown
# Priority Pick

## Top Pick: [Title]

**Priority:** P[N]
**Effort:** [XS/S/M]
**Weighted Score:** [X.X]/10
**Confidence:** [1-10]

### Why This Item
[2-3 sentences explaining why this is the highest-impact choice right now]

### Scoring Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Autonomous run quality | X | 3x | XX |
| Unblocks other work | X | 2x | XX |
| Effort efficiency | X | 1x | XX |
| Dependency readiness | X | 2x | XX |
| Overnight goal alignment | X | 2x | XX |
| **Total** | | | **XX/100** |

## Alternatives

### 2nd: [Title] — Score: X.X/10
[1 sentence why it's not #1]

### 3rd: [Title] — Score: X.X/10
[1 sentence why it's not #1]

## Skipped Items
- [Title]: [reason — unmet deps / too large / P4 while P2 exists]

### Task Category
{one of: ${VALID_TASK_CATEGORIES.filter(c => c !== "unknown").join(", ")}}

### Recommended Pipeline
implement -> qa

### Pipeline Reasoning
[1-2 sentences explaining why these specific skills were chosen or omitted.
Reference past pipeline outcomes if available in decision history.]

## Backlog Health
- Total items: N
- Actionable (all deps met): N
- Blocked: N
- Exhausted: [yes/no — true if no item scores above 5.0]
\`\`\`

## Confidence Gate

If NO item scores above 5.0/10 weighted average, write to priority.md:

\`\`\`markdown
# Priority Pick

## Backlog Exhausted

No backlog item scores above the 5.0/10 threshold.
The backlog may need new items, dependency resolution, or scope splitting.

### All Scores
[list every item with its score]
\`\`\`

Then STOP. Do not pick an item below the threshold.

## Task Category Guidelines

Classify the task based on its primary nature. Always pick the best-fit category:
${VALID_TASK_CATEGORIES.filter(c => c !== "unknown").map(c => `- ${c}: ${TASK_CATEGORY_DESCRIPTIONS[c]}`).join("\n")}

## Recommended Pipeline Guidelines

After scoring, recommend a pipeline (sequence of skills) for the top pick:
- Consider the item's blast radius (files touched, cross-module impact)
- Consider past pipeline outcomes from decision history (if available)
- When skipping a skill (e.g., office-hours, plan-eng-review), state what evidence supports the skip
- Default to these rules when no pipeline outcome data exists:
  - XS effort: implement -> qa
  - S effort, low priority: implement -> qa
  - S effort, P2-P3 with design doc: implement -> plan-eng-review -> qa
  - S effort, P2-P3 without design doc: office-hours -> implement -> qa
  - M+ effort or P1: prioritize -> office-hours -> implement -> plan-eng-review -> qa
- Use arrow notation: skill1 -> skill2 -> skill3

### Pipeline Outcome History

When you see "Pipeline Outcomes" in the decision history, use them to adjust your
Recommended Pipeline:
- If skipping skill X led to "failure" outcomes (3+ QA issues), include X
- If skipping skill X led to "success" outcomes, continue skipping X
- If mixed results, include X for high-blast-radius items, skip for low-risk
- Weight recent outcomes more heavily than older ones

## Anti-Patterns

- Do NOT pick items with unmet dependencies
- Do NOT pick items that require external services not available
- Do NOT pick items larger than M effort (suggest splitting in priority.md, write the split to TODOS.md)
- Do NOT pick P4 items when P2/P3 items exist
- Do NOT modify any source code — you are read-only except for .garyclaw/priority.md (and TODOS.md for splits)
- When actionable items exist: Do NOT invent — only score what's in TODOS.md or Unresolved Review Findings
- When ALL items score below 5.0 (backlog exhausted): Follow the Invention Protocol below.
- DO give a +2 scoring bonus to unresolved review findings — they are pre-reviewed and pre-approved, zero design work needed
- DO give a +2 scoring bonus to items that fix recurring failure patterns (see Failure Patterns section)
- DO give a +1 scoring bonus to items that build domain knowledge for low-confidence Oracle topics (see Decision Quality Trends section)
- If recent job costs are trending up (see Impact Measurement section), prefer optimization/measurement work over new features

## Invention Protocol (when backlog exhausted)

When ALL backlog items score below 5.0, follow this structured process:

**Step 1 — RESEARCH:** Read the Current Capabilities section carefully.
Identify gaps: what should a "learning development daemon that gets smarter
every run" be able to do that it can't do today? Review the Failure Patterns
and Decision Quality Trends for recurring pain points.

**Step 2 — INVENT:** Write 3-5 candidate P3 items to TODOS.md.
Each must have: title, What, Why, Effort, Depends on.

**Step 3 — CRITIQUE:** For EACH candidate, answer:
- Does this already exist? (check Current Capabilities — if yes, DISCARD immediately)
- Does this address a known failure pattern? (check Failure Patterns section)
- Would a user actually notice this improvement?
- Is this incremental polish or a genuine new capability?
- Score 1-10 on "would I be proud to show this to the project owner?"

**Step 4 — PRUNE:** Remove candidates scoring below 7 on the pride test.
If none remain, think bigger — you're being too incremental.

**Step 5 — SCORE:** Score remaining candidates using the standard rubric above,
then pick the highest-scoring one as your Top Pick.

Write the full critique reasoning (Steps 3-4) into priority.md under a
\`### Invention Critique\` section so the reasoning is auditable`;

const WORKED_EXAMPLE = `## Worked Example

Given a TODOS.md with:
- P2: Stale PID cleanup (XS, depends on Phase 4a ✓)
- P3: Codebase Summary Persistence (S, depends on Phase 1a ✓)
- P3: Adaptive maxTurns (XS, depends on Phase 1a ✓)
- P3: Memory-Informed Scheduling (M, depends on Phase 5b ✓, Phase 4b ✗)
- P4: Shutdown AbortSignal (XS, depends on Phase 4a ✓)

Expected output in priority.md:

\`\`\`markdown
# Priority Pick

## Top Pick: Stale PID cleanup

**Priority:** P2
**Effort:** XS
**Weighted Score:** 7.8/10
**Confidence:** 9

### Why This Item
Highest priority (P2) with XS effort and all dependencies met. Directly improves
daemon reliability for production use. Quick win that clears the only remaining P2 item.

### Scoring Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Autonomous run quality | 7 | 2x | 14 |
| Wow factor | 4 | 2x | 8 |
| Unblocks other work | 6 | 2x | 12 |
| Effort efficiency | 10 | 1x | 10 |
| Dependency readiness | 10 | 2x | 20 |
| Overnight goal alignment | 5 | 1x | 5 |
| **Total** | | | **69/100 = 6.9** |

## Alternatives

### 2nd: Adaptive maxTurns — Score: 6.5/10
XS effort P3 with all deps met, but lower priority tier than the P2 item.

### 3rd: Codebase Summary Persistence — Score: 6.0/10
S effort P3 — more impactful long-term but more effort than the top two picks.

## Skipped Items
- Memory-Informed Scheduling: unmet dependency (Phase 4b incomplete)
- Shutdown AbortSignal: P4 item — P2/P3 items exist

## Backlog Health
- Total items: 5
- Actionable: 3
- Blocked: 1
- Exhausted: no
\`\`\``;

/**
 * Build the full prioritize prompt from backlog + context.
 * Uses a waterfall token budget: sections assembled in priority order,
 * each with a soft cap. Unused budget from empty/small sections flows
 * to later sections. Total prompt guaranteed <= PRIORITIZE_PROMPT_BUDGET.
 */
export async function buildPrioritizePrompt(
  config: GaryClawConfig,
  previousSkills: PipelineSkillEntry[],
  projectDir: string,
): Promise<string> {
  const lines: string[] = [];
  let tokensUsed = 0;
  const remaining = () => PRIORITIZE_PROMPT_BUDGET - tokensUsed;
  const SB = PRIORITIZE_SECTION_BUDGETS;
  const sectionTokens: Record<string, number> = {};

  // Fixed: system instruction
  const sysInstruction =
    "You are a technical product manager triaging a development backlog. " +
    "Your job is to pick the single highest-impact item to build next.";
  lines.push(sysInstruction);
  lines.push("");
  tokensUsed += estimateTokens(sysInstruction);

  // Phase 1 — READ instructions
  const phase1Header = "## Phase 1 — READ\n\nRead the following inputs carefully before scoring:";
  lines.push(phase1Header);
  lines.push("");
  tokensUsed += estimateTokens(phase1Header);

  // Budgeted: TODOS.md content (filtered to open items only)
  const todosPath = join(projectDir, "TODOS.md");
  const todosContent = safeReadText(todosPath);
  const filteredTodos = todosContent ? filterOpenTodos(todosContent) : null;
  if (filteredTodos) {
    const t = addBudgetedSection(lines, "### Backlog (TODOS.md)",
      filteredTodos, SB.todos, remaining(), false);
    tokensUsed += t;
    sectionTokens.todos = t;
  } else {
    lines.push("### Backlog (TODOS.md)");
    lines.push("");
    lines.push("*No TODOS.md found. Read the project's TODOS.md, CLAUDE.md, and recent git log to understand the backlog.*");
    lines.push("");
  }

  // Budgeted: Product vision + capabilities from CLAUDE.md
  const claudeMdPath = join(projectDir, "CLAUDE.md");
  const claudeMdContent = safeReadText(claudeMdPath);
  if (claudeMdContent) {
    // Extract the description section (everything before the first ---)
    const descriptionEnd = claudeMdContent.indexOf("\n---");
    const vision = descriptionEnd > 0 ? claudeMdContent.slice(0, descriptionEnd).trim() : claudeMdContent.slice(0, 2000);

    const visionBlock = vision +
      "\n\nWhen the backlog is exhausted, use this vision to invent new features that move the product forward. Write invented items to TODOS.md before scoring them." +
      "\nIMPORTANT: Do NOT invent features that already exist. Check the Current Capabilities section below — these describe everything the system already does.";

    const tVision = addBudgetedSection(lines, "### Product Vision (from CLAUDE.md)",
      visionBlock, SB.vision, remaining(), false);
    tokensUsed += tVision;
    sectionTokens.vision = tVision;

    // Inject current capabilities from CLAUDE.md — the system's self-description.
    const statusMatch = claudeMdContent.match(/## Current Status\n([\s\S]*?)(?=\n---)/);
    const moduleMatch = claudeMdContent.match(/### Module Map\n([\s\S]*?)(?=\n### )/);
    const decisionsMatch = claudeMdContent.match(/### Key Design Decisions\n([\s\S]*?)(?=\n---)/);
    const capabilities = [statusMatch?.[1], moduleMatch?.[1], decisionsMatch?.[1]].filter(Boolean).join("\n\n");
    if (capabilities) {
      const capBlock = "The system already has these features. Do NOT re-invent any of them:\n\n" + capabilities;
      const tCap = addBudgetedSection(lines, "### Current Capabilities (from CLAUDE.md)",
        capBlock, SB.capabilities, remaining(), false);
      tokensUsed += tCap;
      sectionTokens.capabilities = tCap;
    }
  }

  // Budgeted: Overnight goal
  const goal = loadOvernightGoal(projectDir);
  if (goal) {
    const tGoal = addBudgetedSection(lines, "### Overnight Goal",
      goal, SB.overnightGoal, remaining(), false);
    tokensUsed += tGoal;
    sectionTokens.overnightGoal = tGoal;
  }

  // Budgeted: Oracle context (metrics + outcomes)
  if (!config.noMemory) {
    const oracleCtx = loadOracleContext(projectDir);
    if (oracleCtx) {
      // keepEnd=true: drop oldest decision outcomes, preserve recent ones
      const tOracle = addBudgetedSection(lines, "### Oracle Intelligence",
        oracleCtx, SB.oracleContext, remaining(), true);
      tokensUsed += tOracle;
      sectionTokens.oracleContext = tOracle;
    }
  }

  // Budgeted: Deep context sections
  const gcDir = join(projectDir, ".garyclaw");

  const failurePatterns = aggregateFailurePatterns(gcDir);
  if (failurePatterns) {
    const tFail = addBudgetedSection(lines, "",
      failurePatterns, SB.failurePatterns, remaining());
    tokensUsed += tFail;
    sectionTokens.failurePatterns = tFail;
  }

  const qualityTrends = getDecisionQualityTrends(projectDir);
  if (qualityTrends) {
    const tQual = addBudgetedSection(lines, "",
      qualityTrends, SB.qualityTrends, remaining());
    tokensUsed += tQual;
    sectionTokens.qualityTrends = tQual;
  }

  const impact = measureRecentImpact(gcDir);
  if (impact) {
    const tImpact = addBudgetedSection(lines, "",
      impact, SB.impactMeasurement, remaining());
    tokensUsed += tImpact;
    sectionTokens.impactMeasurement = tImpact;
  }

  // Budgeted: Pipeline context (previous skill findings)
  const pipelineCtx = formatPipelineContext(previousSkills);
  if (pipelineCtx) {
    const tPipe = addBudgetedSection(lines, "### Previous Skill Findings",
      pipelineCtx, SB.pipelineContext, remaining());
    tokensUsed += tPipe;
    sectionTokens.pipelineContext = tPipe;
  }

  // Budgeted: Unresolved review findings
  const reviewFindings = loadUnresolvedReviewFindings(gcDir);
  if (reviewFindings.length > 0) {
    const rfLines: string[] = [
      "These fixes were accepted in recent eng/CEO reviews but never implemented.",
      "**Score these with a +2 bonus** on 'Autonomous run quality' because they are pre-reviewed and approved.",
      "",
    ];
    for (const f of reviewFindings) {
      rfLines.push(`- **${f.accepted}** (confidence: ${f.confidence}/10, from ${f.jobId})`);
      rfLines.push(`  Context: ${f.question.slice(0, 200)}${f.question.length > 200 ? "..." : ""}`);
    }
    const tReview = addBudgetedSection(lines, "### Unresolved Review Findings",
      rfLines.join("\n"), SB.reviewFindings, remaining());
    tokensUsed += tReview;
    sectionTokens.reviewFindings = tReview;
  }

  // Fixed: Pre-assigned item (small, essential for correctness)
  if (config.preAssignedTodoTitle) {
    const preBlock = [
      "### Pre-Assigned Item",
      "",
      `**You are assigned to work on: "${config.preAssignedTodoTitle}"**`,
      "",
      "This item was pre-assigned by the daemon to avoid duplicate work across parallel instances.",
      "Score this item using the rubric below and write it as your Top Pick in priority.md.",
      "If this item is genuinely blocked or already complete, explain why and pick the next best item instead.",
      "",
    ].join("\n");
    lines.push(preBlock);
    tokensUsed += estimateTokens(preBlock);
  }

  // Fixed: Claimed items (small, essential for correctness)
  const claimedItems = config.claimedTodoItems;
  if (claimedItems && claimedItems.length > 0) {
    const claimLines = [
      "### Already Claimed by Other Instances",
      "",
      "These items are actively being implemented by parallel daemon instances.",
      "**Do NOT pick them.** Score claimed items as 0/10 on ALL dimensions.",
      "",
    ];
    for (const item of claimedItems) {
      claimLines.push(`- **${item.title}** (instance: ${item.instanceName})`);
    }
    claimLines.push("");
    const claimBlock = claimLines.join("\n");
    lines.push(claimBlock);
    tokensUsed += estimateTokens(claimBlock);
  }

  // Phase 2+3 — SCORE and RANK instructions
  const phase2Header = "## Phase 2 — SCORE\n\nAlso read CLAUDE.md, any recent QA reports in `.gstack/qa-reports/`, and `git log --oneline -20` to understand the project's current state. Then score each backlog item against the rubric below.";
  lines.push(phase2Header);
  lines.push("");
  tokensUsed += estimateTokens(phase2Header);

  // Budgeted: Skill catalog
  const skillCatalog = formatSkillCatalogForPrompt();
  const skillBlock = skillCatalog +
    "\n\nWhen recommending a pipeline in the \"### Recommended Pipeline\" section, " +
    "choose from the skills above based on the task's nature. " +
    "Consider: visual/UI tasks benefit from design-review. " +
    "Architectural changes need plan-eng-review. " +
    "Bug fixes and small refactors need only implement → qa.";
  const tSkill = addBudgetedSection(lines, "## Available Skills",
    skillBlock, SB.skillCatalog, remaining(), false);
  tokensUsed += tSkill;
  sectionTokens.skillCatalog = tSkill;

  // Budgeted: Per-category pipeline outcome stats (only inject with 10+ outcomes)
  const outcomeHistoryPath = join(projectDir, ".garyclaw", "pipeline-outcomes.jsonl");
  const outcomes = readPipelineOutcomes(outcomeHistoryPath);
  if (outcomes.length >= 10) {
    const categoryStats = computeCategoryStats(outcomes);
    if (categoryStats.length > 0) {
      const statsLines: string[] = [
        "| Category | Skill | When Skipped (fail%) | When Included (fail%) | Delta |",
        "|----------|-------|---------------------|----------------------|-------|",
      ];
      for (const s of categoryStats.slice(0, 15)) {
        const delta = s.skippedFailureRate - s.includedFailureRate;
        statsLines.push(`| ${s.category} | ${s.skill} | ${s.skippedCount} jobs (${s.skippedFailureRate.toFixed(0)}% fail) | ${s.includedCount} jobs (${s.includedFailureRate.toFixed(0)}% fail) | ${delta > 0 ? "+" : ""}${delta.toFixed(0)}pp |`);
      }
      statsLines.push("");
      statsLines.push("Use these patterns when recommending pipelines. High delta means the skill matters for that category.");
      const tStats = addBudgetedSection(lines, "### Pipeline Outcome Patterns by Task Category",
        statsLines.join("\n"), SB.pipelineStats, remaining());
      tokensUsed += tStats;
      sectionTokens.pipelineStats = tStats;
    }
  }

  // Phase 3+4 — RANK and OUTPUT
  const phase34 = "## Phase 3 — RANK\n\nProduce a ranked list with scores and reasoning.\n\n## Phase 4 — OUTPUT\n\nWrite `.garyclaw/priority.md` following the exact format below.";
  lines.push(phase34);
  lines.push("");
  tokensUsed += estimateTokens(phase34);

  // Budgeted: Project type awareness
  const ptSection = buildProjectTypeSection(projectDir);
  if (ptSection) {
    const tPt = addBudgetedSection(lines, "",
      ptSection, SB.projectType, remaining(), false);
    tokensUsed += tPt;
    sectionTokens.projectType = tPt;
  }

  // Fixed: Rules + format + worked example (always included — essential, counted for budget accuracy)
  lines.push(PRIORITIZE_RULES);
  lines.push("");
  const rulesTokens = estimateTokens(PRIORITIZE_RULES);
  tokensUsed += rulesTokens;
  sectionTokens.rules = rulesTokens;
  lines.push(WORKED_EXAMPLE);
  lines.push("");
  const exampleTokens = estimateTokens(WORKED_EXAMPLE);
  tokensUsed += exampleTokens;
  sectionTokens.workedExample = exampleTokens;

  const prompt = lines.join("\n");
  const totalTokens = estimateTokens(prompt);

  // Emit prompt size event for observability
  if (config.onEvent) {
    config.onEvent({
      type: "prioritize_prompt_size",
      tokens: totalTokens,
      sections: sectionTokens,
    });
  }

  return prompt;
}
