/**
 * Git Worktree isolation for parallel daemon instances.
 *
 * Each named daemon instance operates in its own git worktree — a first-class
 * git feature with independent working directories, staging areas, and HEAD
 * pointers. Commits made in one worktree are immediately visible to others
 * through shared refs.
 *
 * Uses execFileSync exclusively (no shell injection).
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveWarnFn } from "./types.js";
import type { WarnFn } from "./types.js";

export interface WorktreeInfo {
  path: string;           // Absolute path to worktree directory
  branch: string;         // Branch name (e.g., "garyclaw/builder")
  head: string;           // Current HEAD SHA
}

export interface MergeResult {
  merged: boolean;
  reason?: string;
  commitCount?: number;
  testsPassed?: boolean;       // undefined if tests not run, true/false otherwise
  testOutput?: string;         // truncated stderr from test run (max 2000 chars)
  testDurationMs?: number;     // how long tests took
}

export interface MergeValidationConfig {
  /** Command to run for validation (default: "npm test") */
  testCommand?: string;
  /** Timeout in ms (default: 120000 = 2 min) */
  testTimeout?: number;
  /** Skip validation entirely (default: false) */
  skipValidation?: boolean;
}

export interface MergeOptions {
  validation?: MergeValidationConfig;
  jobId?: string;          // For audit log attribution
  auditDir?: string;       // Override audit log directory
  onWarn?: WarnFn;         // Route warnings through event system in daemon mode
}

export interface MergeAuditEntry {
  timestamp: string;
  instanceName: string;
  branch: string;
  baseBranch: string;
  commitCount: number;
  merged: boolean;
  reason?: string;
  testsPassed?: boolean;
  testDurationMs?: number;
  testOutput?: string;    // truncated to 2000 chars
  jobId?: string;
}

/**
 * Worktree directory path convention.
 * Returns: {repoDir}/.garyclaw/worktrees/{instanceName}
 */
export function worktreeDir(repoDir: string, instanceName: string): string {
  return join(repoDir, ".garyclaw", "worktrees", instanceName);
}

/**
 * Sanitize a string for use in git branch names.
 * Git branch names cannot contain: ~ ^ : \ space, control chars, "..", "@{", or end with "." or ".lock".
 */
export function sanitizeBranchComponent(name: string): string {
  const sanitized = name
    .replace(/[\x00-\x1f\x7f~^:\\@{}\s/]+/g, "-")  // control chars + illegal chars + slash → dash
    .replace(/\.{2,}/g, ".")                          // collapse ".." sequences
    .replace(/\.lock$/i, "-lock")                     // ".lock" suffix forbidden
    .replace(/^\./, "-")                              // leading dot forbidden
    .replace(/\.$/, "-")                              // trailing dot forbidden
    .replace(/-{2,}/g, "-")                           // collapse repeated dashes
    .replace(/^-|-$/g, "");                           // trim leading/trailing dashes
  if (sanitized.length === 0) {
    throw new Error(`Cannot sanitize "${name}" into a valid git branch component`);
  }
  return sanitized;
}

/**
 * Branch name convention for an instance.
 */
export function branchName(instanceName: string): string {
  return `garyclaw/${sanitizeBranchComponent(instanceName)}`;
}

/**
 * Resolve the base branch (main, master, or current branch).
 */
export function resolveBaseBranch(repoDir: string): string {
  // Try main
  try {
    execFileSync("git", ["rev-parse", "--verify", "refs/heads/main"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    return "main";
  } catch {
    // not main
  }

  // Try master
  try {
    execFileSync("git", ["rev-parse", "--verify", "refs/heads/master"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    return "master";
  } catch {
    // not master
  }

  // Fall back to current branch
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    // Detached HEAD returns "HEAD"
    if (branch && branch !== "HEAD") return branch;
  } catch {
    // ignore
  }

  // Detached HEAD — return the commit SHA
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
  } catch {
    throw new Error(`Cannot resolve base branch in ${repoDir}`);
  }
}

/**
 * Create a worktree for a daemon instance.
 * Branch is created from baseBranch HEAD. If branch exists, reset to baseBranch HEAD.
 */
export function createWorktree(
  repoDir: string,
  instanceName: string,
  baseBranch: string,
): WorktreeInfo {
  const wtDir = worktreeDir(repoDir, instanceName);
  const branch = branchName(instanceName);

  // Ensure parent directory exists
  mkdirSync(join(repoDir, ".garyclaw", "worktrees"), { recursive: true });

  // If worktree already exists, remove it first for a clean start
  if (existsSync(wtDir)) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wtDir], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      // Force cleanup if git worktree remove fails
      rmSync(wtDir, { recursive: true, force: true });
      // Prune stale worktree entries
      execFileSync("git", ["worktree", "prune"], {
        cwd: repoDir,
        stdio: "pipe",
      });
    }
  }

  // Get the base branch HEAD SHA
  const baseHead = execFileSync("git", ["rev-parse", baseBranch], {
    cwd: repoDir,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();

  // Create or reset the branch
  try {
    execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd: repoDir,
      stdio: "pipe",
    });
    // Branch exists — check for unmerged commits before resetting
    const aheadCount = execFileSync(
      "git",
      ["rev-list", "--count", `${baseBranch}..${branch}`],
      { cwd: repoDir, stdio: "pipe", encoding: "utf-8" },
    ).trim();
    if (parseInt(aheadCount, 10) > 0) {
      throw new Error(
        `Branch ${branch} has ${aheadCount} unmerged commit(s) ahead of ${baseBranch}. ` +
        `Merge or delete the branch first: git branch -D ${branch}`,
      );
    }
    // Branch exists with no unmerged commits — safe to reset
    execFileSync("git", ["branch", "-f", branch, baseHead], {
      cwd: repoDir,
      stdio: "pipe",
    });
  } catch (err) {
    // Re-throw if it's our own unmerged-commit guard error
    if (err instanceof Error && err.message.includes("unmerged commit")) {
      throw err;
    }
    // Branch doesn't exist — create it
    execFileSync("git", ["branch", branch, baseHead], {
      cwd: repoDir,
      stdio: "pipe",
    });
  }

  // Create the worktree
  execFileSync("git", ["worktree", "add", wtDir, branch], {
    cwd: repoDir,
    stdio: "pipe",
  });

  return {
    path: resolve(wtDir),
    branch,
    head: baseHead,
  };
}

/**
 * Remove a worktree and optionally delete its branch.
 * No-op if worktree doesn't exist.
 */
export function removeWorktree(
  repoDir: string,
  instanceName: string,
  deleteBranch = false,
): void {
  const wtDir = worktreeDir(repoDir, instanceName);
  const branch = branchName(instanceName);

  // Remove worktree
  if (existsSync(wtDir)) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wtDir], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      // Force cleanup
      rmSync(wtDir, { recursive: true, force: true });
      try {
        execFileSync("git", ["worktree", "prune"], {
          cwd: repoDir,
          stdio: "pipe",
        });
      } catch {
        // Prune is best-effort cleanup — don't fail the remove
      }
    }
  }

  // Delete branch if requested
  if (deleteBranch) {
    try {
      execFileSync("git", ["branch", "-D", branch], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      // Branch may not exist — ignore
    }
  }
}

/**
 * Attempt fast-forward merge of instance branch into base branch.
 * Returns { merged: true, commitCount } or { merged: false, reason }.
 */
export function mergeWorktreeBranch(
  repoDir: string,
  instanceName: string,
  baseBranch: string,
  options?: MergeOptions,
): MergeResult {
  const branch = branchName(instanceName);

  // Verify branch exists
  try {
    execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branch}`], {
      cwd: repoDir,
      stdio: "pipe",
    });
  } catch {
    return { merged: false, reason: `Branch ${branch} does not exist` };
  }

  // Count commits ahead
  let commitCount: number;
  try {
    const commitCountStr = execFileSync(
      "git",
      ["rev-list", "--count", `${baseBranch}..${branch}`],
      { cwd: repoDir, stdio: "pipe", encoding: "utf-8" },
    ).trim();
    commitCount = parseInt(commitCountStr, 10);
  } catch {
    return { merged: false, reason: `Cannot compare ${branch} with ${baseBranch} — base branch may not exist` };
  }

  if (commitCount === 0) {
    return { merged: true, commitCount: 0, reason: "Already up to date" };
  }

  // Save current branch so we can restore it after merge
  let originalBranch: string | null = null;
  try {
    originalBranch = execFileSync(
      "git", ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoDir, stdio: "pipe", encoding: "utf-8" },
    ).trim();
    if (originalBranch === "HEAD") originalBranch = null; // detached HEAD
  } catch {
    // Non-fatal: we just won't restore
  }

  // Ensure we're on the base branch before merging
  try {
    if (originalBranch !== baseBranch) {
      execFileSync("git", ["checkout", baseBranch], {
        cwd: repoDir,
        stdio: "pipe",
      });
    }
  } catch {
    return {
      merged: false,
      commitCount,
      reason: `Cannot checkout ${baseBranch} for merge`,
    };
  }

  // Rebase instance branch onto baseBranch, then fast-forward merge.
  // Acquire merge lock to prevent concurrent rebase/merge across instances.
  // Dynamic lock timeout: testTimeout + 60s buffer (default: 180s if validation enabled)
  const lockTimeout = options?.validation?.skipValidation
    ? MERGE_LOCK_TIMEOUT_MS   // no tests = use default 60s
    : options?.validation
      ? (options.validation.testTimeout ?? 120_000) + 60_000
      : MERGE_LOCK_TIMEOUT_MS;  // no validation config = default 60s

  if (!acquireMergeLock(repoDir, lockTimeout)) {
    const result: MergeResult = { merged: false, commitCount, reason: "Could not acquire merge lock (another instance merging)" };
    appendMergeAudit(repoDir, instanceName, branch, baseBranch, result, options);
    restoreBranch(repoDir, originalBranch, baseBranch);
    return result;
  }

  // Stash dirty working tree state inside the merge lock (same pattern as relay.ts).
  // In daemon mode, main repo may have uncommitted tracked file changes from other
  // instances or relay artifacts. Stash before checkout, pop after merge.
  let stashed = false;
  try {
    const stashOutput = execFileSync(
      "git", ["stash", "push", "--include-untracked", "-m", "garyclaw-merge-stash"],
      { cwd: repoDir, stdio: "pipe", encoding: "utf-8" },
    ).trim();
    // "No local changes to save" means nothing was stashed
    stashed = !stashOutput.includes("No local changes");
  } catch {
    // Stash failed — continue anyway (best-effort)
  }

  try {
    // Rebase: run in worktree dir (which is already on the instance branch)
    // to avoid disrupting the main repo's working directory.
    const wtDir = worktreeDir(repoDir, instanceName);
    if (existsSync(wtDir)) {
      try {
        execFileSync("git", ["rebase", baseBranch], {
          cwd: wtDir,
          stdio: "pipe",
        });
      } catch {
        // Rebase conflict — abort and bail
        try { execFileSync("git", ["rebase", "--abort"], { cwd: wtDir, stdio: "pipe" }); } catch { /* noop */ }
        restoreBranch(repoDir, originalBranch, baseBranch);
        const result: MergeResult = {
          merged: false,
          commitCount,
          reason: `Rebase of ${branch} onto ${baseBranch} had conflicts — needs manual resolution`,
        };
        appendMergeAudit(repoDir, instanceName, branch, baseBranch, result, options);
        return result;
      }

      // ── Pre-merge test gate ──────────────────────────────────────
      // Run tests on the rebased branch BEFORE merging to main.
      // Uses execSync (not execFileSync) to support compound commands like "npm run lint && npm test".
      if (options?.validation && !options.validation.skipValidation) {
        const testCommand = options.validation.testCommand ?? "npm test";
        const testTimeout = options.validation.testTimeout ?? 120_000;
        const testStart = Date.now();

        try {
          execSync(testCommand, {
            cwd: wtDir,
            timeout: testTimeout,
            stdio: "pipe",
            shell: "/bin/sh",
          });
          // Tests passed — continue to ff-only merge
          const testDurationMs = Date.now() - testStart;
          // Store test results on the eventual merge result (handled below)
          Object.defineProperty(options, "_testResult", {
            value: { testsPassed: true, testDurationMs },
            configurable: true,
          });
        } catch (testErr: unknown) {
          const testDurationMs = Date.now() - testStart;
          let output = "";
          if (testErr instanceof Error && ("stdout" in testErr || "stderr" in testErr)) {
            const errObj = testErr as { stdout?: unknown; stderr?: unknown };
            const stdout = errObj.stdout ? String(errObj.stdout) : "";
            const stderr = errObj.stderr ? String(errObj.stderr) : "";
            output = (stdout + (stdout && stderr ? "\n" : "") + stderr).slice(0, 2000);
          } else if (testErr instanceof Error) {
            output = testErr.message.slice(0, 2000);
          }
          restoreBranch(repoDir, originalBranch, baseBranch);
          const result: MergeResult = {
            merged: false,
            reason: "Pre-merge tests failed",
            testsPassed: false,
            testOutput: output,
            testDurationMs,
            commitCount,
          };
          appendMergeAudit(repoDir, instanceName, branch, baseBranch, result, options);
          return result;
        }
      }
    }

    // After successful rebase + tests (or no worktree), ff-only merge
    try {
      execFileSync("git", ["merge", "--ff-only", branch], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      restoreBranch(repoDir, originalBranch, baseBranch);
      const result: MergeResult = {
        merged: false,
        commitCount,
        reason: `Branch ${branch} has ${commitCount} commit(s) that cannot be fast-forwarded — needs manual merge or rebase`,
      };
      appendMergeAudit(repoDir, instanceName, branch, baseBranch, result, options);
      return result;
    }

    restoreBranch(repoDir, originalBranch, baseBranch);
    // Attach test results if we ran validation
    const testResult = options && "_testResult" in options
      ? (options as any)._testResult as { testsPassed: boolean; testDurationMs: number }
      : undefined;
    const result: MergeResult = {
      merged: true,
      commitCount,
      ...(testResult ? { testsPassed: testResult.testsPassed, testDurationMs: testResult.testDurationMs } : {}),
    };
    appendMergeAudit(repoDir, instanceName, branch, baseBranch, result, options);
    return result;
  } finally {
    // Pop stash if we pushed one (before releasing merge lock)
    if (stashed) {
      try {
        execFileSync("git", ["stash", "pop"], { cwd: repoDir, stdio: "pipe" });
      } catch {
        // Pop conflict — leave stash in place for manual resolution.
        // User can inspect with `git stash list` and resolve with `git stash drop`.
        const mergeWarn = resolveWarnFn(options?.onWarn);
        mergeWarn("[worktree] Stash pop failed after merge — stash left in place for manual resolution");
      }
    }
    releaseMergeLock(repoDir);
  }
}

/** Restore original branch after merge attempt. Non-fatal on failure. */
function restoreBranch(repoDir: string, originalBranch: string | null, baseBranch: string): void {
  if (originalBranch && originalBranch !== baseBranch) {
    try {
      execFileSync("git", ["checkout", originalBranch], { cwd: repoDir, stdio: "pipe" });
    } catch { /* Non-fatal */ }
  }
}

/**
 * List all active GaryClaw worktrees for this repo.
 */
export function listWorktrees(repoDir: string, onWarn?: WarnFn): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];

  try {
    const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf-8",
    });

    // Parse porcelain output: blocks separated by blank lines
    const blocks = output.split("\n\n").filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n");
      let path = "";
      let head = "";
      let branch = "";

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          path = line.slice("worktree ".length);
        } else if (line.startsWith("HEAD ")) {
          head = line.slice("HEAD ".length);
        } else if (line.startsWith("branch ")) {
          // branch refs/heads/garyclaw/builder → garyclaw/builder
          const ref = line.slice("branch ".length);
          branch = ref.replace("refs/heads/", "");
        }
      }

      // Only include garyclaw/* branches
      if (branch.startsWith("garyclaw/")) {
        result.push({ path, branch, head });
      }
    }
  } catch (err) {
    // Log warning so silent failures are diagnosable
    const listWarn = resolveWarnFn(onWarn);
    listWarn(`[worktree] Failed to list worktrees: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Get the worktree path for an instance (null if no worktree).
 */
export function getWorktreePath(repoDir: string, instanceName: string): string | null {
  // Default instance never has a worktree
  if (instanceName === "default") return null;

  const wtDir = worktreeDir(repoDir, instanceName);
  if (existsSync(wtDir)) {
    return resolve(wtDir);
  }
  return null;
}

// ── Merge audit log ─────────────────────────────────────────────

/**
 * Append a merge audit entry to the instance's merge-audit.jsonl.
 * Best-effort — never throws.
 */
export function appendMergeAudit(
  repoDir: string,
  instanceName: string,
  branch: string,
  baseBranch: string,
  result: MergeResult,
  options?: MergeOptions,
): void {
  try {
    const auditDir = options?.auditDir ?? join(repoDir, ".garyclaw", "daemons", instanceName);
    mkdirSync(auditDir, { recursive: true });
    const entry: MergeAuditEntry = {
      timestamp: new Date().toISOString(),
      instanceName,
      branch,
      baseBranch,
      commitCount: result.commitCount ?? 0,
      merged: result.merged,
      reason: result.reason,
      testsPassed: result.testsPassed,
      testDurationMs: result.testDurationMs,
      testOutput: result.testOutput?.slice(0, 2000),
      jobId: options?.jobId,
    };
    appendFileSync(join(auditDir, "merge-audit.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Best-effort — don't crash the merge flow if audit write fails
  }
}

// ── Merge lock ──────────────────────────────────────────────────

const MERGE_LOCK_DIR = "merge-lock";
const MERGE_LOCK_PID = "pid";
const MERGE_LOCK_TIMEOUT_MS = 60_000;
const MERGE_LOCK_POLL_MS = 500;

/**
 * Acquire a merge lock for the repo. Prevents concurrent rebase+merge operations.
 * Uses mkdir-based atomic lock (same pattern as reflection-lock.ts).
 */
export function acquireMergeLock(
  repoDir: string,
  timeoutMs: number = MERGE_LOCK_TIMEOUT_MS,
): boolean {
  const lockDir = join(repoDir, ".garyclaw", MERGE_LOCK_DIR);
  const pidFile = join(lockDir, MERGE_LOCK_PID);

  if (tryMergeLock(lockDir, pidFile)) return true;

  // Check if reentrant (same process)
  if (isOwnMergeLock(pidFile)) return true;

  // Poll until timeout
  const deadline = Date.now() + timeoutMs;
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    Atomics.wait(sleepBuf, 0, 0, MERGE_LOCK_POLL_MS);

    if (tryMergeLock(lockDir, pidFile)) return true;

    // Stale lock recovery
    if (isStaleMergeLock(pidFile)) {
      try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race */ }
      if (tryMergeLock(lockDir, pidFile)) return true;
    }
  }

  return false;
}

/**
 * Release the merge lock. Safe to call even if not held.
 */
export function releaseMergeLock(repoDir: string): void {
  const lockDir = join(repoDir, ".garyclaw", MERGE_LOCK_DIR);
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* noop */ }
}

function tryMergeLock(lockDir: string, pidFile: string): boolean {
  try {
    // Ensure parent .garyclaw dir exists (recursive), then atomic mkdir for lock
    const parentDir = join(lockDir, "..");
    mkdirSync(parentDir, { recursive: true });
    mkdirSync(lockDir, { recursive: false });
    writeFileSync(pidFile, String(process.pid));
    return true;
  } catch {
    return false;
  }
}

function isOwnMergeLock(pidFile: string): boolean {
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    return pid === process.pid;
  } catch {
    return false;
  }
}

// ── Post-merge verification + auto-revert ───────────────────────

export interface PostMergeVerifyResult {
  verified: boolean;          // true = tests passed on main
  reverted: boolean;          // true = auto-revert executed
  revertSha?: string;         // SHA of the revert commit (if reverted)
  mergeSha: string;           // SHA of the merge commit being verified
  testOutput?: string;        // truncated stderr (max 2000 chars)
  testDurationMs?: number;
  reason?: string;            // human-readable failure reason
}

export interface MergeRevertEntry {
  timestamp: string;
  instanceName: string;
  mergeSha: string;
  revertSha?: string;        // undefined if revert failed/skipped
  branch: string;            // e.g., "garyclaw/worker-1"
  testOutput?: string;       // truncated to 2000 chars
  testDurationMs?: number;
  jobId?: string;
  reason: string;            // "post-merge tests failed" or specific error
  autoReverted: boolean;     // true if git revert succeeded
}

/**
 * Post-merge verification: run tests on main after merge, auto-revert if they fail.
 *
 * SHA-targeted revert: if HEAD has moved past mergeSha (another instance merged
 * on top), skip revert and return "manual revert needed". This is the safe default
 * for parallel instance operation.
 *
 * Must be called AFTER the merge lock is released — does not hold the lock.
 */
export function verifyPostMerge(
  repoDir: string,
  mergeSha: string,
  options?: {
    testCommand?: string;     // default: "npm test"
    testTimeout?: number;     // default: 120000
  },
): PostMergeVerifyResult {
  const testCommand = options?.testCommand ?? "npm test";
  const testTimeout = options?.testTimeout ?? 120_000;

  // Verify HEAD is at or ahead of mergeSha
  let currentHead: string;
  try {
    currentHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
  } catch {
    return {
      verified: false,
      reverted: false,
      mergeSha,
      reason: "Cannot read HEAD — git repo may be in a bad state",
    };
  }

  // Run tests on main repo
  const testStart = Date.now();
  try {
    execSync(testCommand, {
      cwd: repoDir,
      timeout: testTimeout,
      stdio: "pipe",
      shell: "/bin/sh",
    });
    // Tests passed
    return {
      verified: true,
      reverted: false,
      mergeSha,
      testDurationMs: Date.now() - testStart,
    };
  } catch (testErr: unknown) {
    const testDurationMs = Date.now() - testStart;

    // Extract test output
    let testOutput = "";
    if (testErr instanceof Error && ("stdout" in testErr || "stderr" in testErr)) {
      const errObj = testErr as { stdout?: unknown; stderr?: unknown };
      const stdout = errObj.stdout ? String(errObj.stdout) : "";
      const stderr = errObj.stderr ? String(errObj.stderr) : "";
      testOutput = (stdout + (stdout && stderr ? "\n" : "") + stderr).slice(0, 2000);
    } else if (testErr instanceof Error) {
      testOutput = testErr.message.slice(0, 2000);
    }

    // Re-read HEAD — it may have moved during test execution
    let headNow: string;
    try {
      headNow = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
    } catch {
      return {
        verified: false,
        reverted: false,
        mergeSha,
        testOutput,
        testDurationMs,
        reason: "Tests failed and cannot read HEAD for revert check",
      };
    }

    // If HEAD has moved past mergeSha, another instance merged — can't safely revert
    if (headNow !== mergeSha) {
      // Log what's between mergeSha and HEAD for diagnosis
      let commitsBetween = "";
      try {
        commitsBetween = execFileSync(
          "git",
          ["log", "--oneline", `${mergeSha}..HEAD`],
          { cwd: repoDir, stdio: "pipe", encoding: "utf-8" },
        ).trim();
      } catch {
        // best-effort
      }
      return {
        verified: false,
        reverted: false,
        mergeSha,
        testOutput,
        testDurationMs,
        reason: `HEAD moved past merge SHA — manual revert needed` +
          (commitsBetween ? `\nCommits since merge:\n${commitsBetween}` : ""),
      };
    }

    // HEAD === mergeSha — safe to revert
    try {
      execFileSync("git", ["revert", mergeSha, "--no-edit"], {
        cwd: repoDir,
        stdio: "pipe",
      });
      // Read the revert commit SHA
      const revertSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();

      return {
        verified: false,
        reverted: true,
        revertSha,
        mergeSha,
        testOutput,
        testDurationMs,
        reason: "Post-merge tests failed",
      };
    } catch {
      return {
        verified: false,
        reverted: false,
        mergeSha,
        testOutput,
        testDurationMs,
        reason: "Revert had conflicts — manual intervention needed",
      };
    }
  }
}

/**
 * Append a merge revert entry to .garyclaw/merge-reverts.jsonl.
 * Best-effort — never throws.
 */
export function appendMergeRevert(
  repoDir: string,
  entry: MergeRevertEntry,
): void {
  try {
    const gcDir = join(repoDir, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    appendFileSync(join(gcDir, "merge-reverts.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Best-effort — don't crash the job runner if write fails
  }
}

/**
 * Read all merge revert entries from .garyclaw/merge-reverts.jsonl.
 * Best-effort: returns empty array on any error.
 */
export function readMergeReverts(repoDir: string): MergeRevertEntry[] {
  const entries: MergeRevertEntry[] = [];
  try {
    const filePath = join(repoDir, ".garyclaw", "merge-reverts.jsonl");
    if (!existsSync(filePath)) return entries;
    const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as MergeRevertEntry);
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Best-effort
  }
  return entries;
}

function isStaleMergeLock(pidFile: string): boolean {
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid) || pid <= 0) return true;
    process.kill(pid, 0); // Throws if process doesn't exist
    return false;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") return true;
    return false;
  }
}
