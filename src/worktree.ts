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

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WorktreeInfo {
  path: string;           // Absolute path to worktree directory
  branch: string;         // Branch name (e.g., "garyclaw/builder")
  head: string;           // Current HEAD SHA
}

export interface MergeResult {
  merged: boolean;
  reason?: string;
  commitCount?: number;
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

  // Check for dirty working tree before switching branches — never disrupt user's work.
  // Use git diff --quiet (not status --porcelain) to ignore untracked files like .garyclaw/
  try {
    // Staged changes to tracked files
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: repoDir,
      stdio: "pipe",
    });
    // Unstaged changes to tracked files
    execFileSync("git", ["diff", "--quiet"], {
      cwd: repoDir,
      stdio: "pipe",
    });
  } catch {
    // diff --quiet exits non-zero when tracked files have changes
    return {
      merged: false,
      commitCount,
      reason: `Working tree has uncommitted changes — cannot checkout ${baseBranch} for merge`,
    };
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
  if (!acquireMergeLock(repoDir)) {
    restoreBranch(repoDir, originalBranch, baseBranch);
    return { merged: false, commitCount, reason: "Could not acquire merge lock (another instance merging)" };
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
        return {
          merged: false,
          commitCount,
          reason: `Rebase of ${branch} onto ${baseBranch} had conflicts — needs manual resolution`,
        };
      }
    }

    // After successful rebase (or no worktree), ff-only merge
    try {
      execFileSync("git", ["merge", "--ff-only", branch], {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      restoreBranch(repoDir, originalBranch, baseBranch);
      return {
        merged: false,
        commitCount,
        reason: `Branch ${branch} has ${commitCount} commit(s) that cannot be fast-forwarded — needs manual merge or rebase`,
      };
    }

    restoreBranch(repoDir, originalBranch, baseBranch);
    return { merged: true, commitCount };
  } finally {
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
export function listWorktrees(repoDir: string): WorktreeInfo[] {
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
    console.warn(`[worktree] Failed to list worktrees: ${err instanceof Error ? err.message : String(err)}`);
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
