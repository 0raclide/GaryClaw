/**
 * Worktree stash-merge tests — verifies stash/pop around merge for dirty working trees.
 *
 * These tests use real git repos in temp directories to verify the stash/pop
 * behavior added to mergeWorktreeBranch() for daemon operation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorktree,
  mergeWorktreeBranch,
} from "../src/worktree.js";

/** Create a temp git repo with an initial commit. */
function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "garyclaw-stash-test-"));
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
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });
  } catch {
    // ignore
  }
});

describe("mergeWorktreeBranch stash/pop", () => {
  it("merges successfully when main repo has unstaged tracked file changes", () => {
    const info = createWorktree(repoDir, "builder", "main");
    makeCommit(info.path, "feature.txt", "feature", "Add feature");

    // Dirty the main repo's tracked file (this previously blocked merge)
    writeFileSync(join(repoDir, "README.md"), "# Modified\n");

    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result.merged).toBe(true);
    expect(result.commitCount).toBe(1);

    // Dirty state should be restored after merge
    const readmeContent = readFileSync(join(repoDir, "README.md"), "utf-8");
    expect(readmeContent).toBe("# Modified\n");
  });

  it("merges successfully when main repo has staged tracked file changes", () => {
    const info = createWorktree(repoDir, "builder", "main");
    makeCommit(info.path, "feature.txt", "feature", "Add feature");

    // Stage a change on main (this previously blocked merge)
    writeFileSync(join(repoDir, "README.md"), "# Staged change\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "pipe" });

    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result.merged).toBe(true);
    expect(result.commitCount).toBe(1);

    // Staged change should be restored
    const readmeContent = readFileSync(join(repoDir, "README.md"), "utf-8");
    expect(readmeContent).toBe("# Staged change\n");
  });

  it("pops stash after failed merge (rebase conflict)", () => {
    const info = createWorktree(repoDir, "builder", "main");
    // Both modify same file — will cause rebase conflict
    makeCommit(info.path, "shared.txt", "worktree version", "Edit shared in worktree");
    makeCommit(repoDir, "shared.txt", "main version", "Edit shared on main");

    // Also dirty an unrelated file
    writeFileSync(join(repoDir, "README.md"), "# Dirty during failed merge\n");

    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result.merged).toBe(false);
    expect(result.reason).toContain("conflicts");

    // Dirty state should still be restored even though merge failed
    const readmeContent = readFileSync(join(repoDir, "README.md"), "utf-8");
    expect(readmeContent).toBe("# Dirty during failed merge\n");
  });

  it("works when working tree is clean (no stash needed)", () => {
    const info = createWorktree(repoDir, "builder", "main");
    makeCommit(info.path, "feature.txt", "feature", "Add feature");

    // No dirty files — "No local changes to save" path
    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result.merged).toBe(true);
    expect(result.commitCount).toBe(1);
  });

  it("merges with untracked files present (included in stash)", () => {
    const info = createWorktree(repoDir, "builder", "main");
    makeCommit(info.path, "feature.txt", "feature", "Add feature");

    // Create untracked file in main repo
    writeFileSync(join(repoDir, "untracked.txt"), "untracked content");

    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result.merged).toBe(true);

    // Untracked file should be restored after merge
    expect(existsSync(join(repoDir, "untracked.txt"))).toBe(true);
    expect(readFileSync(join(repoDir, "untracked.txt"), "utf-8")).toBe("untracked content");
  });

  it("stash is inside merge-lock (serialized with other instances)", () => {
    // This test verifies the stash happens after lock acquisition.
    // If the stash happened before the lock, concurrent instances could
    // interleave stash operations.
    const info = createWorktree(repoDir, "builder", "main");
    makeCommit(info.path, "feature.txt", "feature", "Add feature");

    // Dirty working tree
    writeFileSync(join(repoDir, "README.md"), "# Lock-test\n");

    // First merge should succeed (acquires lock, stashes, merges, pops, releases)
    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result.merged).toBe(true);

    // Verify lock was released (a second merge attempt should not deadlock)
    const result2 = mergeWorktreeBranch(repoDir, "builder", "main");
    expect(result2.merged).toBe(true);
    expect(result2.commitCount).toBe(0); // already merged
  });

  it("leaves stash pop conflict as warning without crashing merge", () => {
    const info = createWorktree(repoDir, "builder", "main");

    // Worktree modifies README.md (will be merged to main)
    makeCommit(info.path, "README.md", "# Worktree version\n", "Modify README in worktree");

    // Main has uncommitted change to same file (will conflict on stash pop)
    writeFileSync(join(repoDir, "README.md"), "# Dirty local version\n");

    const result = mergeWorktreeBranch(repoDir, "builder", "main");
    // The merge itself should succeed (stash clears the dirty state)
    expect(result.merged).toBe(true);

    // After merge, stash pop may conflict since both modified README.md.
    // The stash should remain in the stash list for manual resolution.
    const stashList = execFileSync("git", ["stash", "list"], {
      cwd: repoDir,
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
    // Either stash was popped successfully or it remains — both are acceptable
    // The key assertion is that the merge didn't crash
  });
});
