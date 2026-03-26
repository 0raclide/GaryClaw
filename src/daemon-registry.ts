/**
 * Daemon Registry — central coordination for multi-instance daemons.
 *
 * Manages instance discovery, global budget tracking across all instances,
 * and cross-instance dedup to prevent duplicate jobs.
 *
 * Directory layout:
 *   .garyclaw/daemons/{name}/daemon.pid
 *   .garyclaw/daemons/{name}/daemon.sock
 *   .garyclaw/daemons/{name}/daemon.log
 *   .garyclaw/daemons/{name}/daemon-state.json
 *   .garyclaw/global-budget.json
 */

import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { safeReadJSON, safeWriteJSON } from "./safe-json.js";
import type { GlobalBudget, InstanceInfo, DaemonState } from "./types.js";

const DAEMONS_DIR = "daemons";
const GLOBAL_BUDGET_FILE = "global-budget.json";
const PID_FILE = "daemon.pid";
const SOCKET_FILE = "daemon.sock";
const STATE_FILE = "daemon-state.json";

// ── Instance directory helpers ───────────────────────────────────

/**
 * Resolve an instance name. Undefined or empty → "default".
 */
export function resolveInstanceName(name?: string): string {
  return name && name.trim().length > 0 ? name.trim() : "default";
}

/**
 * Get the directory path for a named daemon instance.
 */
export function instanceDir(checkpointDir: string, name: string): string {
  return join(checkpointDir, DAEMONS_DIR, resolveInstanceName(name));
}

/**
 * Ensure the instance directory exists.
 */
export function ensureInstanceDir(checkpointDir: string, name: string): string {
  const dir = instanceDir(checkpointDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Instance discovery ───────────────────────────────────────────

/**
 * List all daemon instances under .garyclaw/daemons/.
 * Returns info for each, including whether the PID is alive.
 */
export function listInstances(checkpointDir: string): InstanceInfo[] {
  const daemonsPath = join(checkpointDir, DAEMONS_DIR);
  if (!existsSync(daemonsPath)) return [];

  const instances: InstanceInfo[] = [];

  let entries: string[];
  try {
    entries = readdirSync(daemonsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const name of entries) {
    const dir = join(daemonsPath, name);
    const pidPath = join(dir, PID_FILE);

    if (!existsSync(pidPath)) continue;

    let pid: number;
    try {
      pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (!Number.isFinite(pid)) continue;
    } catch {
      continue;
    }

    const alive = isPidAlive(pid);

    instances.push({
      name,
      pid,
      alive,
      socketPath: join(dir, SOCKET_FILE),
      instanceDir: dir,
    });
  }

  return instances;
}

// ── Global budget ────────────────────────────────────────────────

function validateGlobalBudget(data: unknown): data is GlobalBudget {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.date === "string" &&
    typeof d.totalUsd === "number" &&
    typeof d.jobCount === "number" &&
    typeof d.byInstance === "object" &&
    d.byInstance !== null
  );
}

/**
 * Read the shared global budget file. Returns a fresh budget for today
 * if the file doesn't exist or the date has rolled over.
 */
export function readGlobalBudget(checkpointDir: string): GlobalBudget {
  const filePath = join(checkpointDir, GLOBAL_BUDGET_FILE);
  const budget = safeReadJSON<GlobalBudget>(filePath, validateGlobalBudget);
  const today = new Date().toISOString().slice(0, 10);

  if (!budget || budget.date !== today) {
    return { date: today, totalUsd: 0, jobCount: 0, byInstance: {} };
  }

  return budget;
}

/**
 * Add cost to the global budget and persist it.
 * Creates the file if it doesn't exist. Resets on date rollover.
 */
export function updateGlobalBudget(
  checkpointDir: string,
  addCostUsd: number,
  instanceName: string,
): GlobalBudget {
  const budget = readGlobalBudget(checkpointDir);

  budget.totalUsd += addCostUsd;
  budget.jobCount += 1;

  // Per-instance tracking
  const resolved = resolveInstanceName(instanceName);
  if (!budget.byInstance[resolved]) {
    budget.byInstance[resolved] = { totalUsd: 0, jobCount: 0 };
  }
  budget.byInstance[resolved].totalUsd += addCostUsd;
  budget.byInstance[resolved].jobCount += 1;

  const filePath = join(checkpointDir, GLOBAL_BUDGET_FILE);
  safeWriteJSON(filePath, budget);

  return budget;
}

// ── Cross-instance dedup ─────────────────────────────────────────

/**
 * Check if a set of skills is already queued or running in ANY daemon instance.
 * Scans all instance daemon-state.json files.
 */
export function isSkillSetActive(
  checkpointDir: string,
  skills: string[],
  excludeInstance?: string,
): boolean {
  const daemonsPath = join(checkpointDir, DAEMONS_DIR);
  if (!existsSync(daemonsPath)) return false;

  const skillKey = skills.join(",");

  let entries: string[];
  try {
    entries = readdirSync(daemonsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return false;
  }

  for (const name of entries) {
    // Optionally skip the calling instance (local dedup handles it)
    if (excludeInstance && name === excludeInstance) continue;

    const statePath = join(daemonsPath, name, STATE_FILE);
    const state = safeReadJSON<DaemonState>(statePath, validateDaemonState);
    if (!state) continue;

    for (const job of state.jobs) {
      if (job.status !== "queued" && job.status !== "running") continue;

      const jobKey = job.designDoc
        ? `${job.skills.join(",")};${job.designDoc}`
        : job.skills.join(",");

      if (jobKey === skillKey) return true;
    }
  }

  return false;
}

// ── Migration helper ─────────────────────────────────────────────

/**
 * Migrate flat daemon files from .garyclaw/ to .garyclaw/daemons/default/.
 * Called on first start to ensure backward compatibility.
 *
 * Only migrates if old files exist AND new default instance dir does not.
 */
export function migrateToInstanceDir(checkpointDir: string): boolean {
  const oldPid = join(checkpointDir, PID_FILE);
  const defaultDir = instanceDir(checkpointDir, "default");

  // Already migrated or no old files
  if (existsSync(join(defaultDir, PID_FILE)) || !existsSync(oldPid)) {
    return false;
  }

  mkdirSync(defaultDir, { recursive: true });

  const filesToMigrate = [PID_FILE, SOCKET_FILE, "daemon.log", STATE_FILE];
  let migrated = false;

  for (const file of filesToMigrate) {
    const oldPath = join(checkpointDir, file);
    const newPath = join(defaultDir, file);
    if (existsSync(oldPath)) {
      try {
        const content = readFileSync(oldPath, "utf-8");
        writeFileSync(newPath, content, "utf-8");
        // Don't delete old files — let the daemon clean them up on next start
        migrated = true;
      } catch {
        // Non-fatal — migration is best-effort
      }
    }
  }

  return migrated;
}

// ── Internal helpers ─────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function validateDaemonState(data: unknown): data is DaemonState {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.version === 1 && Array.isArray(d.jobs);
}
