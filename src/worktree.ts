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
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
 * Branch name convention for an instance.
 */
function branchName(instanceName: string): string {
  return `garyclaw/${instanceName}`;
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
    // Branch exists — reset to base branch HEAD
    execFileSync("git", ["branch", "-f", branch, baseHead], {
      cwd: repoDir,
      stdio: "pipe",
    });
  } catch {
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
      execFileSync("git", ["worktree", "prune"], {
        cwd: repoDir,
        stdio: "pipe",
      });
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
  const commitCountStr = execFileSync(
    "git",
    ["rev-list", "--count", `${baseBranch}..${branch}`],
    { cwd: repoDir, stdio: "pipe", encoding: "utf-8" },
  ).trim();
  const commitCount = parseInt(commitCountStr, 10);

  if (commitCount === 0) {
    return { merged: true, commitCount: 0, reason: "Already up to date" };
  }

  // Attempt fast-forward merge
  try {
    execFileSync("git", ["merge", "--ff-only", branch], {
      cwd: repoDir,
      stdio: "pipe",
    });
    return { merged: true, commitCount };
  } catch {
    return {
      merged: false,
      commitCount,
      reason: `Branch ${branch} has ${commitCount} commit(s) that cannot be fast-forwarded — needs manual merge or rebase`,
    };
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
  } catch {
    // git worktree list failed — return empty
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
