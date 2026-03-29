/**
 * Job Runner — FIFO job queue with budget enforcement and deduplication.
 *
 * Manages the lifecycle of daemon jobs: enqueue, process, persist state.
 * Each job runs skills via runPipeline() or runSkill() with autonomous=true.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { safeWriteJSON, safeReadJSON } from "./safe-json.js";
import { buildSdkEnv } from "./sdk-wrapper.js";
import { runPipeline, resumePipeline, readPipelineState } from "./pipeline.js";
import { runSkill } from "./orchestrator.js";
import { notifyJobComplete, notifyJobError, notifyJobResumed, notifyMergeBlocked, notifyRateLimitHold, notifyRateLimitResume, writeSummary } from "./notifier.js";
import { generateDashboard } from "./dashboard.js";
import {
  readGlobalBudget,
  updateGlobalBudget,
  isSkillSetActive,
  getClaimedTodoTitles,
  getCompletedTodoTitles,
  getClaimedFiles,
  setGlobalRateLimitHold,
  clearGlobalRateLimitHold,
} from "./daemon-registry.js";
import {
  extractPredictedFiles,
  expandWithDependencies,
  hasFileOverlap,
  DEFAULT_FILE_DEPS,
} from "./file-conflict.js";
import type { FileDependencyMap } from "./file-conflict.js";
import { mergeWorktreeBranch, resolveBaseBranch } from "./worktree.js";
import type { MergeResult } from "./worktree.js";
import { safeReadText } from "./safe-json.js";
import { parseTodoItems } from "./prioritize.js";
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
import {
  slugify,
  readTodoState,
  findTodoState,
  writeTodoState,
  detectArtifacts,
  reconcileState,
  getStartSkill,
  findNextSkill,
  markTodoCompleteInFile,
} from "./todo-state.js";
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
  notifyMergeBlocked?: (job: Job, result: MergeResult, config: DaemonConfig) => void;
  notifyRateLimitHold?: (resetAt: Date, instanceName: string, config: DaemonConfig) => void;
  notifyRateLimitResume?: (instanceName: string, config: DaemonConfig) => void;
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
  notifyMergeBlocked,
  notifyRateLimitHold,
  notifyRateLimitResume,
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
        job.failureCategory = "daemon-crash";
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

  // Catch-up: mark any TODO items that reached "merged"/"complete" in todo-state
  // but whose TODOS.md headings are still open (e.g., daemon crashed after merge
  // but before auto-mark, or auto-mark failed).
  try {
    const catchUpDir = parentCheckpointDir ?? checkpointDir;
    const catchUpCount = catchUpCompletedTodos(
      catchUpDir,
      config.projectDir,
      resolvedInstanceName,
      parentCheckpointDir,
      d,
    );
    if (catchUpCount > 0) {
      d.log("info", `Catch-up: marked ${catchUpCount} TODO heading(s) complete in TODOS.md`);
    }
  } catch (err) {
    d.log("warn", `Catch-up failed: ${err instanceof Error ? err.message : String(err)}`);
  }

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
        return (j.status === "queued" || j.status === "running" || j.status === "rate_limited") && jKey === skillKey;
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

    // Rate limit hold: don't process any jobs until reset time passes
    if (state.rateLimitResetAt) {
      const resetAt = new Date(state.rateLimitResetAt);
      if (Date.now() < resetAt.getTime()) {
        return; // Still rate-limited — caller (poll interval) will retry later
      }
      // Reset time passed — clear the hold
      d.log("info", "Rate limit hold expired — resuming job processing");
      d.notifyRateLimitResume?.(resolvedInstanceName, currentConfig);
      state.rateLimitResetAt = undefined;
      // Re-queue any rate_limited jobs (reset costUsd to avoid double-counting)
      for (const job of state.jobs) {
        if (job.status === "rate_limited") {
          job.status = "queued";
          job.costUsd = 0;
          d.log("info", `Re-queued rate-limited job ${job.id}`);
        }
      }
      persistState(state, checkpointDir);
    }

    // Check global rate limit hold (shared across all instances)
    if (parentCheckpointDir) {
      try {
        const globalBudget = readGlobalBudget(parentCheckpointDir);
        if (globalBudget.rateLimitResetAt) {
          const resetAt = new Date(globalBudget.rateLimitResetAt);
          if (Date.now() < resetAt.getTime()) {
            return; // Another instance is rate-limited — hold this one too
          }
          // Expired — clear stale global hold to avoid repeated file I/O
          clearGlobalRateLimitHold(parentCheckpointDir);
        }
      } catch {
        // Fail-open: if global budget read fails, proceed
      }
    }

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

    // Pre-assign TODO item before prioritize runs (instant claim, no race window)
    let claimedItems: Array<{ title: string; instanceName: string }> | undefined;
    let preAssignedTitle: string | undefined;
    if (nextJob.skills.includes("prioritize")) {
      try {
        // Read other instances' claims
        if (parentCheckpointDir) {
          claimedItems = getClaimedTodoTitles(parentCheckpointDir, resolvedInstanceName);
        }
        const claimedTitles = new Set((claimedItems ?? []).map(c => c.title));

        // Cross-cycle dedup: skip TODOs already completed by any instance
        let completedTitles = new Set<string>();
        if (parentCheckpointDir) {
          completedTitles = getCompletedTodoTitles(parentCheckpointDir, resolvedInstanceName);
        }
        if (completedTitles.size > 0) {
          d.log("info", `Cross-cycle dedup: ${completedTitles.size} already-completed TODO(s) excluded`);
        }

        // Parse TODOS.md and pick top unclaimed item
        const todosPath = join(jobConfig.worktreePath ?? jobConfig.projectDir, "TODOS.md");
        const todosContent = safeReadText(todosPath);
        if (todosContent) {
          const items = parseTodoItems(todosContent);
          // Filter: not completed (~~), not claimed, not already done by another cycle, has effort ≤ M, deps met
          const actionable = items.filter(item =>
            !item.title.startsWith("~~") &&
            !claimedTitles.has(item.title) &&
            !completedTitles.has(item.title) &&
            item.effort && ["XS", "S", "M"].includes(item.effort.toUpperCase()) &&
            (item.dependencies.length === 0 ||
             item.dependencies.every(dep => dep.toLowerCase() === "nothing"))
          );
          // Sort by priority (P2 > P3 > P4), then file order
          actionable.sort((a, b) => a.priority - b.priority);

          // File-level conflict prevention: load dep map + other instances' claimed files
          let depMap: FileDependencyMap = DEFAULT_FILE_DEPS;
          let otherClaimedFiles = new Map<string, string[]>();
          if (parentCheckpointDir) {
            try {
              const customMap = safeReadJSON<FileDependencyMap>(
                join(parentCheckpointDir, "file-deps.json"),
                validateFileDependencyMap,
              );
              if (customMap) depMap = customMap;
            } catch {
              // Fall back to default map
            }
            otherClaimedFiles = getClaimedFiles(parentCheckpointDir, resolvedInstanceName);
          }
          // Build flat set of all files claimed by other instances (for overlap check)
          const allOtherFiles: string[] = [];
          const fileToInstances = new Map<string, string[]>();
          for (const [instName, files] of otherClaimedFiles) {
            for (const f of files) {
              allOtherFiles.push(f);
              const owners = fileToInstances.get(f) ?? [];
              owners.push(instName);
              fileToInstances.set(f, owners);
            }
          }

          // Filter out items already complete via TODO state tracking (fail-open)
          const preAssignStateDir = join(jobConfig.worktreePath ?? jobConfig.projectDir, ".garyclaw");
          const stateFiltered = actionable.filter(item => {
            try {
              const slug = slugify(item.title);
              const stored = readTodoState(preAssignStateDir, slug);
              if (stored && (stored.state === "merged" || stored.state === "complete")) {
                d.log("debug", `Pre-assignment: skipping "${item.title}" (state: ${stored.state})`);
                return false;
              }
            } catch { /* fail-open: include item if state check errors */ }
            return true;
          });

          // Iterate through actionable items, pick first without file conflicts
          let picked = false;
          for (const item of stateFiltered) {
            // Extract predicted files from TODO description + optional design doc
            let designDocContent: string | undefined;
            const designDocMatch = item.description.match(/\*\*Design doc:\*\*\s*`([^`]+)`/);
            if (designDocMatch) {
              try {
                const docPath = join(jobConfig.worktreePath ?? jobConfig.projectDir, designDocMatch[1]);
                designDocContent = safeReadText(docPath) ?? undefined;
              } catch {
                // Fail-open: if design doc can't be read, just use description
              }
            }
            const predicted = extractPredictedFiles(item.description ?? item.title, designDocContent);
            const expanded = expandWithDependencies(predicted, depMap);

            // Check file overlap with other instances
            if (allOtherFiles.length > 0 && expanded.length > 0) {
              const overlap = hasFileOverlap(expanded, allOtherFiles);
              if (overlap.overlaps) {
                const owners = [...new Set(overlap.conflictingFiles.flatMap(f => fileToInstances.get(f) ?? []))];
                d.log("info", `Skipped TODO "${item.title}": file conflict on [${overlap.conflictingFiles.join(", ")}] with instance(s) [${owners.join(", ")}]`);
                continue;
              }
            }

            // No conflict (or no predicted files = fail-open) — claim it
            preAssignedTitle = item.title;
            nextJob.claimedTodoTitle = preAssignedTitle;
            nextJob.claimedFiles = expanded.length > 0 ? expanded : undefined;
            persistState(state, checkpointDir);
            d.log("info", `Pre-assigned TODO: "${preAssignedTitle}" (${claimedTitles.size} claimed, ${expanded.length} file(s) predicted)`);
            picked = true;
            break;
          }
          if (!picked && actionable.length > 0) {
            d.log("info", `All ${actionable.length} actionable TODO(s) blocked by file conflicts — idling`);
          } else if (!picked) {
            d.log("info", `No unclaimed TODO items — prioritize will free-pick or report exhausted`);
          }
        }
      } catch (err) {
        d.log("warn", `Pre-assignment failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ── TODO state tracking: skip already-completed stages ────────
    const todoTitle = nextJob.claimedTodoTitle ?? preAssignedTitle;
    if (todoTitle && nextJob.skills.length > 1) {
      try {
        const slug = slugify(todoTitle);
        const stateCheckpointDir = parentCheckpointDir ?? checkpointDir;
        const storedState = findTodoState(stateCheckpointDir, todoTitle);
        const artifacts = detectArtifacts(
          jobConfig.worktreePath ?? jobConfig.projectDir,
          todoTitle,
          slug,
        );
        const reconciledState = reconcileState(
          storedState,
          artifacts,
          stateCheckpointDir,
        );

        const startSkill = getStartSkill(reconciledState);
        if (startSkill === "skip") {
          d.log("info", `TODO "${todoTitle}" already complete (${reconciledState.state}) — skipping`);
          nextJob.status = "complete";
          nextJob.completedAt = new Date().toISOString();
          persistState(state, checkpointDir);
          // Continuous: re-enqueue — pre-assignment will skip this TODO via state check
          enqueue(nextJob.skills, "continuous", "skip-completed re-enqueue", nextJob.designDoc);
          running = false;
          return;
        }

        // Trim pipeline skills to start from the right point
        const startIndex = findNextSkill(nextJob.skills, startSkill);
        if (startIndex > 0 && startIndex < nextJob.skills.length) {
          const skippedSkills = nextJob.skills.slice(0, startIndex);
          nextJob.skills = nextJob.skills.slice(startIndex);
          d.log("info", `TODO "${todoTitle}" at state "${reconciledState.state}" — skipping [${skippedSkills.join(", ")}]`);
        } else if (startIndex >= nextJob.skills.length) {
          d.log("info", `TODO "${todoTitle}" at state "${reconciledState.state}" — all pipeline skills already complete`);
          nextJob.status = "complete";
          nextJob.completedAt = new Date().toISOString();
          persistState(state, checkpointDir);
          const reId2 = enqueue(nextJob.skills, "continuous", "all-skills-complete re-enqueue", nextJob.designDoc);
          if (reId2) d.log("info", `Continuous: re-enqueued as ${reId2} after all skills complete`);
          running = false;
          processNext();
          return;
        }

        // Pass design doc path to implement if available
        if (reconciledState.designDocPath && !nextJob.designDoc) {
          nextJob.designDoc = reconciledState.designDocPath;
        }
      } catch (err) {
        // Fail-open: if state tracking fails, run full pipeline
        d.log("warn", `TODO state tracking failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const clawConfig = buildGaryClawConfig(jobConfig, nextJob, jobDir, d, claimedItems, preAssignedTitle);

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
          const mergeConfig = jobConfig.merge;
          const mergeResult = mergeWorktreeBranch(
            jobConfig.projectDir,
            resolvedInstanceName,
            baseBranch,
            {
              validation: mergeConfig
                ? mergeConfig.skipValidation
                  ? { skipValidation: true }
                  : {
                      testCommand: mergeConfig.testCommand,
                      testTimeout: mergeConfig.testTimeout,
                    }
                : undefined,
              jobId: nextJob.id,
            },
          );

          if (mergeResult.merged) {
            d.log("info", `Auto-merge: merged ${mergeResult.commitCount ?? 0} commit(s) from garyclaw/${resolvedInstanceName} to ${baseBranch}` +
              (mergeResult.testDurationMs ? ` (tests: ${Math.round(mergeResult.testDurationMs / 1000)}s)` : ""));

            // Advance TODO state to "merged" after successful auto-merge
            if (nextJob.claimedTodoTitle) {
              try {
                const todoSlug = slugify(nextJob.claimedTodoTitle);
                const stateCheckpointDir = parentCheckpointDir ?? checkpointDir;
                const existingState = findTodoState(stateCheckpointDir, nextJob.claimedTodoTitle);
                writeTodoState(stateCheckpointDir, todoSlug, {
                  title: nextJob.claimedTodoTitle,
                  slug: todoSlug,
                  state: "merged",
                  designDocPath: existingState?.designDocPath,
                  branch: existingState?.branch,
                  instanceName: resolvedInstanceName,
                  lastJobId: nextJob.id,
                  updatedAt: new Date().toISOString(),
                });
                d.log("info", `TODO "${nextJob.claimedTodoTitle}" advanced to "merged"`);

                // Auto-mark TODOS.md — defense-in-depth + human readability
                try {
                  const todosPath = join(jobConfig.projectDir, "TODOS.md"); // main repo, not worktree
                  const summary = `${mergeResult.commitCount ?? 0} commit(s) auto-merged from garyclaw/${resolvedInstanceName}.`;
                  const marked = markTodoCompleteInFile(todosPath, nextJob.claimedTodoTitle!, summary);
                  if (marked) {
                    d.log("info", `Auto-marked TODO "${nextJob.claimedTodoTitle}" complete in TODOS.md`);
                  }
                } catch (markErr) {
                  d.log("warn", `Auto-mark TODOS.md failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`);
                }
              } catch {
                // Fail-open: state write failure should never break post-merge
              }
            }
          } else {
            d.log("warn", `Auto-merge blocked: ${mergeResult.reason}` +
              (mergeResult.testOutput ? `\n${mergeResult.testOutput.slice(0, 500)}` : ""));
            // Notify on merge failure (not a job failure, but worth alerting)
            d.notifyMergeBlocked?.(nextJob, mergeResult, jobConfig);

            // Log merge failure to failures.jsonl for dashboard aggregation
            if (mergeResult.testsPassed === false) {
              const syntheticErr = Object.assign(
                new Error(mergeResult.reason ?? "Pre-merge tests failed"),
                { name: "MergeValidationError" },
              );
              const record = buildFailureRecord(syntheticErr, nextJob.id, nextJob.skills, resolvedInstanceName);
              appendFailureRecord(record, checkpointDir);
            }
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

      // Rate limit detection: hold all jobs instead of spam-retrying
      if (classification.category === "infra-issue" && isRateLimitError(nextJob.error)) {
        const resetAt = parseRateLimitResetTime(nextJob.error);
        const holdUntil = resetAt ?? new Date(Date.now() + RATE_LIMIT_FALLBACK_MS);
        state.rateLimitResetAt = holdUntil.toISOString();
        nextJob.status = "rate_limited";
        nextJob.completedAt = undefined; // Not actually completed — will be re-queued
        d.log("info", `Rate limited until ${holdUntil.toISOString()} — holding all jobs`);

        // Propagate to global budget for cross-instance coordination
        if (parentCheckpointDir) {
          try {
            setGlobalRateLimitHold(parentCheckpointDir, holdUntil.toISOString(), resolvedInstanceName);
          } catch {
            // Fail-open: local hold is sufficient
          }
        }

        persistState(state, checkpointDir);
        // Skip normal error notification — send rate limit notification instead
        d.notifyRateLimitHold?.(holdUntil, resolvedInstanceName, jobConfig);
      } else {
        d.writeSummary(nextJob, jobDir);
        d.notifyJobError(nextJob, jobConfig);
      }
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

      // Continuous mode: after a successful pipeline, re-enqueue the same skill set
      // to immediately pick up the next TODO. Pre-assignment ensures a different item
      // is claimed each cycle. Stops when backlog is exhausted (enqueue returns null).
      if (nextJob.status === "complete" && nextJob.skills.length > 1 && nextJob.skills.includes("prioritize")) {
        const reEnqueueId = enqueue(nextJob.skills, "continuous", "auto re-enqueue after successful pipeline", nextJob.designDoc);
        if (reEnqueueId) {
          d.log("info", `Continuous: re-enqueued pipeline as ${reEnqueueId}`);
        } else {
          d.log("info", `Continuous: re-enqueue skipped (budget/dedup/exhausted)`);
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
  preAssignedTodoTitle?: string,
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
    preAssignedTodoTitle,
    todoTitle: job.claimedTodoTitle,
    instanceName: config.name,
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

// ── Auto-mark catch-up ──────────────────────────────────────────

/**
 * Scan todo-state/ for items that reached "merged" or "complete"
 * but whose TODOS.md heading is still open. Marks them complete.
 * Runs once on daemon start to catch items completed before a crash.
 */
export function catchUpCompletedTodos(
  checkpointDir: string,
  projectDir: string,
  resolvedInstanceName: string,
  parentCheckpointDir?: string,
  deps?: { log: (level: string, message: string) => void },
): number {
  const todoStateDir = join(checkpointDir, "todo-state");
  if (!existsSync(todoStateDir)) return 0;

  let stateFiles: string[];
  try {
    stateFiles = readdirSync(todoStateDir).filter(f => f.endsWith(".json"));
  } catch {
    return 0;
  }

  // Guard: skip titles currently claimed by running instances
  const claimedTitles = new Set<string>();
  if (parentCheckpointDir) {
    try {
      const claimed = getClaimedTodoTitles(parentCheckpointDir);
      for (const c of claimed) claimedTitles.add(c.title);
    } catch {
      // Fail-open
    }
  }

  const todosPath = join(projectDir, "TODOS.md");
  let count = 0;

  for (const file of stateFiles) {
    try {
      const filePath = join(todoStateDir, file);
      const stateData = safeReadJSON<{ title?: string; state?: string; instanceName?: string; lastJobId?: string }>(filePath);
      if (!stateData?.title || !stateData?.state) continue;
      if (stateData.state !== "merged" && stateData.state !== "complete") continue;

      // Skip if currently claimed by a running instance
      if (claimedTitles.has(stateData.title)) continue;

      const summary = stateData.instanceName
        ? `Completed by ${stateData.instanceName}${stateData.lastJobId ? `, job ${stateData.lastJobId}` : ""}.`
        : "Completed.";

      const marked = markTodoCompleteInFile(todosPath, stateData.title, summary);
      if (marked) {
        count++;
        deps?.log("debug", `Catch-up: marked "${stateData.title}" complete`);
      }
    } catch {
      // Skip individual state files that fail — continue with others
    }
  }

  return count;
}

// ── Rate limit helpers ───────────────────────────────────────────

/** Check if an error message indicates a rate limit. */
export function isRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("rate limit") ||
    lower.includes("status 429") ||
    lower.includes("http 429") ||
    lower.includes("too many requests");
}

/**
 * Parse rate limit reset time from error message.
 * Claude Max format: "resets at 2:42 PM" or "try again in 23 minutes"
 * Returns null if unparseable.
 */
export function parseRateLimitResetTime(message: string, now?: Date): Date | null {
  // Pattern 1: "resets at HH:MM AM/PM"
  const atMatch = message.match(/resets?\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (atMatch) {
    const ref = now ?? new Date();
    let hours = parseInt(atMatch[1], 10);
    const minutes = parseInt(atMatch[2], 10);
    const ampm = atMatch[3].toUpperCase();
    if (ampm === "PM" && hours < 12) hours += 12;
    if (ampm === "AM" && hours === 12) hours = 0;
    const reset = new Date(ref);
    reset.setHours(hours, minutes, 0, 0);
    // If reset time is in the past, assume next day
    if (reset.getTime() < ref.getTime()) {
      reset.setDate(reset.getDate() + 1);
    }
    return reset;
  }

  // Pattern 2: "try again in N minutes"
  const inMatch = message.match(/(?:try again|wait|retry)\s+in\s+(\d+)\s*min/i);
  if (inMatch) {
    const ref = now ?? new Date();
    const mins = parseInt(inMatch[1], 10);
    return new Date(ref.getTime() + mins * 60 * 1000);
  }

  // Pattern 3: "Retry-After: N" (seconds)
  const retryAfter = message.match(/retry-after:\s*(\d+)/i);
  if (retryAfter) {
    const ref = now ?? new Date();
    const secs = parseInt(retryAfter[1], 10);
    return new Date(ref.getTime() + secs * 1000);
  }

  return null; // Unparseable — caller uses 30-min fallback
}

/** Default rate limit hold duration when reset time cannot be parsed (30 minutes). */
export const RATE_LIMIT_FALLBACK_MS = 30 * 60 * 1000;

/**
 * Validate a FileDependencyMap loaded from .garyclaw/file-deps.json.
 * Must be an object where every key maps to a string array.
 */
function validateFileDependencyMap(data: unknown): data is FileDependencyMap {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!Array.isArray(obj[key])) return false;
    if (!(obj[key] as unknown[]).every((v) => typeof v === "string")) return false;
  }
  return true;
}
