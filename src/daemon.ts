/**
 * Daemon — persistent background process for GaryClaw.
 *
 * Reads config from .garyclaw/daemon.json, starts IPC server + job runner +
 * git pollers, handles SIGTERM/SIGINT for graceful shutdown.
 *
 * Lifecycle:
 * 1. Validate config
 * 2. Check/write PID file
 * 3. Start IPC server
 * 4. Create job runner
 * 5. Start git pollers
 * 6. Main loop: processNext() on interval
 * 7. Signal handlers for graceful shutdown
 */

import { readFileSync, unlinkSync, existsSync, appendFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createIPCServer, type IPCHandler } from "./daemon-ipc.js";
import { createJobRunner, type JobRunner } from "./job-runner.js";
import { createGitPoller, createCronPoller, validateCronExpression, type GitPoller } from "./triggers.js";
import { defaultMemoryConfig, readMetrics } from "./oracle-memory.js";
import {
  ensureInstanceDir,
  resolveInstanceName,
  listInstances,
  migrateToInstanceDir,
} from "./daemon-registry.js";
import { createWorktree, mergeWorktreeBranch, resolveBaseBranch } from "./worktree.js";
import { runAutoCleanup } from "./doctor.js";
import {
  readPidFile as readPidFileDirect,
  isPidAlive as isPidAliveDirect,
  writePidFile as writePidFileDirect,
  removePidFile,
} from "./pid-utils.js";
import { readPipelineState } from "./pipeline.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DaemonConfig, IPCRequest, IPCResponse, PipelineProgress } from "./types.js";
import type { Server } from "node:net";

const execFileAsync = promisify(execFile);

const PID_FILE = "daemon.pid";
const SOCKET_FILE = "daemon.sock";
const LOG_FILE = "daemon.log";
const CONFIG_FILE = "daemon.json";
const PROCESS_INTERVAL_MS = 5000;

export interface DaemonContext {
  config: DaemonConfig;
  checkpointDir: string;
  runner: JobRunner;
  server: Server;
  pollers: GitPoller[];
  processTimer: ReturnType<typeof setInterval> | null;
  startTime: number;
}

/**
 * Validate a DaemonConfig object. Returns null if valid, error string otherwise.
 */
export function validateDaemonConfig(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return "Config must be an object";
  const d = data as Record<string, unknown>;

  if (d.version !== 1) return "Config version must be 1";
  if (typeof d.projectDir !== "string" || d.projectDir.length === 0) return "projectDir is required";
  if (!Array.isArray(d.triggers)) return "triggers must be an array";
  if (typeof d.budget !== "object" || d.budget === null) return "budget is required";
  if (typeof d.notifications !== "object" || d.notifications === null) return "notifications is required";
  if (typeof d.orchestrator !== "object" || d.orchestrator === null) return "orchestrator is required";
  if (typeof d.logging !== "object" || d.logging === null) return "logging is required";

  const budget = d.budget as Record<string, unknown>;
  if (typeof budget.dailyCostLimitUsd !== "number" || budget.dailyCostLimitUsd <= 0) {
    return "budget.dailyCostLimitUsd must be a positive number";
  }
  if (typeof budget.perJobCostLimitUsd !== "number" || budget.perJobCostLimitUsd <= 0) {
    return "budget.perJobCostLimitUsd must be a positive number";
  }
  if (typeof budget.maxJobsPerDay !== "number" || budget.maxJobsPerDay <= 0) {
    return "budget.maxJobsPerDay must be a positive number";
  }

  // Validate triggers
  for (let i = 0; i < (d.triggers as unknown[]).length; i++) {
    const t = (d.triggers as unknown[])[i] as Record<string, unknown>;
    if (typeof t !== "object" || t === null) return `triggers[${i}] must be an object`;

    if (t.type === "git_poll") {
      if (typeof t.intervalSeconds !== "number" || t.intervalSeconds <= 0) {
        return `triggers[${i}].intervalSeconds must be a positive number`;
      }
      if (!Array.isArray(t.skills) || t.skills.length === 0) {
        return `triggers[${i}].skills must be a non-empty array`;
      }
      // selfCommitEmail is optional, but if present must be a non-empty string
      if (t.selfCommitEmail !== undefined) {
        if (typeof t.selfCommitEmail !== "string" || t.selfCommitEmail.length === 0) {
          return `triggers[${i}].selfCommitEmail must be a non-empty string`;
        }
      }
    } else if (t.type === "cron") {
      if (typeof t.expression !== "string" || t.expression.length === 0) {
        return `triggers[${i}].expression is required for cron triggers`;
      }
      const cronError = validateCronExpression(t.expression);
      if (cronError) {
        return `triggers[${i}]: ${cronError}`;
      }
      if (!Array.isArray(t.skills) || t.skills.length === 0) {
        return `triggers[${i}].skills must be a non-empty array`;
      }
    } else {
      return `triggers[${i}].type must be "git_poll" or "cron"`;
    }
  }

  // Validate merge config if provided (optional field)
  if (d.merge !== undefined) {
    if (typeof d.merge !== "object" || d.merge === null) {
      return "merge must be an object";
    }
    const m = d.merge as Record<string, unknown>;
    if (m.testCommand !== undefined && (typeof m.testCommand !== "string" || m.testCommand.length === 0)) {
      return "merge.testCommand must be a non-empty string";
    }
    if (m.testTimeout !== undefined && (typeof m.testTimeout !== "number" || m.testTimeout <= 0)) {
      return "merge.testTimeout must be a positive number";
    }
    if (m.skipValidation !== undefined && typeof m.skipValidation !== "boolean") {
      return "merge.skipValidation must be a boolean";
    }
    if (m.skipPostMergeVerification !== undefined && typeof m.skipPostMergeVerification !== "boolean") {
      return "merge.skipPostMergeVerification must be a boolean";
    }
    if (m.forcePostMergeVerification !== undefined && typeof m.forcePostMergeVerification !== "boolean") {
      return "merge.forcePostMergeVerification must be a boolean";
    }
    if (m.strategy !== undefined && m.strategy !== "direct" && m.strategy !== "pr") {
      return 'merge.strategy must be "direct" or "pr"';
    }
    if (m.prAutoMerge !== undefined && typeof m.prAutoMerge !== "boolean") {
      return "merge.prAutoMerge must be a boolean";
    }
    if (m.prMergeMethod !== undefined && m.prMergeMethod !== "squash" && m.prMergeMethod !== "merge" && m.prMergeMethod !== "rebase") {
      return 'merge.prMergeMethod must be "squash", "merge", or "rebase"';
    }
    if (m.prLabels !== undefined && (!Array.isArray(m.prLabels) || !m.prLabels.every((l: unknown) => typeof l === "string"))) {
      return "merge.prLabels must be an array of strings";
    }
    if (m.prReviewers !== undefined && (!Array.isArray(m.prReviewers) || !m.prReviewers.every((r: unknown) => typeof r === "string"))) {
      return "merge.prReviewers must be an array of strings";
    }
    if (m.prDraft !== undefined && typeof m.prDraft !== "boolean") {
      return "merge.prDraft must be a boolean";
    }
    if (m.autoFixOnRevert !== undefined && typeof m.autoFixOnRevert !== "boolean") {
      return "merge.autoFixOnRevert must be a boolean";
    }
  }

  // Validate autoResearch if provided (optional field)
  if (d.autoResearch !== undefined) {
    if (typeof d.autoResearch !== "object" || d.autoResearch === null) {
      return "autoResearch must be an object";
    }
    const ar = d.autoResearch as Record<string, unknown>;
    if (typeof ar.enabled !== "boolean") return "autoResearch.enabled must be a boolean";
    if (typeof ar.lowConfidenceThreshold !== "number" || ar.lowConfidenceThreshold < 1 || ar.lowConfidenceThreshold > 10) {
      return "autoResearch.lowConfidenceThreshold must be a number between 1 and 10";
    }
    if (typeof ar.minDecisionsToTrigger !== "number" || ar.minDecisionsToTrigger < 1) {
      return "autoResearch.minDecisionsToTrigger must be a positive number";
    }
    if (typeof ar.maxTopicsPerJob !== "number" || ar.maxTopicsPerJob < 1) {
      return "autoResearch.maxTopicsPerJob must be a positive number";
    }
  }

  return null;
}

/**
 * Load daemon config from the checkpoint directory.
 * Supports config fallback: checks instanceDir first, then parentDir.
 */
export function loadDaemonConfig(checkpointDir: string, fallbackDir?: string): DaemonConfig | null {
  // Try primary location first
  const configPath = join(checkpointDir, CONFIG_FILE);
  if (existsSync(configPath)) {
    try {
      const data = JSON.parse(readFileSync(configPath, "utf-8"));
      const error = validateDaemonConfig(data);
      if (!error) return data as DaemonConfig;
    } catch {
      // Fall through to fallback
    }
  }

  // Try fallback location (parent checkpoint dir for shared config)
  if (fallbackDir) {
    const fallbackPath = join(fallbackDir, CONFIG_FILE);
    if (existsSync(fallbackPath)) {
      try {
        const data = JSON.parse(readFileSync(fallbackPath, "utf-8"));
        const error = validateDaemonConfig(data);
        if (!error) return data as DaemonConfig;
      } catch {
        // Give up
      }
    }
  }

  return null;
}

/**
 * Check if a PID file points to an alive process.
 * Delegates to shared pid-utils module.
 */
export function isPidAlive(pid: number): boolean {
  return isPidAliveDirect(pid).alive;
}

/**
 * Read PID from file. Returns null if file doesn't exist or is invalid.
 * Delegates to shared pid-utils module.
 */
export function readPidFile(checkpointDir: string): number | null {
  return readPidFileDirect(join(checkpointDir, PID_FILE));
}

/**
 * Write PID file.
 * Delegates to shared pid-utils module.
 */
export function writePidFile(checkpointDir: string, pid: number): void {
  writePidFileDirect(join(checkpointDir, PID_FILE), pid);
}

/**
 * Clean up PID and socket files.
 */
export function cleanupDaemonFiles(checkpointDir: string): void {
  removePidFile(join(checkpointDir, PID_FILE));
  const sockPath = join(checkpointDir, SOCKET_FILE);
  try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* ignore */ }
}

/**
 * Create a logging function that appends to the daemon log file.
 */
export function createDaemonLogger(
  checkpointDir: string,
  level: DaemonConfig["logging"]["level"],
): (msgLevel: string, message: string) => void {
  const logPath = join(checkpointDir, LOG_FILE);
  const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  const threshold = levels[level] ?? 1;

  const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB

  // Track bytes written in-memory to avoid stat() syscall on every log write.
  // Seed from actual file size on creation, then track incrementally.
  let bytesWritten = 0;
  try {
    if (existsSync(logPath)) {
      bytesWritten = statSync(logPath).size;
    }
  } catch { /* start from 0 */ }

  return (msgLevel: string, message: string) => {
    if ((levels[msgLevel] ?? 1) < threshold) return;
    const line = `[${new Date().toISOString()}] [${msgLevel.toUpperCase()}] ${message}\n`;
    try {
      // Rotate if tracked bytes exceed max size
      if (bytesWritten > MAX_LOG_BYTES) {
        const rotatedPath = logPath + ".1";
        try { renameSync(logPath, rotatedPath); } catch { /* ignore */ }
        bytesWritten = 0;
      }
      appendFileSync(logPath, line, "utf-8");
      bytesWritten += Buffer.byteLength(line, "utf-8");
    } catch {
      // Can't write to log — silently ignore
    }
  };
}

/**
 * Get commit count on a worktree branch since it diverged from base.
 * Returns 0 on any error. Async to avoid blocking IPC event loop.
 */
export async function getWorktreeCommitCount(
  worktreePath?: string,
  projectDir?: string,
): Promise<number> {
  if (!worktreePath) return 0;
  try {
    const base = resolveBaseBranch(projectDir ?? worktreePath);
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "rev-list", "--count", `${base}..HEAD`],
      { encoding: "utf-8", timeout: 3000 },
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Build the IPC request handler for the daemon.
 */
export function buildIPCHandler(
  runner: JobRunner,
  startTime: number,
  projectDir?: string,
  parentCheckpointDir?: string,
  instDir?: string,
  worktreePath?: string,
): IPCHandler {
  // Cached commit count, refreshed every 10s to avoid git subprocess on every IPC call
  let cachedCommitCount = 0;
  let lastCommitCountRefresh = 0;
  const COMMIT_COUNT_REFRESH_MS = 10_000;

  return async (request: IPCRequest): Promise<IPCResponse> => {
    switch (request.type) {
      case "status": {
        // Refresh commit count cache if stale (set timestamp before await to prevent duplicate requests)
        if (worktreePath && Date.now() - lastCommitCountRefresh > COMMIT_COUNT_REFRESH_MS) {
          lastCommitCountRefresh = Date.now();
          cachedCommitCount = await getWorktreeCommitCount(worktreePath, projectDir);
        }
        const state = runner.getState();
        const runningJob = state.jobs.find((j) => j.status === "running");
        const queuedJobs = state.jobs.filter((j) => j.status === "queued");

        // Read Oracle health metrics if projectDir is available
        let oracleHealth: {
          accuracyPercent: number;
          lastReflectionTimestamp: string | null;
          circuitBreakerTripped: boolean;
          totalDecisions: number;
        } | null = null;
        if (projectDir) {
          try {
            const memConfig = defaultMemoryConfig(projectDir);
            const metrics = readMetrics(memConfig);
            if (metrics.totalDecisions > 0 || metrics.lastReflectionTimestamp) {
              oracleHealth = {
                accuracyPercent: metrics.accuracyPercent,
                lastReflectionTimestamp: metrics.lastReflectionTimestamp,
                circuitBreakerTripped: metrics.circuitBreakerTripped,
                totalDecisions: metrics.totalDecisions,
              };
            }
          } catch {
            // Oracle metrics unavailable — non-fatal
          }
        }

        // Build pipeline progress for running jobs
        let pipelineProgress: PipelineProgress | null = null;
        if (runningJob && instDir) {
          try {
            const jobDir = join(instDir, "jobs", runningJob.id);
            const pipelineState = readPipelineState(jobDir);
            if (pipelineState) {
              const currentSkill = pipelineState.skills[pipelineState.currentSkillIndex];
              pipelineProgress = {
                currentSkill: currentSkill?.skillName ?? "unknown",
                skillIndex: pipelineState.currentSkillIndex,
                totalSkills: pipelineState.skills.length,
                claimedTodoTitle: runningJob.claimedTodoTitle ?? null,
                elapsedSeconds: runningJob.startedAt
                  ? Math.floor((Date.now() - new Date(runningJob.startedAt).getTime()) / 1000)
                  : 0,
                commitCount: cachedCommitCount,
              };
            }
          } catch {
            // Non-fatal: pipeline progress is optional
          }
        }

        return {
          ok: true,
          data: {
            running: runner.isRunning(),
            currentJob: runningJob ?? null,
            queuedCount: queuedJobs.length,
            dailyCost: state.dailyCost,
            uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
            totalJobs: state.jobs.length,
            oracleHealth,
            pipelineProgress,
          },
        };
      }

      case "trigger": {
        const skills = request.skills;
        if (!Array.isArray(skills) || skills.length === 0) {
          return { ok: false, error: "skills must be a non-empty array" };
        }
        const jobId = runner.enqueue(skills, "manual", "CLI trigger", request.designDoc);
        if (jobId && request.todoTitle) {
          // Deterministic override: set claimed title + skip composition
          const state = runner.getState();
          const job = state.jobs.find(j => j.id === jobId);
          if (job) {
            job.claimedTodoTitle = request.todoTitle;
            job.skipComposition = true;
          }
        }
        if (jobId) {
          return { ok: true, data: { jobId } };
        }
        return { ok: false, error: "Job rejected (budget limit or duplicate)" };
      }

      case "queue": {
        const state = runner.getState();
        return {
          ok: true,
          data: {
            jobs: state.jobs.map((j) => ({
              id: j.id,
              skills: j.skills,
              status: j.status,
              triggeredBy: j.triggeredBy,
              enqueuedAt: j.enqueuedAt,
              costUsd: j.costUsd,
            })),
          },
        };
      }

      case "instances": {
        if (!parentCheckpointDir) {
          return { ok: false, error: "Instance listing not available (no parent checkpoint dir)" };
        }
        const instances = listInstances(parentCheckpointDir);
        return { ok: true, data: { instances } };
      }

      default:
        return { ok: false, error: `Unknown request type` };
    }
  };
}

/**
 * Start the daemon process. This is the main entry point when the daemon
 * is spawned as a detached child process.
 *
 * @param checkpointDir - Parent .garyclaw/ directory
 * @param instanceName - Instance name (default: "default")
 */
export async function startDaemon(checkpointDir: string, instanceName?: string): Promise<void> {
  const name = resolveInstanceName(instanceName);

  // Migrate flat layout to instance dirs on first start
  migrateToInstanceDir(checkpointDir);

  // Ensure .garyclaw/ is in .gitignore (daemon state should never be committed)
  const projectDir = join(checkpointDir, "..");
  const gitignorePath = join(projectDir, ".gitignore");
  try {
    const gitignoreContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
    if (!gitignoreContent.includes(".garyclaw")) {
      const entry = gitignoreContent.endsWith("\n") || gitignoreContent === ""
        ? ".garyclaw/\n"
        : "\n.garyclaw/\n";
      appendFileSync(gitignorePath, entry, "utf-8");
    }
  } catch { /* non-fatal — gitignore update is best-effort */ }

  // Instance-specific directory for all daemon files
  const instDir = ensureInstanceDir(checkpointDir, name);

  const log = createDaemonLogger(instDir, "info");
  log("info", `Daemon [${name}] starting...`);

  // 1. Load config (instance dir → parent dir fallback)
  const configOrNull = loadDaemonConfig(instDir, checkpointDir);
  if (!configOrNull) {
    log("error", `Invalid or missing config at ${join(instDir, CONFIG_FILE)} or ${join(checkpointDir, CONFIG_FILE)}`);
    process.exit(1);
  }
  let config = configOrNull; // Narrow: process.exit above guarantees non-null. Mutable for SIGHUP reload.

  // Update logger with config level
  const configLog = createDaemonLogger(instDir, config.logging.level);

  // 1a. Auto-cleanup stale state (dead PIDs, orphaned worktrees, stuck locks, dead budget entries)
  try {
    const { cleaned } = await runAutoCleanup({
      projectDir: config.projectDir,
      dailyCostLimitUsd: config.budget.dailyCostLimitUsd,
      maxJobsPerDay: config.budget.maxJobsPerDay,
    });
    if (cleaned.length > 0) {
      configLog("info", `Auto-cleanup: ${cleaned.join(", ")}`);
    }
  } catch (err) {
    configLog("warn", `Auto-cleanup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Check for stale PID
  const existingPid = readPidFile(instDir);
  if (existingPid !== null) {
    if (isPidAlive(existingPid)) {
      configLog("error", `Daemon [${name}] already running (PID ${existingPid})`);
      process.exit(1);
    }
    configLog("warn", `Cleaning up stale PID file (PID ${existingPid} not alive)`);
    cleanupDaemonFiles(instDir);
  }

  // 3. Write PID file
  writePidFile(instDir, process.pid);
  configLog("info", `PID ${process.pid} written to ${join(instDir, PID_FILE)}`);

  // 3a. Create git worktree for named instances (not "default")
  let baseBranch: string | undefined;
  if (name !== "default") {
    try {
      baseBranch = resolveBaseBranch(config.projectDir);
      const wtInfo = createWorktree(config.projectDir, name, baseBranch);
      config.worktreePath = wtInfo.path;
      configLog("info", `Worktree created at ${wtInfo.path} on branch ${wtInfo.branch}`);
    } catch (err) {
      configLog("error", `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // 4. Create job runner (with global budget + cross-instance dedup via parentCheckpointDir)
  const runner = createJobRunner(config, instDir, { log: configLog }, name, checkpointDir);
  configLog("info", `Job runner created for instance [${name}]`);

  // 5. Start IPC server
  const socketPath = join(instDir, SOCKET_FILE);
  // Clean up stale socket
  try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* ignore */ }

  const startTime = Date.now();
  const handler = buildIPCHandler(runner, startTime, config.projectDir, checkpointDir, instDir, config.worktreePath);
  const server = createIPCServer(socketPath, handler);
  configLog("info", `IPC server listening on ${socketPath}`);

  // 6. Start pollers (git poll + cron)
  let pollers = startPollers(config, runner, configLog);

  // 7. Main loop: process next job every 5s
  const processTimer = setInterval(async () => {
    try {
      await runner.processNext();
    } catch (err) {
      configLog("error", `processNext error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, PROCESS_INTERVAL_MS);

  // 8. SIGHUP handler for config reload
  process.on("SIGHUP", () => {
    configLog("info", "Received SIGHUP — reloading config...");
    const newConfig = loadDaemonConfig(instDir, checkpointDir);
    if (!newConfig) {
      configLog("warn", "SIGHUP reload failed: invalid config, keeping old config");
      return;
    }
    const configError = validateDaemonConfig(newConfig);
    if (configError) {
      configLog("warn", `SIGHUP reload failed: ${configError}, keeping old config`);
      return;
    }

    // Update config reference so shutdown handler, IPC handler, etc. see new values
    config = newConfig;

    // Update budget for future enqueue checks
    runner.updateBudget(newConfig.budget);
    configLog("info", "Budget updated from reloaded config");

    // Restart pollers with new trigger configs
    for (const poller of pollers) {
      poller.stop();
    }
    pollers = startPollers(newConfig, runner, configLog);
    configLog("info", `SIGHUP reload complete: ${pollers.length} poller(s) restarted`);
  });

  // 9. Signal handlers for graceful shutdown
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    configLog("info", `Received ${signal} — shutting down gracefully`);

    // Stop accepting new jobs
    clearInterval(processTimer);

    // Stop pollers
    for (const poller of pollers) {
      poller.stop();
    }

    // Wait for current job to finish (with timeout)
    const waitStart = Date.now();
    const MAX_WAIT_MS = 60_000;
    while (runner.isRunning() && Date.now() - waitStart < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (runner.isRunning()) {
      configLog("warn", "Shutdown timeout — current job may be interrupted");
    }

    // Close IPC server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Attempt to merge worktree branch for named instances
    if (name !== "default" && baseBranch) {
      try {
        const mergeResult = mergeWorktreeBranch(config.projectDir, name, baseBranch, {
          onWarn: (msg) => configLog("warn", msg),
        });
        if (mergeResult.merged) {
          if (mergeResult.commitCount && mergeResult.commitCount > 0) {
            configLog("info", `Merged ${mergeResult.commitCount} commit(s) from garyclaw/${name} to ${baseBranch}`);
          } else {
            configLog("info", `Branch garyclaw/${name} already up to date with ${baseBranch}`);
          }
        } else {
          configLog("warn", `Branch garyclaw/${name} needs manual merge: ${mergeResult.reason}`);
        }
      } catch (err) {
        configLog("warn", `Failed to merge worktree branch: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Clean up files
    cleanupDaemonFiles(instDir);
    configLog("info", `Daemon [${name}] stopped`);
    process.exit(0);
  }

  const handleSignal = (sig: string) => {
    shutdown(sig).catch((e) => { console.error("Shutdown error:", e); process.exit(1); });
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));

  configLog("info", "Daemon ready");
}

/**
 * Start all pollers from a config. Returns the array of started pollers.
 * Extracted as a helper so SIGHUP reload can restart pollers.
 */
export function startPollers(
  config: DaemonConfig,
  runner: JobRunner,
  log: (level: string, msg: string) => void,
): GitPoller[] {
  const pollers: GitPoller[] = [];
  for (const trigger of config.triggers) {
    if (trigger.type === "git_poll") {
      const poller = createGitPoller(trigger, config.projectDir, (skills, detail) => {
        log("info", `Git poll triggered: ${detail}`);
        runner.enqueue(skills, "git_poll", detail);
      }, { log });
      poller.start();
      pollers.push(poller);
      log("info", `Git poller started: every ${trigger.intervalSeconds}s, skills=[${trigger.skills.join(",")}]`);
    } else if (trigger.type === "cron") {
      const poller = createCronPoller(trigger, (skills, detail) => {
        log("info", `Cron triggered: ${detail}`);
        runner.enqueue(skills, "cron", detail, trigger.designDoc);
      });
      if (poller) {
        poller.start();
        pollers.push(poller);
        log("info", `Cron poller started: "${trigger.expression}", skills=[${trigger.skills.join(",")}]`);
      } else {
        log("warn", `Invalid cron expression "${trigger.expression}", skipping trigger`);
      }
    }
  }
  return pollers;
}

// If this file is executed directly (as a forked process), start the daemon.
// Args: --start <checkpointDir> [--instance <name>]
const args = process.argv.slice(2);
if (args[0] === "--start" && args[1]) {
  const checkpointDirArg = args[1];
  let instanceNameArg: string | undefined;
  if (args[2] === "--instance" && args[3]) {
    instanceNameArg = args[3];
  }
  startDaemon(checkpointDirArg, instanceNameArg).catch((err) => {
    console.error("Daemon fatal error:", err);
    process.exit(1);
  });
}
