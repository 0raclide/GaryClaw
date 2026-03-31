/**
 * Job Runner — FIFO job queue with budget enforcement and deduplication.
 *
 * Manages the lifecycle of daemon jobs: enqueue, process, persist state.
 * Each job runs skills via runPipeline() or runSkill() with autonomous=true.
 */

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { safeWriteJSON, safeReadJSON } from "./safe-json.js";
import { buildSdkEnv } from "./sdk-wrapper.js";
import { runPipeline, resumePipeline, readPipelineState } from "./pipeline.js";
import { runSkill } from "./orchestrator.js";
import { notifyJobComplete, notifyJobError, notifyJobResumed, notifyMergeBlocked, notifyMergeReverted, notifyPrCreated, notifyRateLimitHold, notifyRateLimitResume, writeSummary } from "./notifier.js";
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
import { maybeEnqueueAutoFix, updateAutoFixCost } from "./auto-fix.js";
import { mergeWorktreeBranch, resolveBaseBranch, verifyPostMerge, appendMergeRevert, branchName, createPullRequest, buildPrBody, appendMergeAudit } from "./worktree.js";
import type { MergeResult, PostMergeVerifyResult, PullRequestResult } from "./worktree.js";
import { safeReadText } from "./safe-json.js";
import { parseTodoItems, extractCompletedTitles, isPickValid } from "./prioritize.js";
import { composePipeline } from "./pipeline-compose.js";
import {
  readPipelineOutcomes,
  appendPipelineOutcome,
  computeSkipRiskScores,
  shouldUseOracleComposition,
} from "./pipeline-history.js";
import {
  PerJobCostExceededError,
  VALID_TASK_CATEGORIES,
} from "./types.js";
import type { WarnFn } from "./types.js";
import {
  classifyError,
  buildFailureRecord,
  appendFailureRecord,
} from "./failure-taxonomy.js";
import { readDecisionsFromLog, countPipelineOutcomes } from "./reflection.js";
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
  notifyMergeReverted?: (job: Job, verifyResult: PostMergeVerifyResult, config: DaemonConfig) => void;
  notifyPrCreated?: (job: Job, prResult: PullRequestResult, config: DaemonConfig) => void;
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
  notifyMergeReverted,
  notifyPrCreated,
  notifyRateLimitHold,
  notifyRateLimitResume,
  writeSummary,
  log: () => {},
};

// ── Post-merge verification helper ──────────────────────────────

export interface PostMergeVerificationContext {
  projectDir: string;
  instanceName: string;
  jobId: string;
  skills: string[];
  checkpointDir: string;
  mergeConfig?: DaemonConfig["merge"];
  testsPassed?: boolean;
  commitCount: number;
  log: (level: string, message: string) => void;
  notifyMergeReverted?: (job: Job, verifyResult: PostMergeVerifyResult, config: DaemonConfig) => void;
  job: Job;
  config: DaemonConfig;
  /** Enqueue function for auto-fix jobs. If not provided, auto-fix is disabled. */
  enqueue?: (skills: string[], triggeredBy: Job["triggeredBy"], detail: string) => string | null;
  /** State accessor for post-enqueue field assignment. */
  _getState?: () => DaemonState;
}

/**
 * Run post-merge test verification and auto-revert on failure.
 *
 * Extracted from the inline block in processNext() for readability.
 * Handles: smart skip, test execution, revert, audit, failure record,
 * bug TODO creation, and notification.
 */
export function handlePostMergeVerification(ctx: PostMergeVerificationContext): void {
  if (!ctx.commitCount || ctx.commitCount <= 0) return;

  const skipPostVerify = ctx.mergeConfig?.skipPostMergeVerification ?? false;
  const forcePostVerify = ctx.mergeConfig?.forcePostMergeVerification ?? false;
  const preMergePassed = ctx.testsPassed === true;
  const shouldVerify = !skipPostVerify && (!preMergePassed || forcePostVerify);

  if (!shouldVerify) return;

  try {
    const mainHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ctx.projectDir, stdio: "pipe", encoding: "utf-8",
    }).trim();

    const verifyResult = verifyPostMerge(ctx.projectDir, mainHead, {
      testCommand: ctx.mergeConfig?.testCommand,
      testTimeout: ctx.mergeConfig?.testTimeout,
    });

    if (verifyResult.verified) {
      ctx.log("info", `Post-merge verified: tests pass on main` +
        (verifyResult.testDurationMs ? ` (${Math.round(verifyResult.testDurationMs / 1000)}s)` : ""));
    } else if (verifyResult.reverted) {
      ctx.log("warn", `POST-MERGE REVERT: ${verifyResult.reason}` +
        (verifyResult.testOutput ? `\n${verifyResult.testOutput.slice(0, 500)}` : ""));

      // Audit log
      appendMergeRevert(ctx.projectDir, {
        timestamp: new Date().toISOString(),
        instanceName: ctx.instanceName,
        mergeSha: verifyResult.mergeSha,
        revertSha: verifyResult.revertSha,
        branch: branchName(ctx.instanceName),
        testOutput: verifyResult.testOutput?.slice(0, 2000),
        testDurationMs: verifyResult.testDurationMs,
        jobId: ctx.jobId,
        reason: verifyResult.reason ?? "Post-merge tests failed",
        autoReverted: true,
      });

      // Failure taxonomy record
      const syntheticErr = Object.assign(
        new Error(verifyResult.reason ?? "Post-merge tests failed"),
        { name: "PostMergeRegressionError" },
      );
      const record = buildFailureRecord(syntheticErr, ctx.jobId, ctx.skills, ctx.instanceName);
      appendFailureRecord(record, ctx.checkpointDir);

      // Bug TODO creation
      try {
        const todosPath = join(ctx.projectDir, "TODOS.md");
        if (existsSync(todosPath)) {
          const todoTitle = `P2: Fix post-merge regression from ${ctx.instanceName} (job ${ctx.jobId})`;
          const todoBody = [
            `\n## ${todoTitle}\n`,
            `**What:** Post-merge test verification failed after auto-merge to main. The merge was auto-reverted.`,
            `**Priority:** P2 (auto-generated safety item)`,
            `**Effort:** S`,
            `**Test output (truncated):**`,
            "```",
            (verifyResult.testOutput ?? "").slice(0, 1000),
            "```",
            `**Branch:** \`${branchName(ctx.instanceName)}\` (still exists after revert, check out to debug)`,
            `**Added by:** Post-merge safety net on ${new Date().toISOString().slice(0, 10)}`,
            "",
          ].join("\n");
          appendFileSync(todosPath, todoBody, "utf-8");
          ctx.log("info", `Created P2 bug TODO for post-merge regression`);
        }
      } catch (todoErr) {
        ctx.log("warn", `Failed to create bug TODO: ${todoErr instanceof Error ? todoErr.message : String(todoErr)}`);
      }

      // Notification
      ctx.notifyMergeReverted?.(ctx.job, verifyResult, ctx.config);

      // Auto-fix: immediately attempt to fix the regression
      if (ctx.enqueue) {
        try {
          const todoTitle = `P2: Fix post-merge regression from ${ctx.instanceName} (job ${ctx.jobId})`;
          // Wrap enqueue to set claimedTodoTitle, autoFixMergeSha, and skipComposition
          // on the created job (same pattern as enqueueWithTopic)
          const autoFixEnqueue: typeof ctx.enqueue = (skills, triggeredBy, detail) => {
            const jobId = ctx.enqueue!(skills, triggeredBy, detail);
            if (jobId && ctx._getState) {
              const job = ctx._getState().jobs.find((j: Job) => j.id === jobId);
              if (job) {
                job.claimedTodoTitle = todoTitle;
                job.autoFixMergeSha = verifyResult.mergeSha;
                job.skipComposition = true;
              }
            }
            return jobId;
          };
          const autoFixResult = maybeEnqueueAutoFix({
            projectDir: ctx.projectDir,
            checkpointDir: ctx.checkpointDir,
            mergeSha: verifyResult.mergeSha,
            jobId: ctx.jobId,
            jobCost: ctx.job.costUsd ?? 0,
            instanceName: ctx.instanceName,
            skills: ctx.skills,
            testOutput: verifyResult.testOutput,
            revertSha: verifyResult.revertSha,
            bugTodoTitle: todoTitle,
            enqueue: autoFixEnqueue,
            log: ctx.log,
            config: { autoFixOnRevert: ctx.mergeConfig?.autoFixOnRevert ?? false },
          });
          if (autoFixResult.enqueued) {
            ctx.log("info", `Auto-fix loop activated for reverted merge`);
          }
        } catch (autoFixErr) {
          ctx.log("warn", `Auto-fix enqueue failed: ${autoFixErr instanceof Error ? autoFixErr.message : String(autoFixErr)}`);
        }
      }
    } else {
      // Tests failed but revert skipped (HEAD moved or conflict)
      ctx.log("warn", `Post-merge verification failed but revert skipped: ${verifyResult.reason}`);

      // Still audit even when revert was skipped
      appendMergeRevert(ctx.projectDir, {
        timestamp: new Date().toISOString(),
        instanceName: ctx.instanceName,
        mergeSha: verifyResult.mergeSha,
        branch: branchName(ctx.instanceName),
        testOutput: verifyResult.testOutput?.slice(0, 2000),
        testDurationMs: verifyResult.testDurationMs,
        jobId: ctx.jobId,
        reason: verifyResult.reason ?? "Post-merge tests failed (revert skipped)",
        autoReverted: false,
      });
    }
  } catch (err) {
    ctx.log("warn", `Post-merge verification error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── TODO state advancement helper ────────────────────────────────

/**
 * Advance TODO state to "merged" after successful auto-merge and auto-mark TODOS.md.
 * Extracted to avoid duplication between direct merge and PR fallback paths.
 */
function advanceTodoToMerged(
  job: Job,
  instanceName: string,
  stateCheckpointDir: string,
  projectDir: string,
  log: (level: string, message: string) => void,
): void {
  if (!job.claimedTodoTitle) return;
  try {
    const todoSlug = slugify(job.claimedTodoTitle);
    const existingState = findTodoState(stateCheckpointDir, job.claimedTodoTitle);
    writeTodoState(stateCheckpointDir, todoSlug, {
      title: job.claimedTodoTitle,
      slug: todoSlug,
      state: "merged",
      designDocPath: existingState?.designDocPath,
      branch: existingState?.branch,
      instanceName,
      lastJobId: job.id,
      updatedAt: new Date().toISOString(),
    });
    log("info", `TODO "${job.claimedTodoTitle}" advanced to "merged"`);

    // Auto-mark TODOS.md — defense-in-depth + human readability
    try {
      const todosPath = join(projectDir, "TODOS.md");
      const summary = `Auto-merged from garyclaw/${instanceName}.`;
      const marked = markTodoCompleteInFile(todosPath, job.claimedTodoTitle, summary);
      if (marked) {
        log("info", `Auto-marked TODO "${job.claimedTodoTitle}" complete in TODOS.md`);
      }
    } catch (markErr) {
      log("warn", `Auto-mark TODOS.md failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`);
    }
  } catch {
    // Fail-open: state write failure should never break post-merge
  }
}

// ── Pre-merge test runner helper ─────────────────────────────────

export interface PreMergeTestResult {
  passed: boolean | undefined;  // undefined = skipped (no validation config)
  durationMs?: number;
}

/**
 * Run pre-merge validation tests in a worktree directory.
 * Shared between PR and direct merge strategies to prevent logic divergence.
 */
export function runPreMergeTests(
  cwd: string,
  mergeConfig: DaemonConfig["merge"],
  log: (level: string, message: string) => void,
): PreMergeTestResult {
  if (!mergeConfig || mergeConfig.skipValidation) {
    return { passed: undefined };
  }
  const testCommand = mergeConfig.testCommand ?? "npm test";
  const testTimeout = mergeConfig.testTimeout ?? 120_000;
  try {
    const start = Date.now();
    execFileSync("sh", ["-c", testCommand], {
      cwd,
      timeout: testTimeout,
      stdio: "pipe",
    });
    const durationMs = Date.now() - start;
    log("info", `Pre-merge tests passed (${Math.round(durationMs / 1000)}s)`);
    return { passed: true, durationMs };
  } catch {
    log("warn", "Pre-merge tests failed");
    return { passed: false };
  }
}

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
    // Recover rate_limited jobs on restart — if rateLimitResetAt was lost or
    // corrupted, these would be stuck forever with no re-queue path.
    if (job.status === "rate_limited") {
      job.status = "queued";
      job.costUsd = 0;
      d.log("info", `Job ${job.id} was rate_limited at crash — re-queued`);
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
          clearGlobalRateLimitHold(parentCheckpointDir, (msg) => d.log("warn", String(msg)));
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
          // State dir needed for both strikethrough check and later state filtering
          const preAssignStateDir = join(jobConfig.worktreePath ?? jobConfig.projectDir, ".garyclaw");
          // State files are the sole authority for completion status.
          // ~~complete~~ markup in TODOS.md is cosmetic (human readability only).
          // Items without state files fall back to ~~complete~~ as bootstrap signal.
          const actionable = items.filter(item => {
            const hasStrikethrough = item.title.startsWith("~~");
            if (hasStrikethrough) {
              // Check if state file exists — if so, state wins (may be stale markup)
              // If no state file, trust the markup (human-managed or pre-state-tracking)
              const itemSlug = slugify(item.title.replace(/^~~|~~$/g, ""));
              const stored = readTodoState(preAssignStateDir, itemSlug);
              if (!stored) return false; // no state file, trust ~~complete~~ markup
              // State file exists — let state filter below handle it
            }
            return true;
          }).filter(item =>
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
          const stateFiltered = actionable.filter(item => {
            try {
              const slug = slugify(item.title);
              const stored = readTodoState(preAssignStateDir, slug);
              if (stored && (stored.state === "merged" || stored.state === "complete" || stored.state === "pr-created")) {
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

    // ── Adaptive pipeline composition ────────────────────────────
    let oracleAdjustedComposition = false;
    const todoTitle = nextJob.claimedTodoTitle ?? preAssignedTitle;
    if (nextJob.skipComposition || nextJob.triggeredBy === "post-merge-revert") {
      d.log("info", `Deterministic override: skipping composition for [${nextJob.skills.join(", ")}]`);
    } else if (todoTitle && nextJob.skills.length > 1) {
      try {
        const todosPath = join(jobConfig.worktreePath ?? jobConfig.projectDir, "TODOS.md");
        const todosContent = safeReadText(todosPath);
        const todoItems = todosContent ? parseTodoItems(todosContent) : [];
        const todoItem = todoItems.find(i => i.title === todoTitle);
        // Check Job field first, then scan docs/designs/ for a slug match
        let hasDesignDoc = !!nextJob.designDoc;
        if (!hasDesignDoc && todoTitle) {
          try {
            const designsDir = join(jobConfig.worktreePath ?? jobConfig.projectDir, "docs", "designs");
            if (existsSync(designsDir)) {
              const slug = slugify(todoTitle);
              const files = readdirSync(designsDir);
              hasDesignDoc = files.some(f => f.replace(/\.md$/i, "") === slug);
            }
          } catch {
            // Fail-open: if scan fails, assume no design doc
          }
        }
        // Read pipeline outcome history for Oracle-driven composition
        const historyPath = join(parentCheckpointDir ?? checkpointDir, "pipeline-outcomes.jsonl");
        const outcomes = readPipelineOutcomes(historyPath);
        const useOracle = shouldUseOracleComposition(outcomes);
        const skipRiskScores = useOracle ? computeSkipRiskScores(outcomes) : undefined;

        const originalSkills = [...nextJob.skills];
        const composed = composePipeline({
          effort: todoItem?.effort ?? null,
          priority: todoItem?.priority ?? 3,
          hasDesignDoc,
          requestedSkills: nextJob.skills,
          skipRiskScores,
        });
        if (composed.skills.length < nextJob.skills.length || composed.oracleRestoredSkills?.length) {
          d.log("info", `Adaptive composition: [${originalSkills.join(", ")}] -> [${composed.skills.join(", ")}] (${composed.reason}, saves ${composed.savings})`);
          nextJob.composedFrom = originalSkills;
          nextJob.skills = composed.skills;
          nextJob.compositionMethod = composed.oracleRestoredSkills?.length ? "oracle" : "static";
          callbacks.onEvent({
            type: "pipeline_composed",
            originalSkills,
            composedSkills: composed.skills,
            reason: composed.reason,
          });

          // Emit per-skill Oracle adjustment events
          if (composed.oracleRestoredSkills?.length) {
            oracleAdjustedComposition = true;
            for (const skill of composed.oracleRestoredSkills) {
              callbacks.onEvent({
                type: "pipeline_oracle_adjustment",
                skill,
                skipRisk: skipRiskScores?.get(skill) ?? 0,
                action: "restored",
              });
            }
          }
        }
        // ── Oracle-recommended pipeline override ───────────────────
        // If the prioritize skill output a "### Recommended Pipeline" section
        // and we have enough pipeline outcome data, use it instead of static table.
        const priorityDir = jobConfig.worktreePath ?? jobConfig.projectDir;
        const priorityPath = join(priorityDir, ".garyclaw", "priority.md");
        const priorityContent = safeReadText(priorityPath);
        if (priorityContent) {
          const oracleRecommendation = parsePipelineRecommendation(priorityContent);
          if (oracleRecommendation) {
            // Count pipeline outcomes from decision-outcomes.md for cold-start gate
            const memConfig = defaultMemoryConfig(jobConfig.projectDir);
            const memoryFiles = readOracleMemory(memConfig, jobConfig.projectDir);
            const pipelineOutcomeCount = countPipelineOutcomes(memoryFiles.decisionOutcomes);

            if (pipelineOutcomeCount >= ORACLE_PIPELINE_THRESHOLD) {
              // Intersect with requestedSkills (oracle can only remove, never add)
              const oracleComposed = originalSkills.filter(s => oracleRecommendation.includes(s));
              const isDifferentFromCurrent = oracleComposed.length !== nextJob.skills.length
                || oracleComposed.some(s => !nextJob.skills.includes(s));
              if (oracleComposed.length > 0 && isDifferentFromCurrent) {
                d.log("info", `Oracle pipeline override: [${nextJob.skills.join(", ")}] -> [${oracleComposed.join(", ")}] (${pipelineOutcomeCount} outcomes)`);
                nextJob.skills = oracleComposed;
                nextJob.composedFrom = nextJob.composedFrom ?? originalSkills;
                nextJob.compositionMethod = "oracle";
                callbacks.onEvent({
                  type: "pipeline_composed",
                  originalSkills,
                  composedSkills: oracleComposed,
                  reason: `oracle recommendation (${pipelineOutcomeCount} outcomes)`,
                });
              }
            } else {
              d.log("debug", `Oracle pipeline recommendation available but only ${pipelineOutcomeCount}/${ORACLE_PIPELINE_THRESHOLD} outcomes — using static table`);
            }
          }
        }

        // Set compositionMethod to "static" if composition happened but oracle didn't override
        if (nextJob.composedFrom && !nextJob.compositionMethod) {
          nextJob.compositionMethod = "static";
        }
      } catch (err) {
        d.log("warn", `Pipeline composition failed: ${err instanceof Error ? err.message : String(err)}`);
        // Fail-open: use original skills
      }
    }

    // ── TODO state tracking: skip already-completed stages ────────
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

          // Ensure state file exists and is set to "complete" so future
          // pre-assignment checks skip this item. Without this, artifact-detected
          // completions (no state file) or auto-cleanup'd state files cause
          // an infinite skip→re-enqueue→skip loop.
          try {
            const finalState = reconciledState.state === "qa-complete" && !jobConfig.worktreePath
              ? "complete"  // Default instance: promote qa-complete directly (no merge step)
              : reconciledState.state === "merged"
                ? "complete"  // merged → complete is natural lifecycle progression
                : reconciledState.state;
            writeTodoState(stateCheckpointDir, slug, {
              ...reconciledState,
              state: finalState,
              lastJobId: nextJob.id,
              updatedAt: new Date().toISOString(),
            });
            if (finalState !== reconciledState.state) {
              d.log("info", `TODO "${todoTitle}" promoted ${reconciledState.state} → ${finalState}`);
            }

            // Auto-mark TODOS.md heading as ~~complete~~ only for terminal states.
            // pr-created is NOT terminal — the PR hasn't merged yet.
            if (finalState === "complete") {
              try {
                const todosPath = join(jobConfig.projectDir, "TODOS.md");
                const summary = `Completed (detected by artifact reconciliation, job ${nextJob.id}).`;
                const marked = markTodoCompleteInFile(todosPath, todoTitle, summary);
                if (marked) {
                  d.log("info", `Auto-marked TODO "${todoTitle}" complete in TODOS.md`);
                }
              } catch (markErr) {
                d.log("warn", `Auto-mark TODOS.md failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`);
              }
            }
          } catch {
            // Fail-open
          }

          nextJob.status = "complete";
          nextJob.completedAt = new Date().toISOString();
          persistState(state, checkpointDir);
          // Continuous: re-enqueue — state file now ensures pre-assignment skips this TODO
          enqueue(nextJob.composedFrom ?? nextJob.skills, "continuous", "skip-completed re-enqueue", nextJob.designDoc);
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
          const reId2 = enqueue(nextJob.composedFrom ?? nextJob.skills, "continuous", "all-skills-complete re-enqueue", nextJob.designDoc);
          if (reId2) d.log("info", `Continuous: re-enqueued as ${reId2} after all skills complete`);
          running = false;
          processNext().catch(err => d.log("error", `processNext after all-skills-complete failed: ${err instanceof Error ? err.message : String(err)}`));
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

    const clawConfig = buildGaryClawConfig(jobConfig, nextJob, jobDir, d, claimedItems, preAssignedTitle, parentCheckpointDir ?? checkpointDir);

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
          updateGlobalBudget(parentCheckpointDir, nextJob.costUsd, resolvedInstanceName, (msg) => d.log("warn", String(msg)));
        } catch (err) {
          d.log("warn", `Failed to update global budget: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      d.writeSummary(nextJob, jobDir);
      d.notifyJobComplete(nextJob, jobConfig);
      d.log("info", `Completed ${nextJob.id}: $${nextJob.costUsd.toFixed(3)}`);

      // Auto-fix cost accumulation: track spending for budget cap enforcement
      if (nextJob.triggeredBy === "post-merge-revert") {
        try {
          if (nextJob.autoFixMergeSha) {
            // Preferred: use typed field for direct SHA lookup
            updateAutoFixCost(checkpointDir, nextJob.autoFixMergeSha, nextJob.costUsd, true);
          } else {
            // Fallback: parse SHA from triggerDetail (backwards compat)
            updateAutoFixCost(checkpointDir, nextJob.triggerDetail, nextJob.costUsd);
          }
        } catch (err) {
          d.log("warn", `Auto-fix cost update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Auto-merge: named instances merge their branch to main after successful jobs
      if (jobConfig.worktreePath && resolvedInstanceName !== "default") {
        try {
          const baseBranch = resolveBaseBranch(jobConfig.projectDir);
          const mergeConfig = jobConfig.merge;
          const mergeStrategy = mergeConfig?.strategy ?? "direct";

          if (mergeStrategy === "pr") {
            // ── PR-based merge strategy ────────────────────────────
            // Run pre-merge tests using shared helper (same logic as direct strategy)
            const prTestResult = runPreMergeTests(
              jobConfig.worktreePath!,
              mergeConfig,
              d.log,
            );
            let testsPassed = prTestResult.passed;
            const testDurationMs = prTestResult.durationMs;
            if (testsPassed === false) {
              d.log("warn", "Skipping PR creation due to test failure");
              const syntheticErr = Object.assign(
                new Error("Pre-merge tests failed (PR strategy)"),
                { name: "MergeValidationError" },
              );
              const record = buildFailureRecord(syntheticErr, nextJob.id, nextJob.skills, resolvedInstanceName);
              appendFailureRecord(record, checkpointDir);
            }

            if (testsPassed !== false) {
              // Rebase onto baseBranch before pushing
              const wtDir = jobConfig.worktreePath;
              try {
                execFileSync("git", ["rebase", baseBranch], { cwd: wtDir, stdio: "pipe" });
              } catch {
                try { execFileSync("git", ["rebase", "--abort"], { cwd: wtDir, stdio: "pipe" }); } catch { /* noop */ }
                d.log("warn", `Rebase of garyclaw/${resolvedInstanceName} onto ${baseBranch} had conflicts — skipping PR creation`);
                // Log rebase conflict to failures.jsonl for dashboard observability
                const syntheticErr = Object.assign(
                  new Error(`Rebase conflict: garyclaw/${resolvedInstanceName} onto ${baseBranch}`),
                  { name: "RebaseConflictError" },
                );
                const record = buildFailureRecord(syntheticErr, nextJob.id, nextJob.skills, resolvedInstanceName);
                appendFailureRecord(record, checkpointDir);
                // Fall through — don't create PR on rebase conflict
                testsPassed = false;
              }

              if (testsPassed !== false) {
                // Build PR body from job context
                const prBody = buildPrBody({
                  instanceName: resolvedInstanceName,
                  skills: nextJob.skills.map((s) => ({ name: s, status: "complete" })),
                  costUsd: nextJob.costUsd,
                  todoTitle: nextJob.claimedTodoTitle,
                  testsPassed,
                  testDurationSec: testDurationMs !== undefined ? testDurationMs / 1000 : undefined,
                });

                const prTitle = nextJob.claimedTodoTitle
                  ? `GaryClaw: ${nextJob.claimedTodoTitle}`
                  : `GaryClaw: ${nextJob.skills.join(" → ")} (${resolvedInstanceName})`;

                const prResult = createPullRequest(
                  jobConfig.projectDir,
                  resolvedInstanceName,
                  {
                    title: prTitle.slice(0, 256),  // GitHub title limit
                    body: prBody,
                    baseBranch,
                    labels: mergeConfig?.prLabels,
                    reviewers: mergeConfig?.prReviewers,
                    draft: mergeConfig?.prDraft,
                    autoMerge: mergeConfig?.prAutoMerge ?? true,
                    mergeMethod: mergeConfig?.prMergeMethod ?? "squash",
                    onWarn: (msg) => d.log("warn", msg),
                  },
                );

                if (prResult.created) {
                  d.log("info", `PR #${prResult.prNumber} created: ${prResult.prUrl}` +
                    (prResult.autoMergeEnabled ? " (auto-merge enabled)" : ""));

                  // Advance TODO state to "pr-created"
                  if (nextJob.claimedTodoTitle) {
                    try {
                      const todoSlug = slugify(nextJob.claimedTodoTitle);
                      const stateCheckpointDir = parentCheckpointDir ?? checkpointDir;
                      const existingState = findTodoState(stateCheckpointDir, nextJob.claimedTodoTitle);
                      writeTodoState(stateCheckpointDir, todoSlug, {
                        title: nextJob.claimedTodoTitle,
                        slug: todoSlug,
                        state: "pr-created",
                        designDocPath: existingState?.designDocPath,
                        branch: existingState?.branch,
                        instanceName: resolvedInstanceName,
                        lastJobId: nextJob.id,
                        updatedAt: new Date().toISOString(),
                      });
                      d.log("info", `TODO "${nextJob.claimedTodoTitle}" advanced to "pr-created"`);
                    } catch {
                      // Fail-open
                    }
                  }

                  // Log to merge audit
                  appendMergeAudit(jobConfig.projectDir, resolvedInstanceName,
                    branchName(resolvedInstanceName), baseBranch,
                    { merged: false, reason: `PR #${prResult.prNumber} created`, commitCount: 0 },
                    { jobId: nextJob.id, onWarn: (msg) => d.log("warn", msg) });

                  d.notifyPrCreated?.(nextJob, prResult, jobConfig);
                } else {
                  d.log("warn", `PR creation failed: ${prResult.reason} — falling back to direct merge`);
                  // Fallback to direct merge
                  const mergeResult = mergeWorktreeBranch(
                    jobConfig.projectDir, resolvedInstanceName, baseBranch,
                    { jobId: nextJob.id, onWarn: (msg) => d.log("warn", msg) },
                  );
                  if (mergeResult.merged) {
                    d.log("info", `Fallback direct merge: merged ${mergeResult.commitCount ?? 0} commit(s)`);
                    advanceTodoToMerged(nextJob, resolvedInstanceName, parentCheckpointDir ?? checkpointDir, jobConfig.projectDir, d.log);

                    // Post-merge verification (defense-in-depth) — same as direct strategy path
                    handlePostMergeVerification({
                      projectDir: jobConfig.projectDir,
                      instanceName: resolvedInstanceName,
                      jobId: nextJob.id,
                      skills: nextJob.skills,
                      checkpointDir,
                      mergeConfig: jobConfig.merge,
                      testsPassed: mergeResult.testsPassed,
                      commitCount: mergeResult.commitCount ?? 0,
                      log: d.log,
                      notifyMergeReverted: d.notifyMergeReverted,
                      job: nextJob,
                      config: jobConfig,
                      enqueue,
                      _getState: () => state,
                    });
                  } else {
                    d.log("warn", `Fallback direct merge also blocked: ${mergeResult.reason}`);
                    d.notifyMergeBlocked?.(nextJob, mergeResult, jobConfig);
                  }
                }
              }
            }
          } else {
            // ── Direct merge strategy (existing behavior) ───────────
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
                onWarn: (msg) => d.log("warn", msg),
              },
            );

            if (mergeResult.merged) {
              d.log("info", `Auto-merge: merged ${mergeResult.commitCount ?? 0} commit(s) from garyclaw/${resolvedInstanceName} to ${baseBranch}` +
                (mergeResult.testDurationMs ? ` (tests: ${Math.round(mergeResult.testDurationMs / 1000)}s)` : ""));

              advanceTodoToMerged(nextJob, resolvedInstanceName, parentCheckpointDir ?? checkpointDir, jobConfig.projectDir, d.log);

              // Post-merge verification (defense-in-depth)
              handlePostMergeVerification({
                projectDir: jobConfig.projectDir,
                instanceName: resolvedInstanceName,
                jobId: nextJob.id,
                skills: nextJob.skills,
                checkpointDir,
                mergeConfig: jobConfig.merge,
                testsPassed: mergeResult.testsPassed,
                commitCount: mergeResult.commitCount ?? 0,
                log: d.log,
                notifyMergeReverted: d.notifyMergeReverted,
                job: nextJob,
                config: jobConfig,
                enqueue,
                _getState: () => state,
              });
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
          }
        } catch (err) {
          d.log("warn", `Auto-merge error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (nextJob.claimedTodoTitle) {
        // Default instance (no worktree): commits go directly to main,
        // so there's no merge step. Promote qa-complete → complete directly.
        try {
          const todoSlug = slugify(nextJob.claimedTodoTitle);
          const stateCheckpointDir = parentCheckpointDir ?? checkpointDir;
          const existingState = findTodoState(stateCheckpointDir, nextJob.claimedTodoTitle);
          if (existingState && existingState.state === "qa-complete") {
            writeTodoState(stateCheckpointDir, todoSlug, {
              ...existingState,
              state: "complete",
              lastJobId: nextJob.id,
              updatedAt: new Date().toISOString(),
            });
            d.log("info", `TODO "${nextJob.claimedTodoTitle}" promoted qa-complete → complete (default instance, no merge step)`);

            // Auto-mark TODOS.md
            try {
              const todosPath = join(jobConfig.projectDir, "TODOS.md");
              const summary = `Completed by default instance (job ${nextJob.id}).`;
              const marked = markTodoCompleteInFile(todosPath, nextJob.claimedTodoTitle!, summary);
              if (marked) {
                d.log("info", `Auto-marked TODO "${nextJob.claimedTodoTitle}" complete in TODOS.md`);
              }
            } catch (markErr) {
              d.log("warn", `Auto-mark TODOS.md failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`);
            }
          }
        } catch {
          // Fail-open
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

      // Rate limit / auth detection: hold all jobs instead of spam-retrying
      const shouldHold =
        (classification.category === "infra-issue" && isRateLimitError(nextJob.error)) ||
        classification.category === "auth-issue";

      if (shouldHold) {
        const resetAt = parseRateLimitResetTime(nextJob.error);
        const holdUntil = resetAt ?? new Date(Date.now() + RATE_LIMIT_FALLBACK_MS);
        state.rateLimitResetAt = holdUntil.toISOString();
        nextJob.status = "rate_limited";
        nextJob.completedAt = undefined; // Not actually completed — will be re-queued
        d.log("info", `Rate limited until ${holdUntil.toISOString()} — holding all jobs`);

        // Propagate to global budget for cross-instance coordination
        if (parentCheckpointDir) {
          try {
            setGlobalRateLimitHold(parentCheckpointDir, holdUntil.toISOString(), resolvedInstanceName, (msg) => d.log("warn", String(msg)));
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

      // Record pipeline outcome for Oracle-driven composition learning
      if (nextJob.status === "complete" || nextJob.status === "failed") {
        try {
          const outcomeHistoryPath = join(parentCheckpointDir ?? checkpointDir, "pipeline-outcomes.jsonl");
          const allSkills = nextJob.composedFrom ?? nextJob.skills;
          const skippedSkills = allSkills.filter(s => !nextJob.skills.includes(s));
          // Count critical/high issues from job report (best-effort parse)
          let qaFailureCount = 0;
          let reopenedCount = 0;
          try {
            if (nextJob.reportPath && existsSync(nextJob.reportPath)) {
              const reportContent = readFileSync(nextJob.reportPath, "utf-8");
              // Count critical/high severity markers in report
              qaFailureCount = (reportContent.match(/\*\*critical\*\*/gi) ?? []).length
                + (reportContent.match(/\*\*high\*\*/gi) ?? []).length;
              reopenedCount = (reportContent.match(/reopened/gi) ?? []).length;
            }
          } catch {
            // Best-effort — don't block outcome recording
          }

          const outcome: "success" | "partial" | "failure" =
            qaFailureCount > 0 || reopenedCount > 0 ? "failure"
            : nextJob.status === "failed" ? "failure"
            : "success";

          // Read priority.md for task category, effort, and priority
          const outcomePriorityDir = jobConfig.worktreePath ?? jobConfig.projectDir;
          const outcomePriorityPath = join(outcomePriorityDir, ".garyclaw", "priority.md");
          const outcomePriorityContent = safeReadText(outcomePriorityPath);
          const taskCategory = outcomePriorityContent
            ? parseTaskCategory(outcomePriorityContent)
            : "unknown";
          const effort = outcomePriorityContent
            ? parseEffort(outcomePriorityContent)
            : null;
          const priority = outcomePriorityContent
            ? parsePriority(outcomePriorityContent)
            : 3;

          appendPipelineOutcome(outcomeHistoryPath, {
            jobId: nextJob.id,
            timestamp: new Date().toISOString(),
            todoTitle: nextJob.claimedTodoTitle ?? "unknown",
            effort,
            priority,
            skills: nextJob.skills,
            skippedSkills,
            composedFrom: nextJob.composedFrom,
            qaFailureCount,
            reopenedCount,
            outcome,
            oracleAdjusted: oracleAdjustedComposition,
            taskCategory,
          });
        } catch (err) {
          d.log("warn", `Pipeline outcome recording failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Auto-research trigger: analyze low-confidence decisions and enqueue research
      if (nextJob.status === "complete" && currentConfig.autoResearch?.enabled) {
        try {
          // Read decisions from top-level AND pipeline skill subdirs
          const decisions = collectAllDecisions(jobDir, (msg) => d.log("warn", msg));
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
      const originalSkills = nextJob.composedFrom ?? nextJob.skills;
      if (
        nextJob.status === "complete" &&
        originalSkills.length > 1 &&
        originalSkills.includes("prioritize") &&
        nextJob.costUsd >= MIN_COST_FOR_REENQUEUE
      ) {
        const reEnqueueId = enqueue(originalSkills, "continuous", "auto re-enqueue after successful pipeline", nextJob.designDoc);
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
export function collectAllDecisions(jobDir: string, onWarn?: WarnFn): Decision[] {
  const decisions: Decision[] = [];

  // Top-level decisions.jsonl (single-skill jobs)
  const topLevel = join(jobDir, "decisions.jsonl");
  if (existsSync(topLevel)) {
    decisions.push(...readDecisionsFromLog(topLevel, onWarn));
  }

  // Pipeline skill subdirs: skill-{i}-{name}/decisions.jsonl
  try {
    const entries = readdirSync(jobDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith("skill-")) {
        const subLog = join(jobDir, entry.name, "decisions.jsonl");
        if (existsSync(subLog)) {
          decisions.push(...readDecisionsFromLog(subLog, onWarn));
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
  rootCheckpointDir?: string,
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
    rootCheckpointDir,
    autoFixMergeSha: job.autoFixMergeSha,
  };
}

/**
 * Parse the "Top Pick:" title from priority.md content.
 */
export function parsePriorityPickTitle(content: string): string | null {
  const match = content.match(/^## Top Pick:\s*(.+)/m);
  return match ? match[1].trim() : null;
}

/**
 * Parse alternative pick titles from the "## Alternatives" section.
 * Matches `### 2nd:`, `### 3rd:`, etc. headings.
 */
export function parseAlternativeTitles(content: string): string[] {
  const titles: string[] = [];
  const pattern = /^### \d+(?:st|nd|rd|th):\s*(.+?)(?:\s*—\s*.+)?$/gm;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const title = match[1].trim();
    if (title) titles.push(title);
  }
  return titles;
}

/** Minimum pipeline outcome count before oracle recommendations override static table. */
export const ORACLE_PIPELINE_THRESHOLD = 10;

// Re-export for backward compat (tests import from here)
export { VALID_TASK_CATEGORIES, TASK_CATEGORY_DESCRIPTIONS } from "./types.js";

/**
 * Parse the "### Task Category" section from priority.md content.
 * Returns one of VALID_TASK_CATEGORIES, defaulting to "unknown" if missing or invalid.
 */
export function parseTaskCategory(content: string): string {
  // Match both "### Task Category\nvalue" and "### Task Category: value"
  const match = content.match(/^###\s*Task Category[\s:]+(\S+)/m);
  if (!match) return "unknown";
  const raw = match[1].toLowerCase().trim();
  return (VALID_TASK_CATEGORIES as readonly string[]).includes(raw) ? raw : "unknown";
}

/** Valid effort sizes for pipeline outcome tracking. */
export const VALID_EFFORTS = ["XS", "S", "M", "L", "XL"] as const;

/**
 * Parse the effort size from priority.md content.
 * Looks for patterns like "Effort: S", "**Effort:** M", "Effort S".
 * Returns uppercase effort string or null if missing/invalid.
 */
export function parseEffort(content: string): string | null {
  const match = content.match(/Effort[\s:*]*\b(XS|S|M|L|XL)\b/i);
  if (!match) return null;
  const raw = match[1].toUpperCase();
  return (VALID_EFFORTS as readonly string[]).includes(raw) ? raw : null;
}

/**
 * Parse the priority level from priority.md content.
 * Looks for patterns like "Priority: P2", "**Priority:** P1".
 * Returns the numeric priority (1-5) or 3 as default.
 */
export function parsePriority(content: string): number {
  const match = content.match(/Priority[\s:*]*P(\d)/i);
  if (!match) return 3;
  const n = parseInt(match[1], 10);
  return n >= 1 && n <= 5 ? n : 3;
}

/**
 * Parse the "### Recommended Pipeline" section from priority.md content.
 * Returns an array of skill names, or null if the section is missing or malformed.
 *
 * Accepts both ASCII arrows (->) and unicode arrows (→).
 * Allows blank lines between the heading and the pipeline content.
 */
export function parsePipelineRecommendation(content: string): string[] | null {
  const match = content.match(
    /### Recommended Pipeline\s*\n+\s*([a-z][a-z0-9-]*(?:\s*(?:->|→)\s*[a-z][a-z0-9-]*)*)/i,
  );
  if (!match) return null;
  return match[1]
    .split(/\s*(?:->|→)\s*/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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
            let title = parsePriorityPickTitle(priorityContent);
            if (title && title !== "Backlog Exhausted") {
              // Validation gate: reject picks that match completed items
              const todosPath = join(priorityDir, "TODOS.md");
              const todosContent = safeReadText(todosPath);
              const completedTitles = todosContent ? extractCompletedTitles(todosContent) : [];
              if (!isPickValid(title, completedTitles)) {
                deps.log("warn", `Priority pick rejected (completed): "${title}"`);
                job.priorityPickRejected = true;
                if (config.onEvent) {
                  config.onEvent({ type: "priority_pick_rejected", title, reason: "completed" });
                }
                // Fall through to alternatives
                const alternatives = parseAlternativeTitles(priorityContent);
                const validAlt = alternatives.find(alt => isPickValid(alt, completedTitles));
                if (validAlt) {
                  title = validAlt;
                  deps.log("info", `Fell through to alternative: "${title}"`);
                } else {
                  deps.log("warn", "All priority picks rejected — no valid alternative");
                  if (config.onEvent) {
                    config.onEvent({ type: "priority_pick_exhausted" });
                  }
                  title = null;
                }
              }
              if (title) {
                job.claimedTodoTitle = title;
                persistState(claimContext.state, claimContext.checkpointDir);
                deps.log("info", `Priority claimed (early): "${title}"`);
              }
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
      // Collect per-skill costs from pipeline_skill_complete events (zero I/O)
      if (event.type === "pipeline_skill_complete") {
        if (!job.skillCosts) {
          job.skillCosts = {};
        }
        job.skillCosts[event.skillName] = event.costUsd;
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
  _resolvedInstanceName: string,
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

/** Minimum job cost to allow continuous re-enqueue. Prevents $0 spin loops. */
export const MIN_COST_FOR_REENQUEUE = 0.01;

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
