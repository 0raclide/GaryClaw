/**
 * Worktree tests — git worktree creation, removal, merge, listing.
 *
 * These tests use real git repos in temp directories (unlike most GaryClaw
 * tests which use mocks). This is necessary because worktree operations
 * are tightly coupled to git internals.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorktree,
  removeWorktree,
  mergeWorktreeBranch,
  listWorktrees,
  getWorktreePath,
  resolveBaseBranch,
  worktreeDir,
} from "../src/worktree.js";

/** Create a temp git repo with an initial commit. */
function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "garyclaw-wt-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: dir, stdio: "pipe" });
  return dir;
}

/** Make a commit in the given dir. */
function makeCommit(dir: string, filename: string, content: string, message: string): string {
  writeFileSync(join(dir, filename), content);
  execFileSync("git", ["add", filename], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "pipe" });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    stdio: "pipe",
    encoding: "utf-8",
  }).trim();
}

let repoDir: string;

beforeEach(() => {
  repoDir = createTestRepo();
});

afterEach(() => {
  // Clean up worktrees before deleting temp dir (git needs them cleaned first)
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });
  } catch {
    // ignore
  }
});

// ── worktreeDir ──────────────────────────────────────────────────

describe("worktreeDir", () => {
  it("returns conventional path under .garyclaw/worktrees/", () => {
    expect(worktreeDir("/repo", "builder")).toBe("/repo/.garyclaw/worktrees/builder");
  });
});

// ── resolveBaseBranch ────────────────────────────────────────────

describe("resolveBaseBranch", () => {
  it("returns 'main' when main branch exists", () => {
    expect(resolveBaseBranch(repoDir)).toBe("main");
  });

  it("returns 'master' when master exists but main does not", () => {
    // Rename main to master
    execFileSync("git", ["branch", "-m", "main", "master"], { cwd: repoDir, stdio: "pipe" });
    expect(resolveBaseBranch(repoDir)).toBe("master");
  });

  it("returns current branch when neither main nor master exists", () => {
    execFileSync("git", ["checkout", "-b", "develop"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["branch", "-D", "main"], { cwd: repoDir, stdio: "pipe" });
    expect(resolveBaseBranch(repoDir)).toBe("develop");
  });

  it("returns SHA on detached HEAD", () => {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    execFileSync("git", ["checkout", "--detach"], { cwd: repoDir, stdio: "pipe" });
    // Delete named branches
    execFileSync("git", ["branch", "-D", "main"], { cwd: repoDir, stdio: "pipe" });
    expect(resolveBaseBranch(repoDir)).toBe(headSha);
  });
});

// ── createWorktree ───────────────────────────────────────────────

describe("createWorktree", () => {
  it("creates worktree with correct branch and path", () => {
    const info = createWorktree(repoDir, "builder", "main");

    expect(info.branch).toBe("garyclaw/builder");
    expect(info.path).toContain(".garyclaw/worktrees/builder");
    expect(info.head).toBeTruthy();
    expect(existsSync(info.path)).toBe(true);
    // Verify the worktree has the repo contents
    expect(existsSync(join(info.path, "README.md"))).toBe(true);
  });

  it("creates branch from base branch HEAD", () => {
    const mainHead = execFileSync("git", ["rev-parse", "main"], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();

    const info = createWorktree(repoDir, "builder", "main");
    expect(info.head).toBe(mainHead);
  });

  it("resets branch to base HEAD when branch already exists with no unmerged commits", () => {
    // Create worktree, remove it without committing (branch at same HEAD as main)
    createWorktree(repoDir, "builder", "main");
    removeWorktree(repoDir, "builder");

    // Make a new commit on main
    makeCommit(repoDir, "main-file.txt", "main content", "main commit");
    const newMainHead = execFileSync("git", ["rev-parse", "main"], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();

    // Re-create: branch has no unmerged commits, should reset to new main HEAD
    const info2 = createWorktree(repoDir, "builder", "main");
    expect(info2.head).toBe(newMainHead);
  });

  it("throws when branch has unmerged commits ahead of base", () => {
    // Regression: ISSUE-002 — createWorktree force-reset losing unmerged commits
    // Found by /qa on 2026-03-26
    // Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-26.md
    const info1 = createWorktree(repoDir, "builder", "main");
    makeCommit(info1.path, "feature.txt", "new feature", "worktree commit");
    removeWorktree(repoDir, "builder");

    // Branch still exists with 1 unmerged commit — createWorktree should refuse
    expect(() => createWorktree(repoDir, "builder", "main")).toThrow(
      /unmerged commit/,
    );
  });

  it("replaces existing worktree directory cleanly", () => {
    createWorktree(repoDir, "builder", "main");
    // Creating again should not throw
    const info = createWorktree(repoDir, "builder", "main");
    expect(existsSync(info.path)).toBe(true);
  });

  it("throws on invalid repo directory", () => {
    expect(() => createWorktree("/nonexistent/repo", "builder", "main")).toThrow();
  });
});

// ── removeWorktree ───────────────────────────────────────────────

describe("removeWorktree", () => {
  it("removes existing worktree", () => {
    const info = createWorktree(repoDir, "builder", "main");
    expect(existsSync(info.path)).toBe(true);

    removeWorktree(repoDir, "builder");
    expect(existsSync(info.path)).toBe(false);
  });

  it("removes worktree and deletes branch when requested", () => {
    createWorktree(repoDir, "builder", "main");
    removeWorktree(repoDir, "builder", true);

    // Branch should be gone
    expect(() => {
      execFileSync("git", ["rev-parse", "--verify", "refs/heads/garyclaw/builder"], {
        cwd: repoDir,
        stdio: "pipe",
      });
    }).toThrow();
  });

  it("is a no-op when worktree does not exist", () => {
    // Should not throw
    removeWorktree(repoDir, "nonexistent");
  });

  it("handles worktree with uncommitted changes", () => {
    const info = createWorktree(repoDir, "builder", "main");
    writeFileSync(join(info.path, "dirty.txt"), "uncommitted changes");

    // Should still remove (--force)
    removeWorktree(repoDir, "builder");
    expect(existsSync(info.path)).toBe(false);
  });
});

// ── mergeWorktreeBranch ──────────────────────────────────────────

describe("mergeWorktreeBranch", () => {
  it("fast-forwards on clean merge", () => {
    const info = createWorktree(repoDir, "builder", "main");
    makeCommit(info.path, "feature.txt", "feature", "Add feature");
    makeCommit(info.path, "feature2.txt", "feature2", "Add feature 2");

    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result.merged).toBe(true);
    expect(result.commitCount).toBe(2);
  });

  it("fails when branches have diverged", () => {
    const info = createWorktree(repoDir, "builder", "main");
    makeCommit(info.path, "feature.txt", "feature", "Add feature in worktree");

    // Make a commit on main too (diverge)
    makeCommit(repoDir, "main-change.txt", "main change", "Change on main");

    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result.merged).toBe(false);
    expect(result.reason).toContain("cannot be fast-forwarded");
    expect(result.commitCount).toBe(1);
  });

  it("returns already up to date when no commits", () => {
    createWorktree(repoDir, "builder", "main");
    // No commits in worktree

    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result.merged).toBe(true);
    expect(result.commitCount).toBe(0);
    expect(result.reason).toContain("Already up to date");
  });

  it("returns error when branch does not exist", () => {
    const result = mergeWorktreeBranch(repoDir, "nonexistent", "main");
    expect(result.merged).toBe(false);
    expect(result.reason).toContain("does not exist");
  });

  it("merges multiple commits correctly", () => {
    const info = createWorktree(repoDir, "builder", "main");
    makeCommit(info.path, "a.txt", "a", "Commit A");
    makeCommit(info.path, "b.txt", "b", "Commit B");
    makeCommit(info.path, "c.txt", "c", "Commit C");

    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result.merged).toBe(true);
    expect(result.commitCount).toBe(3);

    // Verify main now has the commits
    expect(existsSync(join(repoDir, "a.txt"))).toBe(true);
    expect(existsSync(join(repoDir, "c.txt"))).toBe(true);
  });

  it("handles already-merged branch (no-op)", () => {
    const info = createWorktree(repoDir, "builder", "main");
    makeCommit(info.path, "feature.txt", "feature", "Add feature");

    // Merge once
    mergeWorktreeBranch(repoDir, "builder", "main");

    // Merge again — should be up to date
    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result.merged).toBe(true);
    expect(result.commitCount).toBe(0);
  });
});

// ── listWorktrees ────────────────────────────────────────────────

describe("listWorktrees", () => {
  it("returns empty when no garyclaw worktrees", () => {
    const result = listWorktrees(repoDir);
    expect(result).toEqual([]);
  });

  it("returns one worktree", () => {
    createWorktree(repoDir, "builder", "main");
    const result = listWorktrees(repoDir);
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("garyclaw/builder");
    expect(result[0].path).toContain("builder");
    expect(result[0].head).toBeTruthy();
  });

  it("returns multiple worktrees", () => {
    createWorktree(repoDir, "builder", "main");
    createWorktree(repoDir, "reviewer", "main");
    const result = listWorktrees(repoDir);
    expect(result).toHaveLength(2);
    const branches = result.map((w) => w.branch).sort();
    expect(branches).toEqual(["garyclaw/builder", "garyclaw/reviewer"]);
  });
});

// ── getWorktreePath ──────────────────────────────────────────────

describe("getWorktreePath", () => {
  it("returns path for existing worktree", () => {
    const info = createWorktree(repoDir, "builder", "main");
    const path = getWorktreePath(repoDir, "builder");
    expect(path).toBe(info.path);
  });

  it("returns null when worktree does not exist", () => {
    const path = getWorktreePath(repoDir, "nonexistent");
    expect(path).toBeNull();
  });

  it("returns null for default instance", () => {
    const path = getWorktreePath(repoDir, "default");
    expect(path).toBeNull();
  });
});
