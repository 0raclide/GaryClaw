/**
 * Job Runner — FIFO job queue with budget enforcement and deduplication.
 *
 * Manages the lifecycle of daemon jobs: enqueue, process, persist state.
 * Each job runs skills via runPipeline() or runSkill() with autonomous=true.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { safeWriteJSON } from "./safe-json.js";
import { buildSdkEnv } from "./sdk-wrapper.js";
import { runPipeline, resumePipeline, readPipelineState } from "./pipeline.js";
import { runSkill } from "./orchestrator.js";
import { notifyJobComplete, notifyJobError, notifyJobResumed, writeSummary } from "./notifier.js";
import { generateDashboard } from "./dashboard.js";
import {
  readGlobalBudget,
  updateGlobalBudget,
  isSkillSetActive,
  getClaimedTodoTitles,
} from "./daemon-registry.js";
import { mergeWorktreeBranch, resolveBaseBranch } from "./worktree.js";
import { safeReadText } from "./safe-json.js";
import {
  PerJobCostExceededError,
} from "./types.js";
import {
  classifyError,
  buildFailureRecord,
  appendFailureRecord,
} from "./failure-taxonomy.js";
import { readDecisionsFromLog } from "./reflection.js";
import { getResearchTopics } from "./auto-research.js";
import { readOracleMemory, defaultMemoryConfig } from "./oracle-memory.js";
import type {
  BudgetConfig,
  DaemonConfig,
  DaemonState,
  Decision,
  Job,
  GaryClawConfig,
  OrchestratorCallbacks,
  OrchestratorEvent,
} from "./types.js";

// Re-export for backwards compatibility
export { PerJobCostExceededError };

const STATE_FILE = "daemon-state.json";

export interface JobRunner {
  enqueue(skills: string[], triggeredBy: Job["triggeredBy"], triggerDetail: string, designDoc?: string): string | null;
  processNext(): Promise<void>;
  getState(): DaemonState;
  isRunning(): boolean;
  /** Update budget config for hot-reload. Running jobs keep their original config. */
  updateBudget(budget: BudgetConfig): void;
}

export interface JobRunnerDeps {
  runPipeline: typeof runPipeline;
  resumePipeline: typeof resumePipeline;
  runSkill: typeof runSkill;
  buildSdkEnv: typeof buildSdkEnv;
  notifyJobComplete: typeof notifyJobComplete;
  notifyJobError: typeof notifyJobError;
  notifyJobResumed: typeof notifyJobResumed;
  writeSummary: typeof writeSummary;
  log: (level: string, message: string) => void;
}

const defaultDeps: JobRunnerDeps = {
  runPipeline,
  resumePipeline,
  runSkill,
  buildSdkEnv,
  notifyJobComplete,
  notifyJobError,
  notifyJobResumed,
  writeSummary,
  log: () => {},
};

/**
 * Create a job runner bound to a daemon config and checkpoint directory.
 *
 * @param config - Daemon config
 * @param checkpointDir - Instance-specific checkpoint dir (e.g., .garyclaw/daemons/default/)
 * @param deps - Injectable dependencies for testability
 * @param instanceName - Name of this daemon instance (for global budget attribution)
 * @param parentCheckpointDir - Parent .garyclaw/ dir (for global budget + cross-instance dedup). If not provided, global budget and cross-instance dedup are disabled.
 */
export function createJobRunner(
  config: DaemonConfig,
  checkpointDir: string,
  deps: Partial<JobRunnerDeps> = {},
  instanceName?: string,
  parentCheckpointDir?: string,
): JobRunner {
  const d = { ...defaultDeps, ...deps };
  const resolvedInstanceName = instanceName ?? "default";
  let currentConfig = config;
  let state = loadState(checkpointDir);
  let running = false;

  // On start, attempt to resume crashed jobs instead of marking them failed
  for (const job of state.jobs) {
    if (job.status === "running") {
      const retryCount = (job.retryCount ?? 0) + 1;
      if (retryCount > 2) {
        // Too many crashes — this is a real bug, not transient
        job.status = "failed";
        job.error = `Daemon restarted ${retryCount} times — job abandoned (likely a persistent failure, not transient)`;
        job.completedAt = new Date().toISOString();
        job.failureCategory = "daemon_crash" as any; // Generic crash category
        job.retryable = false;

        // Append failure record for observability
        // Override retryable: classifyError matches "daemon restarted" as retryable,
        // but this job exhausted all retries — the audit trail should reflect reality.
        const record = buildFailureRecord(
          new Error(job.error), job.id, job.skills, resolvedInstanceName,
        );
        record.retryable = false;
        appendFailureRecord(record, checkpointDir);
        d.log("error", `Job ${job.id} failed after ${retryCount} crash retries`);
      } else {
        // Re-queue for resume
        job.status = "queued";
        job.retryCount = retryCount;
        job.costUsd = 0;
        d.log("info", `Job ${job.id} interrupted — re-queued for resume (attempt ${retryCount}/2)`);
      }
    }
  }
  persistState(state, checkpointDir);

  function enqueue(
    skills: string[],
    triggeredBy: Job["triggeredBy"],
    triggerDetail: string,
    designDoc?: string,
  ): string | null {
    // Budget check: daily job count
    // Note: No TOCTOU race here — Node.js is single-threaded, so enqueue() and
    // processNext() never interleave between synchronous budget reads and writes.
    const today = todayDateStr();
    resetDailyIfNeeded(state, today);

    // Count all jobs enqueued today (any status), not just completed ones.
    // dailyCost.jobCount only increments on completion, so using it here would
    // allow unlimited enqueues before any job finishes.
    const todayJobCount = state.jobs.filter(
      (j) => j.enqueuedAt.startsWith(today),
    ).length;
    if (todayJobCount >= currentConfig.budget.maxJobsPerDay) {
      d.log("warn", `Budget: max jobs/day (${currentConfig.budget.maxJobsPerDay}) reached`);
      return null;
    }

    // Budget check: cost headroom (use global budget if available, else local)
    if (parentCheckpointDir) {
      const globalBudget = readGlobalBudget(parentCheckpointDir);
      const globalHeadroom = currentConfig.budget.dailyCostLimitUsd - globalBudget.totalUsd;
      if (globalHeadroom < 0.001) {
        d.log("warn", `Budget: global daily cost limit ($${currentConfig.budget.dailyCostLimitUsd}) reached across all instances`);
        return null;
      }
    } else {
      const headroom = currentConfig.budget.dailyCostLimitUsd - state.dailyCost.totalUsd;
      if (headroom < 0.001) {
        d.log("warn", `Budget: daily cost limit ($${currentConfig.budget.dailyCostLimitUsd}) reached`);
        return null;
      }
    }

    // Cross-instance dedup: check if skills are active in ANY other instance
    const skillKey = designDoc ? `${skills.join(",")};${designDoc}` : skills.join(",");
    if (parentCheckpointDir && isSkillSetActive(parentCheckpointDir, skills, resolvedInstanceName, designDoc)) {
      d.log("info", `Cross-instance dedup: skills [${skillKey}] already active in another instance`);
      return null;
    }

    // Local dedup: skip if same skills + designDoc already queued or running in this instance
    const duplicate = state.jobs.find(
      (j) => {
        const jKey = j.designDoc ? `${j.skills.join(",")};${j.designDoc}` : j.skills.join(",");
        return (j.status === "queued" || j.status === "running") && jKey === skillKey;
      },
    );
    if (duplicate) {
      d.log("info", `Dedup: skills [${skillKey}] already ${duplicate.status} (${duplicate.id})`);
      return null;
    }

    const job: Job = {
      id: `job-${Date.now()}-${randomBytes(3).toString("hex")}`,
      triggeredBy,
      triggerDetail,
      skills,
      projectDir: currentConfig.projectDir,
      status: "queued",
      enqueuedAt: new Date().toISOString(),
      costUsd: 0,
      designDoc,
    };

    state.jobs.push(job);
    persistState(state, checkpointDir);
    d.log("info", `Enqueued ${job.id}: [${skills.join(", ")}] via ${triggeredBy}`);
    return job.id;
  }

  /**
   * Enqueue a job with a researchTopic field (for auto-research jobs).
   * Extends enqueue() to set researchTopic on the created job.
   */
  function enqueueWithTopic(
    skills: string[],
    triggeredBy: Job["triggeredBy"],
    triggerDetail: string,
    researchTopic: string,
  ): string | null {
    const jobId = enqueue(skills, triggeredBy, triggerDetail);
    if (jobId) {
      const job = state.jobs.find((j) => j.id === jobId);
      if (job) job.researchTopic = researchTopic;
      persistState(state, checkpointDir);
    }
    return jobId;
  }

  async function processNext(): Promise<void> {
    if (running) return;

    const nextJob = state.jobs.find((j) => j.status === "queued");
    if (!nextJob) return;

    running = true;
    nextJob.status = "running";
    nextJob.startedAt = new Date().toISOString();
    persistState(state, checkpointDir);
    d.log("info", `Starting ${nextJob.id}: [${nextJob.skills.join(", ")}]`);

    const jobDir = join(checkpointDir, "jobs", nextJob.id);
    mkdirSync(jobDir, { recursive: true });

    // Snapshot config at job start — reload-safe: running jobs keep original config
    const jobConfig = currentConfig;
    const claimCtx = nextJob.skills.includes("prioritize") ? { state, checkpointDir } : undefined;
    const callbacks = buildCallbacks(nextJob, jobConfig, d, claimCtx);

    // Compute claimed items for priority claiming (if this job runs prioritize)
    let claimedItems: Array<{ title: string; instanceName: string }> | undefined;
    if (parentCheckpointDir && nextJob.skills.includes("prioritize")) {
      try {
        claimedItems = getClaimedTodoTitles(parentCheckpointDir, resolvedInstanceName);
        if (claimedItems.length > 0) {
          d.log("info", `Priority claiming: ${claimedItems.length} item(s) already claimed by other instances`);
        }
      } catch (err) {
        d.log("warn", `Priority claiming failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const clawConfig = buildGaryClawConfig(jobConfig, nextJob, jobDir, d, claimedItems);

    // Detect if this is a pipeline resume (retry with existing pipeline.json)
    let isPipelineResume = (nextJob.retryCount ?? 0) > 0 && nextJob.skills.length > 1;

    if (isPipelineResume) {
      const pipelineState = readPipelineState(jobDir);
      if (pipelineState) {
        const completedCost = pipelineState.skills
          .filter(s => s.status === "complete" && s.report)
          .reduce((sum, s) => sum + (s.report?.estimatedCostUsd ?? 0), 0);
        nextJob.priorSkillCostUsd = completedCost;
        const completedCount = pipelineState.skills.filter(s => s.status === "complete").length;
        d.log("info", `Resuming pipeline: ${completedCount}/${pipelineState.skills.length} skills already complete ($${completedCost.toFixed(3)} spent)`);

        // Send recovery notification
        d.notifyJobResumed(nextJob, completedCount, jobConfig);
      } else {
        d.log("warn", `No valid pipeline.json found for resumed job ${nextJob.id} — falling back to fresh pipeline`);
        isPipelineResume = false;
      }
    }

    try {
      if (nextJob.skills.length === 1) {
        // Single-skill jobs retry from scratch (cheap, $0.30-0.50)
        if ((nextJob.retryCount ?? 0) > 0) {
          d.log("info", `Retrying single-skill job ${nextJob.id} from scratch (attempt ${nextJob.retryCount}/2)`);
        }
        await d.runSkill({ ...clawConfig, skillName: nextJob.skills[0] }, callbacks);
      } else if (isPipelineResume) {
        await d.resumePipeline(jobDir, clawConfig, callbacks);
      } else {
        await d.runPipeline(nextJob.skills, clawConfig, callbacks);
      }

      nextJob.status = "complete";
      nextJob.completedAt = new Date().toISOString();
      nextJob.reportPath = join(jobDir, nextJob.skills.length > 1 ? "pipeline-report.md" : "report.md");

      // Update daily cost (local)
      const today = todayDateStr();
      resetDailyIfNeeded(state, today);
      state.dailyCost.totalUsd += nextJob.costUsd;
      state.dailyCost.jobCount++;

      // Update global budget (shared across all instances)
      if (parentCheckpointDir) {
        try {
          updateGlobalBudget(parentCheckpointDir, nextJob.costUsd, resolvedInstanceName);
        } catch (err) {
          d.log("warn", `Failed to update global budget: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      d.writeSummary(nextJob, jobDir);
      d.notifyJobComplete(nextJob, jobConfig);
      d.log("info", `Completed ${nextJob.id}: $${nextJob.costUsd.toFixed(3)}`);

      // Auto-merge: named instances merge their branch to main after successful jobs
      if (jobConfig.worktreePath && resolvedInstanceName !== "default") {
        try {
          const baseBranch = resolveBaseBranch(jobConfig.projectDir);
          const result = mergeWorktreeBranch(jobConfig.projectDir, resolvedInstanceName, baseBranch);
          if (result.merged) {
            d.log("info", `Auto-merge: merged ${result.commitCount ?? 0} commit(s) from garyclaw/${resolvedInstanceName} to ${baseBranch}`);
          } else {
            d.log("warn", `Auto-merge failed: ${result.reason}`);
          }
        } catch (err) {
          d.log("warn", `Auto-merge error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      nextJob.status = "failed";
      nextJob.completedAt = new Date().toISOString();
      nextJob.error = err instanceof Error ? err.message : String(err ?? "");

      // Classify the failure
      const classification = classifyError(err);
      nextJob.failureCategory = classification.category;
      nextJob.retryable = classification.retryable;

      // Append structured failure record
      const record = buildFailureRecord(err, nextJob.id, nextJob.skills, resolvedInstanceName);
      appendFailureRecord(record, checkpointDir);

      d.writeSummary(nextJob, jobDir);
      d.notifyJobError(nextJob, jobConfig);
      if ((nextJob.retryCount ?? 0) > 0) {
        d.log("warn", `Retry ${nextJob.retryCount}/2 failed for ${nextJob.id} [${classification.category}]`);
      }
      d.log("error", `Failed ${nextJob.id} [${classification.category}]: ${nextJob.error}`);
    }

    // Post-job cleanup wrapped in finally to guarantee running=false reset.
    // If any post-job step throws past its catch guard, the job runner would
    // otherwise be permanently stuck (processNext returns when running=true).
    try {
      // Prune old completed/failed jobs to prevent unbounded growth
      pruneOldJobs(state);
      persistState(state, checkpointDir);

      // Regenerate dogfood dashboard (best-effort — never affects job completion)
      try {
        generateDashboard(checkpointDir, parentCheckpointDir, currentConfig);
      } catch (err) {
        d.log("warn", `Dashboard generation failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Auto-research trigger: analyze low-confidence decisions and enqueue research
      if (nextJob.status === "complete" && currentConfig.autoResearch?.enabled) {
        try {
          // Read decisions from top-level AND pipeline skill subdirs
          const decisions = collectAllDecisions(jobDir);
          const memConfig = defaultMemoryConfig(currentConfig.projectDir);
          const memoryFiles = readOracleMemory(memConfig, currentConfig.projectDir);
          const topics = getResearchTopics(
            decisions,
            memoryFiles.domainExpertise,
            currentConfig.autoResearch,
          );

          if (topics.length > 0) {
            d.log("info", `Auto-research: extracted ${topics.length} topic(s) from ${decisions.length} decisions: [${topics.join(", ")}]`);
          } else {
            d.log("debug", `Auto-research: no topics extracted from ${decisions.length} decisions`);
          }

          for (const topic of topics) {
            const jobId = enqueueWithTopic(["research"], "auto_research", `low-confidence: ${topic}`, topic);
            if (jobId) {
              d.log("info", `Auto-research: enqueued research job ${jobId} for topic "${topic}"`);
            } else {
              d.log("info", `Auto-research: skipped enqueue for "${topic}" (budget/dedup)`);
            }
          }
        } catch (err) {
          d.log("warn", `Auto-research trigger failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      running = false;
    }
  }

  function updateBudget(budget: BudgetConfig): void {
    currentConfig = { ...currentConfig, budget };
    d.log("info", `Budget updated: $${budget.dailyCostLimitUsd}/day, $${budget.perJobCostLimitUsd}/job, ${budget.maxJobsPerDay} jobs/day`);
  }

  return {
    enqueue,
    processNext,
    getState: () => state,
    isRunning: () => running,
    updateBudget,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Collect all decisions from a job directory.
 * Reads top-level decisions.jsonl AND any in pipeline skill subdirs
 * (e.g., skill-0-qa/decisions.jsonl, skill-1-design-review/decisions.jsonl).
 */
export function collectAllDecisions(jobDir: string): Decision[] {
  const decisions: Decision[] = [];

  // Top-level decisions.jsonl (single-skill jobs)
  const topLevel = join(jobDir, "decisions.jsonl");
  if (existsSync(topLevel)) {
    decisions.push(...readDecisionsFromLog(topLevel));
  }

  // Pipeline skill subdirs: skill-{i}-{name}/decisions.jsonl
  try {
    const entries = readdirSync(jobDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("skill-")) {
        const subLog = join(jobDir, entry.name, "decisions.jsonl");
        if (existsSync(subLog)) {
          decisions.push(...readDecisionsFromLog(subLog));
        }
      }
    }
  } catch {
    // If readdir fails, we already have top-level decisions (or empty)
  }

  return decisions;
}

function buildGaryClawConfig(
  config: DaemonConfig,
  job: Job,
  jobDir: string,
  deps: JobRunnerDeps,
  claimedTodoItems?: Array<{ title: string; instanceName: string }>,
): GaryClawConfig {
  // Named instances use worktree path; default uses main repo
  const projectDir = config.worktreePath ?? config.projectDir;
  return {
    skillName: job.skills[0],
    projectDir,
    maxTurnsPerSegment: config.orchestrator.maxTurnsPerSegment,
    relayThresholdRatio: config.orchestrator.relayThresholdRatio,
    checkpointDir: jobDir,
    settingSources: ["user", "project"],
    env: deps.buildSdkEnv(process.env as Record<string, string>, { tagDaemonCommits: true }),
    askTimeoutMs: config.orchestrator.askTimeoutMs,
    maxRelaySessions: config.orchestrator.maxRelaySessions,
    autonomous: true,
    designDoc: job.designDoc,
    researchTopic: job.researchTopic,
    // Oracle memory always reads from the main repo, not the worktree
    mainRepoDir: config.worktreePath ? config.projectDir : undefined,
    claimedTodoItems,
  };
}

/**
 * Parse the "Top Pick:" title from priority.md content.
 */
export function parsePriorityPickTitle(content: string): string | null {
  const match = content.match(/^## Top Pick:\s*(.+)/m);
  return match ? match[1].trim() : null;
}

function buildCallbacks(
  job: Job,
  config: DaemonConfig,
  deps: JobRunnerDeps,
  claimContext?: { state: DaemonState; checkpointDir: string },
): OrchestratorCallbacks {
  return {
    onEvent: (event: OrchestratorEvent) => {
      // Track cost from events and enforce per-job cost limit.
      // Only check on cost-related events to avoid throwing mid-checkpoint-write.
      if (event.type === "cost_update") {
        job.costUsd = Math.max(job.costUsd, event.costUsd);
      } else if (event.type === "skill_complete") {
        job.costUsd = Math.max(job.costUsd, event.costUsd);
      } else if (event.type === "pipeline_complete") {
        job.costUsd = Math.max(job.costUsd, event.totalCostUsd);
      }
      if (
        (event.type === "cost_update" || event.type === "skill_complete" || event.type === "pipeline_complete") &&
        job.costUsd > config.budget.perJobCostLimitUsd
      ) {
        throw new PerJobCostExceededError(job.costUsd, config.budget.perJobCostLimitUsd);
      }
      // Claim TODO title immediately after prioritize finishes (not after full pipeline)
      if (event.type === "pipeline_skill_complete" && event.skillName === "prioritize" && claimContext) {
        try {
          const priorityDir = config.worktreePath ?? config.projectDir;
          const priorityPath = join(priorityDir, ".garyclaw", "priority.md");
          const priorityContent = safeReadText(priorityPath);
          if (priorityContent) {
            const title = parsePriorityPickTitle(priorityContent);
            if (title && title !== "Backlog Exhausted") {
              job.claimedTodoTitle = title;
              persistState(claimContext.state, claimContext.checkpointDir);
              deps.log("info", `Priority claimed (early): "${title}"`);
            }
          }
        } catch (err) {
          deps.log("warn", `Early priority claim failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Collect adaptive turns stats
      if (event.type === "adaptive_turns") {
        if (!job.adaptiveTurnsStats) {
          job.adaptiveTurnsStats = {
            segmentCount: 0,
            adaptiveCount: 0,
            fallbackCount: 0,
            clampedCount: 0,
            heavyToolActivations: 0,
            minTurns: null,
            maxTurns: 0,
            totalTurns: 0,
          };
        }
        const stats = job.adaptiveTurnsStats;
        stats.segmentCount++;
        stats.totalTurns += event.maxTurns;
        stats.minTurns =
          stats.minTurns === null
            ? event.maxTurns
            : Math.min(stats.minTurns, event.maxTurns);
        stats.maxTurns = Math.max(stats.maxTurns, event.maxTurns);

        // Parse reason string to classify segment type
        if (event.reason.includes("no growth data") || event.reason.includes("adaptive disabled")) {
          stats.fallbackCount++;
        } else if (event.reason.includes("already at/past target")) {
          stats.clampedCount++;
        } else {
          stats.adaptiveCount++;
        }
        if (event.reason.includes("heavy tool")) {
          stats.heavyToolActivations++;
        }
      }
      // Log key events
      if (event.type === "error") {
        deps.log("error", `[${job.id}] ${event.message}`);
      } else if (event.type === "relay_triggered") {
        deps.log("info", `[${job.id}] Relay: ${event.reason}`);
      } else if (event.type === "pipeline_skill_start") {
        deps.log("info", `[${job.id}] Starting skill ${event.skillName} (${event.skillIndex + 1}/${event.totalSkills})`);
      }
    },
    onAskUser: async () => {
      // In daemon mode, oracle handles everything. This fallback should not fire.
      deps.log("warn", `[${job.id}] onAskUser called in daemon mode — denying`);
      return "deny";
    },
  };
}

const MAX_COMPLETED_JOBS = 100;

/**
 * Prune old completed/failed jobs to prevent unbounded state growth.
 * Keeps the most recent MAX_COMPLETED_JOBS finished jobs; queued/running are never pruned.
 */
function pruneOldJobs(state: DaemonState): void {
  const finished = state.jobs.filter((j) => j.status === "complete" || j.status === "failed");
  if (finished.length <= MAX_COMPLETED_JOBS) return;

  // Keep only the most recent MAX_COMPLETED_JOBS finished jobs
  const toRemove = new Set(
    finished
      .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""))
      .slice(0, finished.length - MAX_COMPLETED_JOBS)
      .map((j) => j.id),
  );
  state.jobs = state.jobs.filter((j) => !toRemove.has(j.id));
}

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyIfNeeded(state: DaemonState, today: string): void {
  if (state.dailyCost.date !== today) {
    state.dailyCost = { date: today, totalUsd: 0, jobCount: 0 };
  }
}

function loadState(checkpointDir: string): DaemonState {
  const path = join(checkpointDir, STATE_FILE);
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      if (data && data.version === 1 && Array.isArray(data.jobs)) {
        return data as DaemonState;
      }
    } catch {
      // Corrupt state — start fresh
    }
  }
  return {
    version: 1,
    jobs: [],
    dailyCost: { date: todayDateStr(), totalUsd: 0, jobCount: 0 },
  };
}

function persistState(state: DaemonState, checkpointDir: string): void {
  mkdirSync(checkpointDir, { recursive: true });
  safeWriteJSON(join(checkpointDir, STATE_FILE), state);
}
