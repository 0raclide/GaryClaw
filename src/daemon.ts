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

import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createIPCServer, type IPCHandler } from "./daemon-ipc.js";
import { createJobRunner, type JobRunner } from "./job-runner.js";
import { createGitPoller, type GitPoller } from "./triggers.js";
import type { DaemonConfig, IPCRequest, IPCResponse, DaemonState } from "./types.js";
import type { Server } from "node:net";

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
    if (t.type !== "git_poll") return `triggers[${i}].type must be "git_poll"`;
    if (typeof t.intervalSeconds !== "number" || t.intervalSeconds <= 0) {
      return `triggers[${i}].intervalSeconds must be a positive number`;
    }
    if (!Array.isArray(t.skills) || t.skills.length === 0) {
      return `triggers[${i}].skills must be a non-empty array`;
    }
  }

  return null;
}

/**
 * Load daemon config from the checkpoint directory.
 */
export function loadDaemonConfig(checkpointDir: string): DaemonConfig | null {
  const configPath = join(checkpointDir, CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  try {
    const data = JSON.parse(readFileSync(configPath, "utf-8"));
    const error = validateDaemonConfig(data);
    if (error) return null;
    return data as DaemonConfig;
  } catch {
    return null;
  }
}

/**
 * Check if a PID file points to an alive process.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read PID from file. Returns null if file doesn't exist or is invalid.
 */
export function readPidFile(checkpointDir: string): number | null {
  const pidPath = join(checkpointDir, PID_FILE);
  if (!existsSync(pidPath)) return null;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Write PID file.
 */
export function writePidFile(checkpointDir: string, pid: number): void {
  mkdirSync(checkpointDir, { recursive: true });
  writeFileSync(join(checkpointDir, PID_FILE), String(pid), "utf-8");
}

/**
 * Clean up PID and socket files.
 */
export function cleanupDaemonFiles(checkpointDir: string): void {
  const pidPath = join(checkpointDir, PID_FILE);
  const sockPath = join(checkpointDir, SOCKET_FILE);
  try { if (existsSync(pidPath)) unlinkSync(pidPath); } catch { /* ignore */ }
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

  return (msgLevel: string, message: string) => {
    if ((levels[msgLevel] ?? 1) < threshold) return;
    const line = `[${new Date().toISOString()}] [${msgLevel.toUpperCase()}] ${message}\n`;
    try {
      appendFileSync(logPath, line, "utf-8");
    } catch {
      // Can't write to log — silently ignore
    }
  };
}

/**
 * Build the IPC request handler for the daemon.
 */
export function buildIPCHandler(
  runner: JobRunner,
  startTime: number,
): IPCHandler {
  return async (request: IPCRequest): Promise<IPCResponse> => {
    switch (request.type) {
      case "status": {
        const state = runner.getState();
        const runningJob = state.jobs.find((j) => j.status === "running");
        const queuedJobs = state.jobs.filter((j) => j.status === "queued");
        return {
          ok: true,
          data: {
            running: runner.isRunning(),
            currentJob: runningJob ?? null,
            queuedCount: queuedJobs.length,
            dailyCost: state.dailyCost,
            uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
            totalJobs: state.jobs.length,
          },
        };
      }

      case "trigger": {
        const skills = request.skills;
        if (!Array.isArray(skills) || skills.length === 0) {
          return { ok: false, error: "skills must be a non-empty array" };
        }
        const jobId = runner.enqueue(skills, "manual", "CLI trigger");
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

      default:
        return { ok: false, error: `Unknown request type` };
    }
  };
}

/**
 * Start the daemon process. This is the main entry point when the daemon
 * is spawned as a detached child process.
 */
export async function startDaemon(checkpointDir: string): Promise<void> {
  const log = createDaemonLogger(checkpointDir, "info");
  log("info", "Daemon starting...");

  // 1. Load config
  const config = loadDaemonConfig(checkpointDir);
  if (!config) {
    log("error", `Invalid or missing config at ${join(checkpointDir, CONFIG_FILE)}`);
    process.exit(1);
  }

  // Update logger with config level
  const configLog = createDaemonLogger(checkpointDir, config.logging.level);

  // 2. Check for stale PID
  const existingPid = readPidFile(checkpointDir);
  if (existingPid !== null) {
    if (isPidAlive(existingPid)) {
      configLog("error", `Daemon already running (PID ${existingPid})`);
      process.exit(1);
    }
    configLog("warn", `Cleaning up stale PID file (PID ${existingPid} not alive)`);
    cleanupDaemonFiles(checkpointDir);
  }

  // 3. Write PID file
  writePidFile(checkpointDir, process.pid);
  configLog("info", `PID ${process.pid} written to ${join(checkpointDir, PID_FILE)}`);

  // 4. Create job runner
  const runner = createJobRunner(config, checkpointDir, { log: configLog });
  configLog("info", "Job runner created");

  // 5. Start IPC server
  const socketPath = join(checkpointDir, SOCKET_FILE);
  // Clean up stale socket
  try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* ignore */ }

  const startTime = Date.now();
  const handler = buildIPCHandler(runner, startTime);
  const server = createIPCServer(socketPath, handler);
  configLog("info", `IPC server listening on ${socketPath}`);

  // 6. Start git pollers
  const pollers: GitPoller[] = [];
  for (const trigger of config.triggers) {
    if (trigger.type === "git_poll") {
      const poller = createGitPoller(trigger, config.projectDir, (skills, detail) => {
        configLog("info", `Git poll triggered: ${detail}`);
        runner.enqueue(skills, "git_poll", detail);
      });
      poller.start();
      pollers.push(poller);
      configLog("info", `Git poller started: every ${trigger.intervalSeconds}s, skills=[${trigger.skills.join(",")}]`);
    }
  }

  // 7. Main loop: process next job every 5s
  const processTimer = setInterval(async () => {
    try {
      await runner.processNext();
    } catch (err) {
      configLog("error", `processNext error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, PROCESS_INTERVAL_MS);

  // 8. Signal handlers for graceful shutdown
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

    // Clean up files
    cleanupDaemonFiles(checkpointDir);
    configLog("info", "Daemon stopped");
    process.exit(0);
  }

  process.on("SIGTERM", () => { shutdown("SIGTERM").catch((e) => { console.error("Shutdown error:", e); process.exit(1); }); });
  process.on("SIGINT", () => { shutdown("SIGINT").catch((e) => { console.error("Shutdown error:", e); process.exit(1); }); });

  configLog("info", "Daemon ready");
}

// If this file is executed directly (as a forked process), start the daemon.
// The checkpoint directory is passed as the first CLI argument.
const args = process.argv.slice(2);
if (args[0] === "--start" && args[1]) {
  startDaemon(args[1]).catch((err) => {
    console.error("Daemon fatal error:", err);
    process.exit(1);
  });
}
