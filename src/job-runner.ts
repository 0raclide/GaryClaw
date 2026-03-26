/**
 * Job Runner — FIFO job queue with budget enforcement and deduplication.
 *
 * Manages the lifecycle of daemon jobs: enqueue, process, persist state.
 * Each job runs skills via runPipeline() or runSkill() with autonomous=true.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildSdkEnv } from "./sdk-wrapper.js";
import { runPipeline } from "./pipeline.js";
import { runSkill } from "./orchestrator.js";
import { notifyJobComplete, notifyJobError, writeSummary } from "./notifier.js";
import {
  PerJobCostExceededError,
} from "./types.js";
import type {
  BudgetConfig,
  DaemonConfig,
  DaemonState,
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
  runSkill: typeof runSkill;
  buildSdkEnv: typeof buildSdkEnv;
  notifyJobComplete: typeof notifyJobComplete;
  notifyJobError: typeof notifyJobError;
  writeSummary: typeof writeSummary;
  log: (level: string, message: string) => void;
}

const defaultDeps: JobRunnerDeps = {
  runPipeline,
  runSkill,
  buildSdkEnv,
  notifyJobComplete,
  notifyJobError,
  writeSummary,
  log: () => {},
};

/**
 * Create a job runner bound to a daemon config and checkpoint directory.
 */
export function createJobRunner(
  config: DaemonConfig,
  checkpointDir: string,
  deps: Partial<JobRunnerDeps> = {},
): JobRunner {
  const d = { ...defaultDeps, ...deps };
  let currentConfig = config;
  let state = loadState(checkpointDir);
  let running = false;

  // On start, mark any "running" jobs as "failed" (stale from crash)
  for (const job of state.jobs) {
    if (job.status === "running") {
      job.status = "failed";
      job.error = "Daemon restarted — job was interrupted";
      job.completedAt = new Date().toISOString();
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

    // Budget check: cost headroom
    const headroom = currentConfig.budget.dailyCostLimitUsd - state.dailyCost.totalUsd;
    if (headroom < 0.001) {
      d.log("warn", `Budget: daily cost limit ($${currentConfig.budget.dailyCostLimitUsd}) reached`);
      return null;
    }

    // Dedup: skip if same skills + designDoc already queued or running
    const skillKey = designDoc ? `${skills.join(",")};${designDoc}` : skills.join(",");
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
    const callbacks = buildCallbacks(nextJob, jobConfig, d);
    const clawConfig = buildGaryClawConfig(jobConfig, nextJob, jobDir, d);

    try {
      if (nextJob.skills.length === 1) {
        await d.runSkill({ ...clawConfig, skillName: nextJob.skills[0] }, callbacks);
      } else {
        await d.runPipeline(nextJob.skills, clawConfig, callbacks);
      }

      nextJob.status = "complete";
      nextJob.completedAt = new Date().toISOString();
      nextJob.reportPath = join(jobDir, nextJob.skills.length > 1 ? "pipeline-report.md" : "report.md");

      // Update daily cost
      const today = todayDateStr();
      resetDailyIfNeeded(state, today);
      state.dailyCost.totalUsd += nextJob.costUsd;
      state.dailyCost.jobCount++;

      d.writeSummary(nextJob, jobDir);
      d.notifyJobComplete(nextJob, jobConfig);
      d.log("info", `Completed ${nextJob.id}: $${nextJob.costUsd.toFixed(3)}`);
    } catch (err) {
      nextJob.status = "failed";
      nextJob.completedAt = new Date().toISOString();
      nextJob.error = err instanceof Error ? err.message : String(err);

      d.writeSummary(nextJob, jobDir);
      d.notifyJobError(nextJob, jobConfig);
      d.log("error", `Failed ${nextJob.id}: ${nextJob.error}`);
    }

    // Prune old completed/failed jobs to prevent unbounded growth
    pruneOldJobs(state);
    persistState(state, checkpointDir);
    running = false;
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

function buildGaryClawConfig(
  config: DaemonConfig,
  job: Job,
  jobDir: string,
  deps: JobRunnerDeps,
): GaryClawConfig {
  return {
    skillName: job.skills[0],
    projectDir: config.projectDir,
    maxTurnsPerSegment: config.orchestrator.maxTurnsPerSegment,
    relayThresholdRatio: config.orchestrator.relayThresholdRatio,
    checkpointDir: jobDir,
    settingSources: ["user", "project"],
    env: deps.buildSdkEnv(process.env as Record<string, string>),
    askTimeoutMs: config.orchestrator.askTimeoutMs,
    maxRelaySessions: config.orchestrator.maxRelaySessions,
    autonomous: true,
    designDoc: job.designDoc,
  };
}

function buildCallbacks(job: Job, config: DaemonConfig, deps: JobRunnerDeps): OrchestratorCallbacks {
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
  writeFileSync(join(checkpointDir, STATE_FILE), JSON.stringify(state, null, 2), "utf-8");
}
