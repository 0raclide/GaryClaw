/**
 * Skill Catalog — static registry of available skills with structured metadata.
 *
 * Hand-maintained. Used by the prioritize prompt to give the Oracle knowledge
 * of what skills exist beyond the 5 hardcoded in pipeline-compose.ts.
 * Auto-discovery from ~/.claude/skills/ is a future enhancement.
 */

export interface SkillEntry {
  name: string;           // e.g. "design-review"
  description: string;    // 1-2 sentence: what it does
  useWhen: string;        // when to include in pipeline
  produces: string;       // what artifact/output it creates
  costUsd: number;        // approximate cost per run
  mode: "plan" | "exec";  // plan-mode review vs execution skill
}

export const SKILL_CATALOG: SkillEntry[] = [
  {
    name: "prioritize",
    description: "Picks the highest-impact backlog item from TODOS.md.",
    useWhen: "Always first in autonomous pipelines. Skip when TODO is already chosen.",
    produces: ".garyclaw/priority.md with scoring breakdown",
    costUsd: 0.30,
    mode: "exec",
  },
  {
    name: "office-hours",
    description: "Design thinking session. Produces a design doc with problem statement, approaches, and recommended implementation.",
    useWhen: "New features (M+ effort), architectural changes, or tasks with unclear scope. Skip for bug fixes, XS/S refactors, or tasks with existing design docs.",
    produces: "docs/designs/{slug}.md",
    costUsd: 0.80,
    mode: "plan",
  },
  {
    name: "implement",
    description: "Writes code from a design doc or TODO description. Auto-discovers design docs in docs/designs/.",
    useWhen: "Always. Every pipeline needs implementation.",
    produces: "Code changes committed to branch",
    costUsd: 1.50,
    mode: "exec",
  },
  {
    name: "plan-eng-review",
    description: "Engineering architecture review. Checks data flow, edge cases, test coverage, performance.",
    useWhen: "Architectural changes, shared interface modifications, M+ effort items, items touching types.ts or cross-module boundaries.",
    produces: "Review findings appended to design doc",
    costUsd: 0.60,
    mode: "plan",
  },
  {
    name: "plan-ceo-review",
    description: "Product/strategy review. Challenges scope, finds the 10-star version, rethinks the problem.",
    useWhen: "New product features, scope decisions, user-facing changes. Skip for internal refactors or bug fixes.",
    produces: "Scope decisions and product direction in design doc",
    costUsd: 0.60,
    mode: "plan",
  },
  {
    name: "plan-design-review",
    description: "UI/UX design review in plan mode. Rates visual dimensions, identifies hierarchy/spacing/interaction issues.",
    useWhen: "Tasks with UI components, visual changes, new screens or flows. Skip for backend-only or infra work.",
    produces: "Design review findings in design doc",
    costUsd: 0.60,
    mode: "plan",
  },
  {
    name: "design-review",
    description: "Live visual QA. Takes screenshots, finds spacing issues, hierarchy problems, AI slop patterns. Fixes issues in source code.",
    useWhen: "After implement, when the task has visual/UI output. Skip for CLI tools, backend services, or non-visual changes.",
    produces: "Committed fixes for visual issues",
    costUsd: 0.80,
    mode: "exec",
  },
  {
    name: "qa",
    description: "Systematic QA testing. Finds bugs, verifies fixes, produces health score.",
    useWhen: "Always last in pipeline. Every pipeline needs QA.",
    produces: "QA report with issue list and health score",
    costUsd: 0.80,
    mode: "exec",
  },
  {
    name: "bootstrap",
    description: "Cold-start analysis for new repos. Generates CLAUDE.md and TODOS.md from codebase analysis.",
    useWhen: "First run on a new project with no CLAUDE.md. Skip if CLAUDE.md already exists.",
    produces: "CLAUDE.md + TODOS.md",
    costUsd: 0.50,
    mode: "exec",
  },
  {
    name: "evaluate",
    description: "Dogfood campaign evaluator. Scores bootstrap quality, oracle performance, pipeline health.",
    useWhen: "After a full pipeline cycle on an external repo. Skip for self-improvement runs.",
    produces: "Evaluation report + improvement candidates",
    costUsd: 0.40,
    mode: "exec",
  },
];

/**
 * Format the skill catalog as a markdown section for injection into the prioritize prompt.
 * Groups skills by mode (Review Skills vs Execution Skills) for Oracle clarity.
 */
export function formatSkillCatalogForPrompt(): string {
  const planSkills = SKILL_CATALOG.filter(s => s.mode === "plan");
  const execSkills = SKILL_CATALOG.filter(s => s.mode === "exec");

  const lines: string[] = [];

  lines.push("### Review Skills (plan mode — produce findings, not code)");
  lines.push("");
  lines.push("| Skill | Description | Use When | Produces | Cost |");
  lines.push("|-------|-------------|----------|----------|------|");
  for (const s of planSkills) {
    lines.push(`| ${s.name} | ${s.description} | ${s.useWhen} | ${s.produces} | $${s.costUsd.toFixed(2)} |`);
  }
  lines.push("");

  lines.push("### Execution Skills (exec mode — produce code or artifacts)");
  lines.push("");
  lines.push("| Skill | Description | Use When | Produces | Cost |");
  lines.push("|-------|-------------|----------|----------|------|");
  for (const s of execSkills) {
    lines.push(`| ${s.name} | ${s.description} | ${s.useWhen} | ${s.produces} | $${s.costUsd.toFixed(2)} |`);
  }

  return lines.join("\n");
}
