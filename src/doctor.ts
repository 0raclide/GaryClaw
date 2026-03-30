/**
 * Doctor — self-diagnostic command for GaryClaw.
 *
 * Runs 8 subsystem checks: stale PIDs, oracle memory integrity, orphaned worktrees,
 * stuck reflection locks, global budget status, orphaned TODO state, stale budget locks,
 * and auth verification.
 *
 * Default mode is diagnose-only (no side effects). Pass --fix to auto-heal
 * fixable issues. Pass --json for machine-readable output.
 */

import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readPidFile, isPidAlive, removePidFile } from "./pid-utils.js";
import { safeReadJSON, safeWriteJSON } from "./safe-json.js";
import { listWorktrees, removeWorktree, branchName, resolveBaseBranch } from "./worktree.js";
import { validateGlobalBudget } from "./daemon-registry.js";
import { BUDGET_LOCK_DIR_NAME } from "./budget-lock.js";
import { REFLECTION_LOCK_DIR_NAME } from "./reflection-lock.js";
import { execFileSync } from "node:child_process";
import type { GlobalBudget, OracleMetrics } from "./types.js";

// ── Types ────────────────────────────────────────────────────────

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "INFO";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  details?: string[];
  fixable: boolean;
  fixed?: boolean;
}

export interface DoctorReport {
  checks: CheckResult[];
  timestamp: string;
  durationMs: number;
  summary: {
    pass: number;
    warn: number;
    fail: number;
    info: number;
  };
}

export interface DoctorOptions {
  projectDir: string;
  fix: boolean;
  skipAuth: boolean;
  timeoutMs?: number;
  dailyCostLimitUsd?: number;
  maxJobsPerDay?: number;
}

// ── Constants ────────────────────────────────────────────────────

const DAEMONS_DIR = "daemons";
const PID_FILE = "daemon.pid";
const SOCKET_FILE = "daemon.sock";
const GLOBAL_BUDGET_FILE = "global-budget.json";
const METRICS_FILE = "metrics.json";
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_DAILY_COST_LIMIT = 50;
const DEFAULT_MAX_JOBS_PER_DAY = 20;

// ── Main orchestrator ────────────────────────────────────────────

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const startTime = Date.now();
  const checks: CheckResult[] = [];

  // Run non-auth checks synchronously (fast)
  checks.push(checkStalePids(options));
  checks.push(checkOracleMemory(options));
  checks.push(checkOrphanedWorktrees(options));
  checks.push(checkReflectionLocks(options));
  checks.push(checkBudgetStatus(options));
  checks.push(checkOrphanedTodoState(options));
  checks.push(checkStaleBudgetLocks(options));

  // Auth check: async, with timeout
  if (!options.skipAuth) {
    checks.push(await checkAuth(options));
  }

  const durationMs = Date.now() - startTime;

  return {
    checks,
    timestamp: new Date().toISOString(),
    durationMs,
    summary: {
      pass: checks.filter((c) => c.status === "PASS").length,
      warn: checks.filter((c) => c.status === "WARN").length,
      fail: checks.filter((c) => c.status === "FAIL").length,
      info: checks.filter((c) => c.status === "INFO").length,
    },
  };
}

// ── Check 1: Stale PID Files ────────────────────────────────────

export function checkStalePids(options: DoctorOptions): CheckResult {
  const checkpointDir = join(options.projectDir, ".garyclaw");
  const daemonsPath = join(checkpointDir, DAEMONS_DIR);
  const details: string[] = [];
  let hasIssue = false;
  let fixedCount = 0;

  if (!existsSync(daemonsPath)) {
    return {
      name: "stale-pids",
      status: "PASS",
      message: "No daemon instances found",
      fixable: false,
    };
  }

  let entries: string[];
  try {
    entries = readdirSync(daemonsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return {
      name: "stale-pids",
      status: "PASS",
      message: "No daemon instances found",
      fixable: false,
    };
  }

  if (entries.length === 0) {
    return {
      name: "stale-pids",
      status: "PASS",
      message: "No daemon instances found",
      fixable: false,
    };
  }

  let aliveCount = 0;

  for (const name of entries) {
    const dir = join(daemonsPath, name);
    const pidPath = join(dir, PID_FILE);

    if (!existsSync(pidPath)) continue;

    const pid = readPidFile(pidPath);
    if (pid === null) {
      hasIssue = true;
      details.push(`Instance [${name}]: unreadable PID file`);
      if (options.fix) {
        removePidFile(pidPath);
        const sockPath = join(dir, SOCKET_FILE);
        try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* ignore */ }
        fixedCount++;
        details.push(`  Fixed: removed PID + socket files`);
      }
      continue;
    }

    const result = isPidAlive(pid, "node");
    if (result.stale) {
      hasIssue = true;
      if (result.alive && !result.nameMatch) {
        details.push(
          `Instance [${name}]: PID ${pid} is ${result.processName ?? "unknown"}, not node — likely reused`,
        );
      } else {
        details.push(`Instance [${name}]: stale PID ${pid} (process not alive)`);
      }

      if (options.fix) {
        removePidFile(pidPath);
        const sockPath = join(dir, SOCKET_FILE);
        try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* ignore */ }
        fixedCount++;
        details.push(`  Fixed: removed PID + socket files`);
      }
    } else {
      aliveCount++;
    }
  }

  if (!hasIssue) {
    const msg = aliveCount > 0
      ? `${aliveCount} daemon instance(s) running, all healthy`
      : "No stale PID files found";
    return { name: "stale-pids", status: "PASS", message: msg, fixable: false };
  }

  return {
    name: "stale-pids",
    status: "WARN",
    message: options.fix
      ? `Fixed ${fixedCount} stale PID file(s)`
      : `Found stale PID file(s)`,
    details,
    fixable: true,
    fixed: options.fix ? fixedCount > 0 : undefined,
  };
}

// ── Check 2: Oracle Memory Integrity ────────────────────────────

export function checkOracleMemory(options: DoctorOptions): CheckResult {
  const globalDir = join(homedir(), ".garyclaw", "oracle-memory");
  const projectDir = join(options.projectDir, ".garyclaw", "oracle-memory");
  const details: string[] = [];
  let hasIssue = false;
  let fixedCount = 0;

  const layers: { label: string; dir: string }[] = [
    { label: "global", dir: globalDir },
    { label: "project", dir: projectDir },
  ];

  for (const layer of layers) {
    if (!existsSync(layer.dir)) {
      details.push(`${layer.label}: directory not found (created on first use)`);
      continue;
    }

    // Check markdown files
    const mdFiles = ["taste.md", "domain-expertise.md"];
    if (layer.label === "project") {
      mdFiles.push("decision-outcomes.md");
    }

    for (const file of mdFiles) {
      const filePath = join(layer.dir, file);
      if (!existsSync(filePath)) continue; // INFO-level, not an error

      try {
        const content = readFileSync(filePath, "utf-8");
        if (content.trim().length === 0) {
          details.push(`${layer.label}/${file}: empty file`);
          // Empty files are fine — they get populated on use
        }

        // Check for injection patterns
        if (hasInjectionPatterns(content)) {
          hasIssue = true;
          details.push(`${layer.label}/${file}: potential prompt injection detected`);
          // Not auto-fixable — just warn
        }
      } catch {
        hasIssue = true;
        details.push(`${layer.label}/${file}: unreadable`);
      }
    }

    // Check metrics.json (project only)
    if (layer.label === "project") {
      const metricsPath = join(layer.dir, METRICS_FILE);
      if (existsSync(metricsPath)) {
        try {
          const raw = readFileSync(metricsPath, "utf-8");
          const parsed = JSON.parse(raw) as Record<string, unknown>;

          // Validate structure
          if (
            typeof parsed.totalDecisions !== "number" ||
            typeof parsed.accuracyPercent !== "number" ||
            !Array.isArray(parsed.confidenceTrend)
          ) {
            hasIssue = true;
            details.push(`${layer.label}/${METRICS_FILE}: invalid structure`);
            if (options.fix) {
              // Rename to .bak and write fresh
              try {
                renameSync(metricsPath, `${metricsPath}.bak`);
              } catch { /* ignore */ }
              safeWriteJSON(metricsPath, defaultMetrics());
              fixedCount++;
              details.push(`  Fixed: renamed to .bak, wrote fresh metrics`);
            }
          } else {
            // Check circuit breaker
            if (parsed.circuitBreakerTripped) {
              const accuracy = typeof parsed.accuracyPercent === "number"
                ? parsed.accuracyPercent
                : 0;
              details.push(
                `${layer.label}/${METRICS_FILE}: circuit breaker TRIPPED (accuracy: ${accuracy.toFixed(1)}%)`,
              );
              hasIssue = true;
            }
          }
        } catch {
          hasIssue = true;
          details.push(`${layer.label}/${METRICS_FILE}: corrupt JSON`);
          if (options.fix) {
            try {
              renameSync(metricsPath, `${metricsPath}.bak`);
            } catch { /* ignore */ }
            safeWriteJSON(metricsPath, defaultMetrics());
            fixedCount++;
            details.push(`  Fixed: renamed to .bak, wrote fresh metrics`);
          }
        }
      }
    }
  }

  if (!hasIssue && details.length === 0) {
    return {
      name: "oracle-memory",
      status: "PASS",
      message: "Oracle memory files healthy",
      fixable: false,
    };
  }

  if (!hasIssue) {
    return {
      name: "oracle-memory",
      status: "INFO",
      message: "Oracle memory directories not fully initialized",
      details,
      fixable: false,
    };
  }

  return {
    name: "oracle-memory",
    status: "WARN",
    message: options.fix
      ? `Fixed ${fixedCount} oracle memory issue(s)`
      : "Oracle memory issues detected",
    details,
    fixable: fixedCount > 0 || !options.fix,
    fixed: options.fix ? fixedCount > 0 : undefined,
  };
}

// ── Check 3: Orphaned Worktrees ─────────────────────────────────

export function checkOrphanedWorktrees(
  options: DoctorOptions,
  deps?: {
    listWorktrees: (repoDir: string) => { path: string; branch: string; head: string }[];
    removeWorktree: (repoDir: string, instanceName: string, deleteBranch: boolean) => void;
    worktreeHasUnmergedCommits: (repoDir: string, instanceName: string) => boolean;
  },
): CheckResult {
  const checkpointDir = join(options.projectDir, ".garyclaw");
  const details: string[] = [];
  let hasIssue = false;
  let fixedCount = 0;

  const _listWorktrees = deps?.listWorktrees ?? listWorktrees;
  const _removeWorktree = deps?.removeWorktree ?? removeWorktree;
  const _worktreeHasUnmergedCommits = deps?.worktreeHasUnmergedCommits ?? worktreeHasUnmergedCommits;

  let worktrees: { path: string; branch: string; head: string }[];
  try {
    worktrees = _listWorktrees(options.projectDir);
  } catch {
    return {
      name: "worktrees",
      status: "PASS",
      message: "No worktrees found (or not a git repo)",
      fixable: false,
    };
  }

  if (worktrees.length === 0) {
    return {
      name: "worktrees",
      status: "PASS",
      message: "No GaryClaw worktrees found",
      fixable: false,
    };
  }

  for (const wt of worktrees) {
    // Extract instance name from branch (garyclaw/{name} → {name})
    const instanceName = wt.branch.replace("garyclaw/", "");
    const pidPath = join(checkpointDir, DAEMONS_DIR, instanceName, PID_FILE);

    // Check if there's a running daemon for this worktree
    let daemonRunning = false;
    if (existsSync(pidPath)) {
      const pid = readPidFile(pidPath);
      if (pid !== null) {
        const result = isPidAlive(pid, "node");
        daemonRunning = result.alive && result.nameMatch;
      }
    }

    if (daemonRunning) continue; // Active daemon — not orphaned

    // Orphaned worktree — check for unmerged commits
    hasIssue = true;
    const hasUnmerged = _worktreeHasUnmergedCommits(options.projectDir, instanceName);

    if (hasUnmerged) {
      details.push(
        `Orphaned worktree [${instanceName}] with unmerged commits (branch: ${wt.branch})`,
      );
      details.push(`  Manual merge required: git merge ${wt.branch}`);
      // Not auto-fixable — user must merge
    } else {
      details.push(
        `Orphaned worktree [${instanceName}], safe to remove (branch: ${wt.branch})`,
      );
      if (options.fix) {
        try {
          _removeWorktree(options.projectDir, instanceName, true);
          fixedCount++;
          details.push(`  Fixed: removed worktree and branch`);
        } catch (err) {
          details.push(`  Fix failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  if (!hasIssue) {
    return {
      name: "worktrees",
      status: "PASS",
      message: `${worktrees.length} worktree(s) all have active daemons`,
      fixable: false,
    };
  }

  return {
    name: "worktrees",
    status: "WARN",
    message: options.fix
      ? `Fixed ${fixedCount} orphaned worktree(s)`
      : "Orphaned worktree(s) detected",
    details,
    fixable: true,
    fixed: options.fix ? fixedCount > 0 : undefined,
  };
}

// ── Check 4: Stuck Reflection Locks ─────────────────────────────

export function checkReflectionLocks(options: DoctorOptions): CheckResult {
  const globalDir = join(homedir(), ".garyclaw", "oracle-memory");
  const projectDir = join(options.projectDir, ".garyclaw", "oracle-memory");
  const details: string[] = [];
  let hasIssue = false;
  let fixedCount = 0;

  const dirs = [
    { label: "global", dir: globalDir },
    { label: "project", dir: projectDir },
  ];

  for (const { label, dir } of dirs) {
    const lockDir = join(dir, REFLECTION_LOCK_DIR_NAME);
    if (!existsSync(lockDir)) continue;

    const pidFile = join(lockDir, "pid");
    if (!existsSync(pidFile)) {
      // Lock dir exists but no PID file — stale
      hasIssue = true;
      details.push(`${label}: lock directory exists but no PID file`);
      if (options.fix) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
          fixedCount++;
          details.push(`  Fixed: removed stale lock directory`);
        } catch (err) {
          details.push(`  Fix failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      continue;
    }

    // Read PID from lock
    let pid: number | null = null;
    try {
      pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) pid = null;
    } catch {
      pid = null;
    }

    if (pid === null) {
      hasIssue = true;
      details.push(`${label}: lock PID file unreadable`);
      if (options.fix) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
          fixedCount++;
          details.push(`  Fixed: removed stale lock directory`);
        } catch (err) {
          details.push(`  Fix failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      continue;
    }

    // Check if holding process is alive (no name check — any alive holder is valid)
    const result = isPidAlive(pid);
    if (result.alive) {
      details.push(`${label}: lock held by active process (PID ${pid})`);
      // Not stale — active lock
    } else {
      hasIssue = true;
      details.push(`${label}: stuck reflection lock (holder PID ${pid} is dead)`);
      if (options.fix) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
          fixedCount++;
          details.push(`  Fixed: removed stuck lock directory`);
        } catch (err) {
          details.push(`  Fix failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  if (!hasIssue) {
    return {
      name: "reflection-locks",
      status: "PASS",
      message: "No stuck reflection locks",
      details: details.length > 0 ? details : undefined,
      fixable: false,
    };
  }

  return {
    name: "reflection-locks",
    status: "WARN",
    message: options.fix
      ? `Fixed ${fixedCount} stuck lock(s)`
      : "Stuck reflection lock(s) detected",
    details,
    fixable: true,
    fixed: options.fix ? fixedCount > 0 : undefined,
  };
}

// ── Check 5: Global Budget Status ───────────────────────────────

export function checkBudgetStatus(options: DoctorOptions): CheckResult {
  const checkpointDir = join(options.projectDir, ".garyclaw");
  const budgetPath = join(checkpointDir, GLOBAL_BUDGET_FILE);
  const details: string[] = [];

  const configLimits = loadDaemonBudgetConfig(checkpointDir);
  const dailyLimit = options.dailyCostLimitUsd ?? configLimits.dailyCostLimitUsd ?? DEFAULT_DAILY_COST_LIMIT;
  const maxJobs = options.maxJobsPerDay ?? configLimits.maxJobsPerDay ?? DEFAULT_MAX_JOBS_PER_DAY;

  if (!existsSync(budgetPath)) {
    return {
      name: "budget",
      status: "PASS",
      message: "No budget file (no daemon jobs run today)",
      fixable: false,
    };
  }

  // Use shared validateGlobalBudget from daemon-registry (single source of truth for budget validation).
  const budget = safeReadJSON<GlobalBudget>(budgetPath, validateGlobalBudget);

  if (!budget) {
    if (options.fix) {
      // Corrupt budget — write fresh
      const today = new Date().toISOString().slice(0, 10);
      safeWriteJSON(budgetPath, { date: today, totalUsd: 0, jobCount: 0, byInstance: {} });
      return {
        name: "budget",
        status: "WARN",
        message: "Fixed: corrupt budget file reset",
        details: ["Corrupt global-budget.json renamed to .bak, wrote fresh"],
        fixable: true,
        fixed: true,
      };
    }
    return {
      name: "budget",
      status: "WARN",
      message: "Corrupt global budget file",
      details: ["global-budget.json is corrupt or invalid"],
      fixable: true,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  if (budget.date !== today) {
    return {
      name: "budget",
      status: "PASS",
      message: "Budget resets today (last activity on different day)",
      fixable: false,
    };
  }

  const remaining = dailyLimit - budget.totalUsd;
  const jobsRemaining = maxJobs - budget.jobCount;

  if (remaining <= 0) {
    details.push(`Daily budget exhausted: $${budget.totalUsd.toFixed(2)} spent of $${dailyLimit.toFixed(2)} limit`);
    return {
      name: "budget",
      status: "WARN",
      message: `Daily budget exhausted ($${budget.totalUsd.toFixed(2)} spent)`,
      details,
      fixable: false,
    };
  }

  if (jobsRemaining <= 0) {
    details.push(`Max jobs reached: ${budget.jobCount}/${maxJobs}`);
    return {
      name: "budget",
      status: "WARN",
      message: `Max jobs reached (${budget.jobCount}/${maxJobs})`,
      details,
      fixable: false,
    };
  }

  if (remaining < dailyLimit * 0.2) {
    details.push(`$${remaining.toFixed(2)} remaining of $${dailyLimit.toFixed(2)}`);
    details.push(`${jobsRemaining} jobs remaining of ${maxJobs}`);
    return {
      name: "budget",
      status: "WARN",
      message: `Daily budget low ($${remaining.toFixed(2)} remaining)`,
      details,
      fixable: false,
    };
  }

  return {
    name: "budget",
    status: "PASS",
    message: `Budget healthy ($${remaining.toFixed(2)} remaining, ${jobsRemaining} jobs left)`,
    fixable: false,
  };
}

// ── Check 6: Auth Verification ──────────────────────────────────

export async function checkAuth(
  options: DoctorOptions,
  deps?: {
    verifyAuth: (env: Record<string, string>) => Promise<string>;
    buildSdkEnv: (processEnv: Record<string, string | undefined>) => Record<string, string>;
  },
): Promise<CheckResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;

  // Lazy-load SDK wrapper to avoid import issues in tests
  const { verifyAuth, buildSdkEnv } = deps ?? await import("./sdk-wrapper.js");

  try {
    const env = buildSdkEnv(process.env as Record<string, string | undefined>);

    const sessionId = await Promise.race([
      verifyAuth(env),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AUTH_TIMEOUT")), timeoutMs),
      ),
    ]);

    return {
      name: "auth",
      status: "PASS",
      message: `Auth OK (session: ${sessionId.slice(0, 8)}...)`,
      fixable: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message === "AUTH_TIMEOUT") {
      return {
        name: "auth",
        status: "WARN",
        message: `Auth check timed out (${timeoutMs / 1000}s) — may be network issue`,
        fixable: false,
      };
    }

    return {
      name: "auth",
      status: "FAIL",
      message: `Auth failed: ${message}`,
      details: ["Run `claude` to re-authenticate"],
      fixable: false,
    };
  }
}

// ── Auto-cleanup (callable from daemon start / --parallel) ──────

export interface AutoCleanupOptions {
  projectDir: string;
  dailyCostLimitUsd?: number;
  maxJobsPerDay?: number;
}

/**
 * Run fixable doctor checks and return what was cleaned.
 * Used by `daemon start` and `--parallel` to auto-heal stale state.
 *
 * Each cleanup category is independent and fail-open: partial cleanup
 * never blocks daemon start. Auth is always skipped (checked separately).
 */
export async function runAutoCleanup(options: AutoCleanupOptions): Promise<{ cleaned: string[] }> {
  const cleaned: string[] = [];
  const fixOptions: DoctorOptions = {
    projectDir: options.projectDir,
    fix: true,
    skipAuth: true,
    dailyCostLimitUsd: options.dailyCostLimitUsd,
    maxJobsPerDay: options.maxJobsPerDay,
  };

  // Each check is independent — failures in one don't block others
  const checks = [
    { fn: () => checkStalePids(fixOptions), label: "stale PIDs" },
    { fn: () => checkOrphanedWorktrees(fixOptions), label: "orphaned worktrees" },
    { fn: () => checkReflectionLocks(fixOptions), label: "stuck reflection locks" },
    { fn: () => checkBudgetStatus(fixOptions), label: "budget" },
    { fn: () => checkOrphanedTodoState(fixOptions), label: "orphaned TODO state" },
    { fn: () => checkStaleBudgetLocks(fixOptions), label: "stale budget locks" },
  ];

  for (const check of checks) {
    try {
      const result = check.fn();
      if (result.fixed) {
        cleaned.push(check.label);
      }
    } catch {
      // Fail-open: log nothing, continue to next check
    }
  }

  return { cleaned };
}

// ── CLI formatting ──────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

const STATUS_ICONS: Record<CheckStatus, string> = {
  PASS: `${GREEN}✅ PASS${RESET}`,
  WARN: `${YELLOW}⚠️  WARN${RESET}`,
  FAIL: `${RED}❌ FAIL${RESET}`,
  INFO: `${CYAN}ℹ️  INFO${RESET}`,
};

export function formatDoctorReport(report: DoctorReport, fix: boolean): string {
  const lines: string[] = [];

  const header = fix
    ? `${BOLD}🔧 GaryClaw Doctor${RESET} — running ${report.checks.length} checks with auto-fix...`
    : `${BOLD}🔍 GaryClaw Doctor${RESET} — running ${report.checks.length} checks...`;
  lines.push(header);
  lines.push("");

  for (const check of report.checks) {
    const icon = check.fixed
      ? `${YELLOW}⚠️→${GREEN}✅${RESET}`
      : STATUS_ICONS[check.status];
    lines.push(`  ${icon}  ${BOLD}${check.name.padEnd(20)}${RESET} ${check.message}`);

    if (check.details && check.details.length > 0) {
      for (const detail of check.details) {
        lines.push(`${DIM}    ${detail}${RESET}`);
      }
    }
  }

  lines.push("");

  const { pass, warn, fail } = report.summary;
  const fixedCount = report.checks.filter((c) => c.fixed).length;
  const fixSuffix = fixedCount > 0 ? ` — ${fixedCount} issue(s) fixed` : "";
  const durationStr = `${(report.durationMs / 1000).toFixed(1)}s`;

  lines.push(
    `  Summary: ${GREEN}${pass} passed${RESET}, ${YELLOW}${warn} warnings${RESET}, ${RED}${fail} failures${RESET} (${durationStr})${fixSuffix}`,
  );

  if (warn > 0 && !fix) {
    const fixableCount = report.checks.filter((c) => c.fixable && c.status === "WARN").length;
    if (fixableCount > 0) {
      lines.push(`  ${DIM}Run with --fix to resolve ${fixableCount} fixable issue(s).${RESET}`);
    }
  }

  return lines.join("\n");
}

// ── Internal helpers ─────────────────────────────────────────────

function hasInjectionPatterns(content: string): boolean {
  const patterns = [
    /^<\/?system[^>]*>/im,
    /^<\/?instructions[^>]*>/im,
    /^IGNORE ALL PREVIOUS INSTRUCTIONS/im,
    /^YOU ARE NOW/im,
    /^FORGET EVERYTHING/im,
    /^NEW INSTRUCTIONS:/im,
    /^OVERRIDE:/im,
    /^SYSTEM:/im,
  ];
  return patterns.some((p) => p.test(content));
}

function defaultMetrics(): OracleMetrics {
  return {
    totalDecisions: 0,
    accurateDecisions: 0,
    neutralDecisions: 0,
    failedDecisions: 0,
    accuracyPercent: 100,
    confidenceTrend: [],
    lastReflectionTimestamp: null,
    circuitBreakerTripped: false,
  };
}

export function worktreeHasUnmergedCommits(repoDir: string, instanceName: string): boolean {
  const branch = branchName(instanceName);
  try {
    const baseBranch = resolveBaseBranch(repoDir);

    const count = execFileSync(
      "git",
      ["rev-list", "--count", `${baseBranch}..${branch}`],
      { cwd: repoDir, stdio: "pipe", encoding: "utf-8" },
    ).trim();

    return parseInt(count, 10) > 0;
  } catch {
    // Can't check — assume unmerged for safety
    return true;
  }
}

// ── Check 7: Orphaned TODO State Files ──────────────────────────

export function checkOrphanedTodoState(options: DoctorOptions): CheckResult {
  const checkpointDir = join(options.projectDir, ".garyclaw");
  const todoStateDir = join(checkpointDir, "todo-state");
  const details: string[] = [];
  let orphanCount = 0;
  let fixedCount = 0;

  if (!existsSync(todoStateDir)) {
    return {
      name: "Orphaned TODO State",
      status: "PASS",
      message: "No todo-state directory found",
      fixable: false,
    };
  }

  let stateFiles: string[];
  try {
    stateFiles = readdirSync(todoStateDir).filter(f => f.endsWith(".json"));
  } catch {
    return {
      name: "Orphaned TODO State",
      status: "PASS",
      message: "Could not read todo-state directory",
      fixable: false,
    };
  }

  if (stateFiles.length === 0) {
    return {
      name: "Orphaned TODO State",
      status: "PASS",
      message: "No TODO state files found",
      fixable: false,
    };
  }

  // Load TODOS.md titles for matching
  const todosPath = join(options.projectDir, "TODOS.md");
  let todoTitles: string[] = [];
  if (existsSync(todosPath)) {
    try {
      const content = readFileSync(todosPath, "utf-8");
      // Simple extraction: lines starting with "- [ ]" or "- [x]"
      todoTitles = content
        .split("\n")
        .filter(l => /^-\s*\[[ x]\]/.test(l))
        .map(l => l.replace(/^-\s*\[[ x]\]\s*/, "").replace(/\s*\[P\d\].*$/, "").trim());
    } catch { /* ignore */ }
  }

  for (const file of stateFiles) {
    const filePath = join(todoStateDir, file);
    const state = safeReadJSON<{ title?: string; state?: string }>(filePath);
    if (!state?.title) continue;

    // Check if title exists in TODOS.md (simple substring/includes match)
    const titleLower = state.title.toLowerCase();
    const found = todoTitles.some(t => {
      const tLower = t.toLowerCase();
      return tLower === titleLower || tLower.includes(titleLower) || titleLower.includes(tLower);
    });

    if (!found && todoTitles.length > 0) {
      orphanCount++;
      details.push(`Orphaned: ${file} (title: "${state.title}", state: ${state.state ?? "unknown"})`);

      if (options.fix) {
        try {
          unlinkSync(filePath);
          fixedCount++;
          details.push(`  Fixed: removed ${file}`);
        } catch (err) {
          details.push(`  Fix failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  if (orphanCount === 0) {
    return {
      name: "Orphaned TODO State",
      status: "PASS",
      message: `${stateFiles.length} TODO state file(s) verified`,
      fixable: false,
    };
  }

  return {
    name: "Orphaned TODO State",
    status: "WARN",
    message: `${orphanCount} orphaned TODO state file(s) — title not found in TODOS.md${options.fix ? ` (${fixedCount} fixed)` : ""}`,
    details,
    fixable: true,
    fixed: options.fix && fixedCount === orphanCount,
  };
}

// ── Check 8: Stale Budget Locks ─────────────────────────────────

export function checkStaleBudgetLocks(options: DoctorOptions): CheckResult {
  const checkpointDir = join(options.projectDir, ".garyclaw");
  const lockDir = join(checkpointDir, BUDGET_LOCK_DIR_NAME);
  const details: string[] = [];

  if (!existsSync(lockDir)) {
    return {
      name: "budget-locks",
      status: "PASS",
      message: "No stale budget locks",
      fixable: false,
    };
  }

  const pidFile = join(lockDir, "pid");
  if (!existsSync(pidFile)) {
    // Lock dir exists but no PID file — stale
    details.push("Budget lock directory exists but no PID file");
    if (options.fix) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
        details.push("  Fixed: removed stale budget lock directory");
        return {
          name: "budget-locks",
          status: "WARN",
          message: "Fixed 1 stale budget lock",
          details,
          fixable: true,
          fixed: true,
        };
      } catch (err) {
        details.push(`  Fix failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      name: "budget-locks",
      status: "WARN",
      message: "Stale budget lock detected",
      details,
      fixable: true,
    };
  }

  // Read PID from lock
  let pid: number | null = null;
  try {
    pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) pid = null;
  } catch {
    pid = null;
  }

  if (pid === null) {
    details.push("Budget lock PID file unreadable");
    if (options.fix) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
        details.push("  Fixed: removed stale budget lock directory");
        return {
          name: "budget-locks",
          status: "WARN",
          message: "Fixed 1 stale budget lock",
          details,
          fixable: true,
          fixed: true,
        };
      } catch (err) {
        details.push(`  Fix failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      name: "budget-locks",
      status: "WARN",
      message: "Stale budget lock detected",
      details,
      fixable: true,
    };
  }

  // Check if holding process is alive
  const result = isPidAlive(pid);
  if (result.alive) {
    details.push(`Budget lock held by active process (PID ${pid})`);
    return {
      name: "budget-locks",
      status: "PASS",
      message: "Budget lock held by active process",
      details,
      fixable: false,
    };
  }

  // Dead process — stale lock
  details.push(`Stuck budget lock (holder PID ${pid} is dead)`);
  if (options.fix) {
    try {
      rmSync(lockDir, { recursive: true, force: true });
      details.push("  Fixed: removed stuck budget lock directory");
      return {
        name: "budget-locks",
        status: "WARN",
        message: "Fixed 1 stale budget lock",
        details,
        fixable: true,
        fixed: true,
      };
    } catch (err) {
      details.push(`  Fix failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    name: "budget-locks",
    status: "WARN",
    message: "Stale budget lock detected",
    details,
    fixable: true,
  };
}

function loadDaemonBudgetConfig(checkpointDir: string): { dailyCostLimitUsd: number | null; maxJobsPerDay: number | null } {
  try {
    const configPath = join(checkpointDir, "daemon.json");
    if (!existsSync(configPath)) return { dailyCostLimitUsd: null, maxJobsPerDay: null };
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const budget = config?.budget;
    return {
      dailyCostLimitUsd: typeof budget?.dailyCostLimitUsd === "number" ? budget.dailyCostLimitUsd : null,
      maxJobsPerDay: typeof budget?.maxJobsPerDay === "number" ? budget.maxJobsPerDay : null,
    };
  } catch { /* ignore */ }
  return { dailyCostLimitUsd: null, maxJobsPerDay: null };
}

