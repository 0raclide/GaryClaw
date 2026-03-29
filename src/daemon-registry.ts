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

import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { safeReadJSON, safeWriteJSON } from "./safe-json.js";
import { readPidFile as readPidFileDirect, isPidAlive as isPidAliveDirect } from "./pid-utils.js";
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
const VALID_INSTANCE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function resolveInstanceName(name?: string): string {
  const resolved = name && name.trim().length > 0 ? name.trim() : "default";
  if (!VALID_INSTANCE_NAME.test(resolved)) {
    throw new Error(
      `Invalid instance name "${resolved}". Names must be alphanumeric with hyphens/underscores, no path separators.`,
    );
  }
  return resolved;
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

    const pid = readPidFileDirect(pidPath);
    if (pid === null) continue;

    const alive = isPidAliveDirect(pid).alive;

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

export function validateGlobalBudget(data: unknown): data is GlobalBudget {
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
 *
 * Dedup key is order-sensitive: ["qa","ship"] ≠ ["ship","qa"]. This is intentional —
 * skill order matters in pipelines (context flows left→right). A job with a designDoc
 * also won't match a plain skill set because the designDoc changes execution behavior.
 */
export function isSkillSetActive(
  checkpointDir: string,
  skills: string[],
  excludeInstance?: string,
  designDoc?: string,
): boolean {
  const daemonsPath = join(checkpointDir, DAEMONS_DIR);
  if (!existsSync(daemonsPath)) return false;

  const skillKey = designDoc ? `${skills.join(",")};${designDoc}` : skills.join(",");

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

// ── Priority claiming ────────────────────────────────────────────

export interface ClaimedTodoItem {
  title: string;
  instanceName: string;
}

/**
 * Scan all daemon instances for TODO items claimed by running/queued jobs.
 * Returns titles of items currently being worked on by other instances.
 *
 * Used by prioritize to avoid picking the same item as a parallel instance.
 */
export function getClaimedTodoTitles(
  checkpointDir: string,
  excludeInstance?: string,
): ClaimedTodoItem[] {
  const daemonsPath = join(checkpointDir, DAEMONS_DIR);
  if (!existsSync(daemonsPath)) return [];

  let entries: string[];
  try {
    entries = readdirSync(daemonsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const claimed: ClaimedTodoItem[] = [];

  for (const name of entries) {
    if (excludeInstance && name === excludeInstance) continue;

    const statePath = join(daemonsPath, name, STATE_FILE);
    const state = safeReadJSON<DaemonState>(statePath, validateDaemonState);
    if (!state) continue;

    for (const job of state.jobs) {
      if (job.status !== "queued" && job.status !== "running") continue;
      if (!job.claimedTodoTitle) continue;

      claimed.push({
        title: job.claimedTodoTitle,
        instanceName: name,
      });
    }
  }

  return claimed;
}

// ── File-level conflict prevention ────────────────────────────────

/**
 * Scan all daemon instances for files claimed by running/queued jobs.
 * Returns a Map from instance name to claimed file arrays.
 *
 * Used by job-runner pre-assignment to detect file-level conflicts
 * between parallel instances working on different TODO items.
 */
export function getClaimedFiles(
  checkpointDir: string,
  excludeInstance?: string,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const daemonsPath = join(checkpointDir, DAEMONS_DIR);
  if (!existsSync(daemonsPath)) return result;

  let entries: string[];
  try {
    entries = readdirSync(daemonsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return result;
  }

  for (const name of entries) {
    if (excludeInstance && name === excludeInstance) continue;

    const statePath = join(daemonsPath, name, STATE_FILE);
    const state = safeReadJSON<DaemonState>(statePath, validateDaemonState);
    if (!state) continue;

    const instanceFiles = new Set<string>();
    for (const job of state.jobs) {
      if (job.status !== "queued" && job.status !== "running") continue;
      if (!job.claimedFiles || job.claimedFiles.length === 0) continue;
      for (const f of job.claimedFiles) instanceFiles.add(f);
    }

    if (instanceFiles.size > 0) {
      result.set(name, [...instanceFiles]);
    }
  }

  return result;
}

// ── Cross-cycle dedup ─────────────────────────────────────────────

/**
 * Scan all daemon instances for TODO titles that were completed by past jobs.
 * Used by job-runner pre-assignment to avoid rebuilding features that were
 * already implemented (even if the auto-merge failed).
 *
 * Returns a Set of completed claimedTodoTitle values across all instances.
 */
export function getCompletedTodoTitles(
  checkpointDir: string,
  excludeInstance?: string,
): Set<string> {
  const titles = new Set<string>();
  const daemonsPath = join(checkpointDir, DAEMONS_DIR);
  if (!existsSync(daemonsPath)) return titles;

  let entries: string[];
  try {
    entries = readdirSync(daemonsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return titles;
  }

  for (const name of entries) {
    if (excludeInstance && name === excludeInstance) continue;

    const statePath = join(daemonsPath, name, STATE_FILE);
    const state = safeReadJSON<DaemonState>(statePath, validateDaemonState);
    if (!state?.jobs) continue;

    for (const job of state.jobs) {
      if (job.status === "complete" && job.claimedTodoTitle) {
        titles.add(job.claimedTodoTitle);
      }
    }
  }

  // Also scan todo-state/ for merged/complete items (survives instance cleanup)
  const todoStateDir = join(checkpointDir, "todo-state");
  if (existsSync(todoStateDir)) {
    try {
      const stateFiles = readdirSync(todoStateDir).filter(f => f.endsWith(".json"));
      for (const file of stateFiles) {
        const todoState = safeReadJSON<{ title?: string; state?: string }>(
          join(todoStateDir, file),
        );
        if (todoState?.title && (todoState.state === "merged" || todoState.state === "complete")) {
          titles.add(todoState.title);
        }
      }
    } catch {
      // Fail-open: if todo-state scan fails, we still have job-based titles
    }
  }

  return titles;
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
        // Clean up old file after successful copy to avoid orphaned duplicates
        try { unlinkSync(oldPath); } catch { /* best-effort cleanup */ }
        migrated = true;
      } catch {
        // Non-fatal — migration is best-effort
      }
    }
  }

  return migrated;
}

// ── Internal helpers ─────────────────────────────────────────────

function validateDaemonState(data: unknown): data is DaemonState {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.version === 1 && Array.isArray(d.jobs);
}
