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

import { safeReadText, safeReadJSON } from "./safe-json.js";
import { readOracleMemory, readMetrics, defaultMemoryConfig } from "./oracle-memory.js";
import { estimateTokens } from "./checkpoint.js";
import type { GaryClawConfig, PipelineSkillEntry, OracleMetrics } from "./types.js";

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

// ── Prompt builder ──────────────────────────────────────────────

const PRIORITIZE_RULES = `## Scoring Rubric

Score each backlog item on these dimensions:

| Dimension | Weight | Description |
|-----------|--------|-------------|
| Impact on autonomous run quality | 3x | How much does this improve GaryClaw's ability to run skills autonomously? |
| Unblocks other work | 2x | Does completing this enable other high-value items? |
| Effort efficiency | 1x | XS/S items score higher (quick wins); M items acceptable; L/XL score low |
| Dependency readiness | 2x | All dependencies must be met (0 if any dep is unmet) |
| Alignment with overnight goal | 2x | If an overnight goal exists, how well does this align? (0 if no goal) |

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
- Do NOT invent backlog items — only score what's in TODOS.md or Unresolved Review Findings
- DO give a +2 scoring bonus to unresolved review findings — they are pre-reviewed and pre-approved, zero design work needed`;

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
| Autonomous run quality | 7 | 3x | 21 |
| Unblocks other work | 6 | 2x | 12 |
| Effort efficiency | 10 | 1x | 10 |
| Dependency readiness | 10 | 2x | 20 |
| Overnight goal alignment | 5 | 2x | 10 |
| **Total** | | | **73/100 = 7.3** |

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
 */
export async function buildPrioritizePrompt(
  config: GaryClawConfig,
  previousSkills: PipelineSkillEntry[],
  projectDir: string,
): Promise<string> {
  const lines: string[] = [];

  lines.push(
    "You are a technical product manager triaging a development backlog. " +
    "Your job is to pick the single highest-impact item to build next.",
  );
  lines.push("");

  // Phase 1 — READ instructions
  lines.push("## Phase 1 — READ");
  lines.push("");
  lines.push("Read the following inputs carefully before scoring:");
  lines.push("");

  // TODOS.md content
  const todosPath = join(projectDir, "TODOS.md");
  const todosContent = safeReadText(todosPath);
  if (todosContent) {
    lines.push("### Backlog (TODOS.md)");
    lines.push("");
    lines.push(todosContent);
    lines.push("");
  } else {
    lines.push("### Backlog (TODOS.md)");
    lines.push("");
    lines.push("*No TODOS.md found. Read the project's TODOS.md, CLAUDE.md, and recent git log to understand the backlog.*");
    lines.push("");
  }

  // Product vision from CLAUDE.md (guides invention when backlog is exhausted)
  const claudeMdPath = join(projectDir, "CLAUDE.md");
  const claudeMdContent = safeReadText(claudeMdPath);
  if (claudeMdContent) {
    // Extract the description section (everything before the first ---)
    const descriptionEnd = claudeMdContent.indexOf("\n---");
    const vision = descriptionEnd > 0 ? claudeMdContent.slice(0, descriptionEnd).trim() : claudeMdContent.slice(0, 2000);
    lines.push("### Product Vision (from CLAUDE.md)");
    lines.push("");
    lines.push(vision);
    lines.push("");
    lines.push("When the backlog is exhausted, use this vision to invent new features that move the product forward. Write invented items to TODOS.md before scoring them.");
    lines.push("");
  }

  // Overnight goal
  const goal = loadOvernightGoal(projectDir);
  if (goal) {
    lines.push("### Overnight Goal");
    lines.push("");
    lines.push(goal);
    lines.push("");
  }

  // Oracle context (metrics + outcomes)
  if (!config.noMemory) {
    const oracleCtx = loadOracleContext(projectDir);
    if (oracleCtx) {
      lines.push("### Oracle Intelligence");
      lines.push("");
      lines.push(oracleCtx);
      lines.push("");
    }
  }

  // Pipeline context (previous skill findings)
  const pipelineCtx = formatPipelineContext(previousSkills);
  if (pipelineCtx) {
    lines.push("### Previous Skill Findings");
    lines.push("");
    lines.push(pipelineCtx);
    lines.push("");
  }

  // Unresolved review findings (accepted fixes from recent eng/CEO reviews)
  const gcDir = join(projectDir, ".garyclaw");
  const reviewFindings = loadUnresolvedReviewFindings(gcDir);
  if (reviewFindings.length > 0) {
    lines.push("### Unresolved Review Findings");
    lines.push("");
    lines.push("These fixes were accepted in recent eng/CEO reviews but never implemented.");
    lines.push("**Score these with a +2 bonus** on 'Autonomous run quality' because they are pre-reviewed and approved.");
    lines.push("");
    for (const f of reviewFindings) {
      lines.push(`- **${f.accepted}** (confidence: ${f.confidence}/10, from ${f.jobId})`);
      lines.push(`  Context: ${f.question.slice(0, 200)}${f.question.length > 200 ? "..." : ""}`);
    }
    lines.push("");
  }

  // Pre-assigned item (from parallel daemon pre-claim) or claimed items
  if (config.preAssignedTodoTitle) {
    lines.push("### Pre-Assigned Item");
    lines.push("");
    lines.push(`**You are assigned to work on: "${config.preAssignedTodoTitle}"**`);
    lines.push("");
    lines.push("This item was pre-assigned by the daemon to avoid duplicate work across parallel instances.");
    lines.push("Score this item using the rubric below and write it as your Top Pick in priority.md.");
    lines.push("If this item is genuinely blocked or already complete, explain why and pick the next best item instead.");
    lines.push("");
  }

  // Claimed items from parallel daemon instances (fallback if no pre-assignment)
  const claimedItems = config.claimedTodoItems;
  if (claimedItems && claimedItems.length > 0) {
    lines.push("### Already Claimed by Other Instances");
    lines.push("");
    lines.push("These items are actively being implemented by parallel daemon instances.");
    lines.push("**Do NOT pick them.** Score claimed items as 0/10 on ALL dimensions.");
    lines.push("");
    for (const item of claimedItems) {
      lines.push(`- **${item.title}** (instance: ${item.instanceName})`);
    }
    lines.push("");
  }

  // Phase 2+3 — SCORE and RANK instructions
  lines.push("## Phase 2 — SCORE");
  lines.push("");
  lines.push("Also read CLAUDE.md, any recent QA reports in `.gstack/qa-reports/`, and `git log --oneline -20` to understand the project's current state. Then score each backlog item against the rubric below.");
  lines.push("");

  // Phase 4 — OUTPUT
  lines.push("## Phase 3 — RANK");
  lines.push("");
  lines.push("Produce a ranked list with scores and reasoning.");
  lines.push("");

  lines.push("## Phase 4 — OUTPUT");
  lines.push("");
  lines.push("Write `.garyclaw/priority.md` following the exact format below.");
  lines.push("");

  // Rules + format + worked example
  lines.push(PRIORITIZE_RULES);
  lines.push("");
  lines.push(WORKED_EXAMPLE);
  lines.push("");

  return lines.join("\n");
}
