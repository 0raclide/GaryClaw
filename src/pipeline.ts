/**
 * Pipeline — sequential skill chaining with context passing.
 *
 * `garyclaw run qa design-review ship` runs each skill to completion,
 * passing a context summary from skill N to skill N+1.
 *
 * Pipeline state is persisted to `.garyclaw/pipeline.json` so a crashed
 * pipeline can resume from the last completed skill.
 */

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { runSkill } from "./orchestrator.js";
import { buildReport } from "./report.js";
import { readCheckpoint } from "./checkpoint.js";
import { safeReadJSON, safeWriteJSON } from "./safe-json.js";
import { buildImplementPrompt } from "./implement.js";

import type {
  GaryClawConfig,
  OrchestratorCallbacks,
  PipelineState,
  PipelineReport,
  RunReport,
  Checkpoint,
} from "./types.js";

const PIPELINE_FILE = "pipeline.json";

// ── Pipeline state persistence ──────────────────────────────────

export function writePipelineState(state: PipelineState, dir: string): void {
  safeWriteJSON(join(dir, PIPELINE_FILE), state);
}

export function readPipelineState(dir: string): PipelineState | null {
  return safeReadJSON<PipelineState>(join(dir, PIPELINE_FILE), validatePipelineState);
}

export function validatePipelineState(data: unknown): data is PipelineState {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.version === 1 &&
    typeof d.pipelineId === "string" &&
    Array.isArray(d.skills) &&
    typeof d.currentSkillIndex === "number" &&
    typeof d.startTime === "string" &&
    typeof d.totalCostUsd === "number" &&
    typeof d.autonomous === "boolean"
  );
}

// ── Context handoff ─────────────────────────────────────────────

/**
 * Build a context handoff prompt for the next skill in the pipeline.
 * Summarizes what the previous skill found/fixed/decided.
 */
export function buildContextHandoff(
  prevSkillName: string,
  prevReport: RunReport,
  nextSkillName: string,
): string {
  const lines: string[] = [];

  lines.push(`Previous skill /${prevSkillName} completed. Here's what it found:`);
  lines.push("");

  // Issues summary
  const open = prevReport.issues.filter((i) => i.status === "open");
  const fixed = prevReport.issues.filter((i) => i.status === "fixed");
  if (prevReport.issues.length > 0) {
    lines.push(`## Issues from /${prevSkillName}`);
    if (fixed.length > 0) {
      lines.push(`- ${fixed.length} issues fixed`);
    }
    if (open.length > 0) {
      lines.push(`- ${open.length} issues still open:`);
      for (const issue of open) {
        lines.push(`  - ${issue.id} [${issue.severity}]: ${issue.description}`);
        if (issue.filePath) lines.push(`    File: ${issue.filePath}`);
      }
    }
    lines.push("");
  }

  // Key decisions
  if (prevReport.decisions.length > 0) {
    const recentDecisions = prevReport.decisions.slice(-5);
    lines.push(`## Key Decisions (last ${recentDecisions.length})`);
    for (const d of recentDecisions) {
      lines.push(`- ${d.question} → ${d.chosen}`);
    }
    lines.push("");
  }

  // Findings
  if (prevReport.findings.length > 0) {
    lines.push(`## Findings`);
    for (const f of prevReport.findings) {
      lines.push(`- [${f.category}] ${f.description}`);
    }
    lines.push("");
  }

  // Cost/session summary
  lines.push(`## Run Stats`);
  lines.push(`- Sessions: ${prevReport.totalSessions}, Turns: ${prevReport.totalTurns}`);
  lines.push(`- Cost: $${prevReport.estimatedCostUsd.toFixed(3)}`);
  lines.push("");

  lines.push(`Now run the /${nextSkillName} skill. Follow all SKILL.md instructions completely.`);

  return lines.join("\n");
}

// ── Office hours prompt for pipeline ────────────────────────────

/**
 * Build a prompt for /office-hours when it appears in a pipeline.
 * Reads priority.md (from prioritize skill) and primes office-hours
 * with the chosen item as context. Instructs it to write the design
 * doc to docs/designs/ so implement can auto-discover it.
 */
function buildOfficeHoursPrompt(projectDir: string): string {
  const lines: string[] = [];

  // Read priority.md if it exists
  const priorityPath = join(projectDir, ".garyclaw", "priority.md");
  let priorityContent: string | null = null;
  if (existsSync(priorityPath)) {
    try {
      priorityContent = readFileSync(priorityPath, "utf-8");
    } catch { /* ignore */ }
  }

  lines.push("Run the /office-hours skill in builder mode.");
  lines.push("");

  if (priorityContent) {
    lines.push("## Context: Priority Pick from Backlog");
    lines.push("");
    lines.push("The prioritize skill selected this item as the highest-impact work to do next:");
    lines.push("");
    lines.push(priorityContent);
    lines.push("");
    lines.push("Use this as the problem statement for office-hours. Skip the initial \"what's your goal?\" question — the goal is to design a solution for the priority pick above.");
    lines.push("Select builder mode (Phase 2B) automatically.");
  } else {
    lines.push("Read TODOS.md and CLAUDE.md to understand the project, then design the highest-impact improvement.");
  }

  lines.push("");
  lines.push("## Important: Design Doc Location");
  lines.push("");
  lines.push("Write the design doc to `docs/designs/` in the project directory (NOT to ~/.gstack/projects/).");
  lines.push("The implement skill auto-discovers the most recently modified file in docs/designs/.");
  lines.push("Use filename format: `docs/designs/{topic-slug}.md`");
  lines.push("");
  lines.push("## Autonomous Mode");
  lines.push("");
  lines.push("This is running autonomously in a daemon pipeline. Answer all AskUserQuestion prompts yourself using your best judgment. Do not wait for human input.");

  return lines.join("\n");
}

// ── Pipeline runner ─────────────────────────────────────────────

/**
 * Run a pipeline of skills sequentially. Each skill runs to completion
 * (including relays) before the next starts. Context passes between skills.
 */
export async function runPipeline(
  skillNames: string[],
  config: GaryClawConfig,
  callbacks: OrchestratorCallbacks,
): Promise<void> {
  const pipelineId = `pipeline-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const startTime = new Date().toISOString();

  const state: PipelineState = {
    version: 1,
    pipelineId,
    skills: skillNames.map((name) => ({
      skillName: name,
      status: "pending" as const,
    })),
    currentSkillIndex: 0,
    startTime,
    totalCostUsd: 0,
    autonomous: config.autonomous,
  };

  writePipelineState(state, config.checkpointDir);

  await executePipelineFrom(state, config, callbacks);
}

/**
 * Resume a pipeline from its persisted state.
 */
export async function resumePipeline(
  checkpointDir: string,
  config: GaryClawConfig,
  callbacks: OrchestratorCallbacks,
): Promise<void> {
  const state = readPipelineState(checkpointDir);
  if (!state) {
    callbacks.onEvent({
      type: "error",
      message: `No valid pipeline state found in ${checkpointDir}`,
      recoverable: false,
    });
    return;
  }

  // Advance past any completed or failed skills to find the resume point.
  // Failed skills are retried on resume (status reset to pending).
  let resumeIndex = 0;
  for (let i = 0; i < state.skills.length; i++) {
    if (state.skills[i].status === "complete") {
      resumeIndex = i + 1;
    } else if (state.skills[i].status === "failed") {
      // Resume from the failed skill (retry it)
      state.skills[i].status = "pending";
      resumeIndex = i;
      break;
    } else {
      break;
    }
  }
  state.currentSkillIndex = resumeIndex;

  await executePipelineFrom(state, config, callbacks);
}

/**
 * Execute pipeline starting from state.currentSkillIndex.
 */
async function executePipelineFrom(
  state: PipelineState,
  config: GaryClawConfig,
  callbacks: OrchestratorCallbacks,
): Promise<void> {
  const totalSkills = state.skills.length;

  // Track git HEAD at pipeline start for cross-skill change detection
  let lastKnownHead = getGitHead(config.projectDir);

  for (let i = state.currentSkillIndex; i < totalSkills; i++) {
    const entry = state.skills[i];
    const skillName = entry.skillName;

    // Check if HEAD changed since last skill (cross-pipeline or external commits)
    let headChangeNote: string | null = null;
    if (i > 0 && lastKnownHead) {
      const currentHead = getGitHead(config.projectDir);
      if (currentHead && currentHead !== lastKnownHead) {
        const diffSummary = getGitDiffSummary(config.projectDir, lastKnownHead, currentHead);
        const commitCount = diffSummary ? diffSummary.split("\n").length : 0;
        headChangeNote = `Note: ${commitCount} commit(s) landed since the previous skill ran.`;
        if (diffSummary) {
          headChangeNote += ` Recent commits:\n${diffSummary}`;
        }
        headChangeNote += "\nReview the diff before proceeding — some findings from the previous skill may already be addressed.";
        lastKnownHead = currentHead;
      }
    }

    // Update state
    entry.status = "running";
    entry.startTime = new Date().toISOString();
    state.currentSkillIndex = i;
    writePipelineState(state, config.checkpointDir);

    callbacks.onEvent({
      type: "pipeline_skill_start",
      skillName,
      skillIndex: i,
      totalSkills,
    });

    // Build skill-specific config with its own checkpoint subdirectory
    const skillCheckpointDir = join(config.checkpointDir, `skill-${i}-${skillName}`);
    const skillConfig: GaryClawConfig = {
      ...config,
      skillName,
      checkpointDir: skillCheckpointDir,
    };

    // Build prompt: implement gets a special prompt, others get context handoff
    const prevEntry = i > 0 ? state.skills[i - 1] : null;
    try {
      if (skillName === "prioritize") {
        const { buildPrioritizePrompt } = await import("./prioritize.js");
        const prevSkills = state.skills.slice(0, i);
        const priorityPrompt = await buildPrioritizePrompt(config, prevSkills, config.projectDir);
        await runSkillWithPrompt(skillConfig, callbacks, priorityPrompt);
      } else if (skillName === "office-hours") {
        // office-hours runs as a gstack skill (SKILL.md loaded by SDK).
        // We prime it with context from priority.md so it designs the right thing.
        const officeHoursPrompt = buildOfficeHoursPrompt(config.projectDir);
        await runSkillWithPrompt(skillConfig, callbacks, officeHoursPrompt);
      } else if (skillName === "implement") {
        const prevSkills = state.skills.slice(0, i);
        // Check for resume checkpoint to pass step progress context
        const implCheckpoint = readCheckpoint(skillCheckpointDir);
        const implPrompt = await buildImplementPrompt(config, prevSkills, config.projectDir, implCheckpoint);
        await runSkillWithPrompt(skillConfig, callbacks, implPrompt);
      } else if (prevEntry?.report) {
        // Override the initial prompt via a custom prompt in the skill config
        // runSkill uses `Run the /${skillName} skill...` as default prompt,
        // but we need to inject context from previous skill.
        // We do this by running with a modified orchestrator prompt.
        let handoffPrompt = buildContextHandoff(
          prevEntry.skillName,
          prevEntry.report,
          skillName,
        );
        // Inject HEAD change context if commits landed between skills
        if (headChangeNote) {
          handoffPrompt = `${headChangeNote}\n\n${handoffPrompt}`;
        }
        await runSkillWithPrompt(skillConfig, callbacks, handoffPrompt);
      } else {
        // No previous report — run with optional HEAD change note
        if (headChangeNote) {
          await runSkillWithPrompt(skillConfig, callbacks,
            `${headChangeNote}\n\nNow run the /${skillName} skill. Follow all SKILL.md instructions completely.`);
        } else {
          await runSkill(skillConfig, callbacks);
        }
      }
    } catch (err) {
      // Mark skill as failed and persist state so resume can skip past it
      const skillEndTime = new Date().toISOString();
      entry.status = "failed";
      entry.endTime = skillEndTime;
      writePipelineState(state, config.checkpointDir);

      callbacks.onEvent({
        type: "error",
        message: `Skill /${skillName} failed: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: true,
      });
      throw err;
    }

    // Read the skill's checkpoint for its report data
    const checkpoint = readCheckpoint(skillCheckpointDir);
    const skillEndTime = new Date().toISOString();
    const skillReport = buildSkillReport(
      checkpoint,
      skillName,
      entry.startTime!,
      skillEndTime,
    );

    entry.status = "complete";
    entry.endTime = skillEndTime;
    entry.report = skillReport;
    state.totalCostUsd += skillReport.estimatedCostUsd;
    writePipelineState(state, config.checkpointDir);

    callbacks.onEvent({
      type: "pipeline_skill_complete",
      skillName,
      skillIndex: i,
      totalSkills,
      costUsd: skillReport.estimatedCostUsd,
    });
  }

  // All skills complete — build pipeline report
  const endTime = new Date().toISOString();
  const pipelineReport = buildPipelineReport(state, endTime);

  mkdirSync(config.checkpointDir, { recursive: true });
  writeFileSync(
    join(config.checkpointDir, "pipeline-report.md"),
    formatPipelineReportMarkdown(pipelineReport),
    "utf-8",
  );

  callbacks.onEvent({
    type: "pipeline_complete",
    totalSkills: state.skills.length,
    totalCostUsd: state.totalCostUsd,
  });
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Run a skill with a custom initial prompt (for context handoff).
 * This patches runSkill's default prompt by temporarily setting skillName
 * to include the handoff context through a wrapper.
 */
async function runSkillWithPrompt(
  config: GaryClawConfig,
  callbacks: OrchestratorCallbacks,
  prompt: string,
): Promise<void> {
  // We leverage the fact that runSkill constructs its prompt from config.skillName.
  // To inject a custom prompt, we use a pipeline-aware version of runSkill.
  // For now, we use runSkillWithInitialPrompt from orchestrator.
  // Since orchestrator doesn't expose prompt override yet, we import and call it.
  const { runSkillWithInitialPrompt } = await import("./orchestrator.js");
  return runSkillWithInitialPrompt(config, callbacks, prompt);
}

/**
 * Build a RunReport from a skill's checkpoint data.
 */
function buildSkillReport(
  checkpoint: Checkpoint | null,
  skillName: string,
  startTime: string,
  endTime: string,
): RunReport {
  if (!checkpoint) {
    return {
      runId: "unknown",
      skillName,
      startTime,
      endTime,
      totalSessions: 0,
      totalTurns: 0,
      estimatedCostUsd: 0,
      issues: [],
      findings: [],
      decisions: [],
      relayPoints: [],
    };
  }

  return buildReport([checkpoint], {
    runId: checkpoint.runId,
    skillName,
    startTime,
    endTime,
    totalSessions: checkpoint.tokenUsage.sessionCount,
    totalTurns: checkpoint.tokenUsage.turnHistory.length,
    estimatedCostUsd: checkpoint.tokenUsage.estimatedCostUsd,
    relayPoints: [],
  });
}

// ── Git HEAD tracking ────────────────────────────────────────────

/**
 * Get the current git HEAD commit hash for the project directory.
 * Returns null if git is unavailable or dir is not a repo.
 */
export function getGitHead(projectDir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectDir,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Get a short summary of commits between two git refs.
 * Returns null if git is unavailable or refs are invalid.
 */
export function getGitDiffSummary(
  projectDir: string,
  fromRef: string,
  toRef: string,
): string | null {
  try {
    const log = execFileSync(
      "git",
      ["log", "--oneline", `${fromRef}..${toRef}`],
      {
        cwd: projectDir,
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).toString().trim();
    return log || null;
  } catch {
    return null;
  }
}

// ── Pipeline report ─────────────────────────────────────────────

export function buildPipelineReport(
  state: PipelineState,
  endTime: string,
): PipelineReport {
  const allIssues = state.skills.flatMap((s) => s.report?.issues ?? []);
  const allFindings = state.skills.flatMap((s) => s.report?.findings ?? []);
  const allDecisions = state.skills.flatMap((s) => s.report?.decisions ?? []);
  const totalSessions = state.skills.reduce(
    (sum, s) => sum + (s.report?.totalSessions ?? 0),
    0,
  );
  const totalTurns = state.skills.reduce(
    (sum, s) => sum + (s.report?.totalTurns ?? 0),
    0,
  );

  // Dedup issues by id (later skill wins)
  const issueMap = new Map<string, typeof allIssues[number]>();
  for (const issue of allIssues) {
    issueMap.set(issue.id, issue);
  }

  // Dedup findings by normalized description
  const findingSeen = new Set<string>();
  const dedupedFindings = allFindings.filter((f) => {
    const key = f.description.toLowerCase().trim();
    if (findingSeen.has(key)) return false;
    findingSeen.add(key);
    return true;
  });

  return {
    pipelineId: state.pipelineId,
    startTime: state.startTime,
    endTime,
    skills: state.skills,
    totalSessions,
    totalTurns,
    totalCostUsd: state.totalCostUsd,
    issues: Array.from(issueMap.values()),
    findings: dedupedFindings,
    decisions: allDecisions,
  };
}

export function formatPipelineReportMarkdown(report: PipelineReport): string {
  const lines: string[] = [];

  lines.push(`# GaryClaw Pipeline Report`);
  lines.push("");
  lines.push(`**Pipeline ID:** ${report.pipelineId}`);
  lines.push(`**Skills:** ${report.skills.map((s) => `/${s.skillName}`).join(" → ")}`);
  lines.push(`**Start:** ${report.startTime}`);
  lines.push(`**End:** ${report.endTime}`);
  lines.push(`**Sessions:** ${report.totalSessions} | **Turns:** ${report.totalTurns} | **Cost:** $${report.totalCostUsd.toFixed(3)}`);
  lines.push("");

  // Per-skill summaries
  lines.push(`## Skill Results`);
  lines.push("");
  for (const skill of report.skills) {
    const status = skill.status === "complete" ? "COMPLETE" : skill.status.toUpperCase();
    const cost = skill.report ? `$${skill.report.estimatedCostUsd.toFixed(3)}` : "$0.000";
    const issues = skill.report?.issues.length ?? 0;
    const fixed = skill.report?.issues.filter((i) => i.status === "fixed").length ?? 0;
    lines.push(`### /${skill.skillName} — ${status}`);
    lines.push(`- Cost: ${cost}`);
    if (issues > 0) lines.push(`- Issues: ${issues} total, ${fixed} fixed`);
    if (skill.startTime && skill.endTime) {
      lines.push(`- Time: ${skill.startTime} → ${skill.endTime}`);
    }
    lines.push("");
  }

  // Merged issues
  const open = report.issues.filter((i) => i.status === "open");
  const fixed = report.issues.filter((i) => i.status === "fixed");

  if (report.issues.length > 0) {
    lines.push(`## All Issues (${report.issues.length})`);
    lines.push("");
    lines.push(`| Status | Count |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Open | ${open.length} |`);
    lines.push(`| Fixed | ${fixed.length} |`);
    lines.push(`| **Total** | **${report.issues.length}** |`);
    lines.push("");
  }

  if (open.length > 0) {
    lines.push(`## Open Issues (${open.length})`);
    lines.push("");
    for (const issue of open) {
      lines.push(`- **${issue.id}** [${issue.severity}]: ${issue.description}`);
    }
    lines.push("");
  }

  // Findings
  if (report.findings.length > 0) {
    lines.push(`## Findings (${report.findings.length})`);
    lines.push("");
    for (const f of report.findings) {
      lines.push(`- **[${f.category}]** ${f.description}`);
    }
    lines.push("");
  }

  // Decisions
  if (report.decisions.length > 0) {
    lines.push(`## Decisions (${report.decisions.length})`);
    lines.push("");
    for (const d of report.decisions) {
      lines.push(`- **Q:** ${d.question} → **A:** ${d.chosen} (${d.confidence}/10)`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by GaryClaw Pipeline*");

  return lines.join("\n");
}
