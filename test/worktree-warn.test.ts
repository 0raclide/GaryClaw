/**
 * Worktree warn routing tests — verifies onWarn parameter is used
 * instead of console.warn in listWorktrees and mergeWorktreeBranch.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listWorktrees,
  createWorktree,
  mergeWorktreeBranch,
} from "../src/worktree.js";

/** Create a temp git repo with an initial commit. */
function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "garyclaw-wt-warn-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("listWorktrees onWarn", () => {
  it("routes list failure through onWarn callback", () => {
    const onWarn = vi.fn();
    // Pass a non-existent directory to trigger git error
    listWorktrees("/nonexistent/path/to/repo", onWarn);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("[worktree] Failed to list worktrees:"),
    );
  });

  it("falls back to console.warn when onWarn not provided", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    listWorktrees("/nonexistent/path/to/repo");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[worktree] Failed to list worktrees:"),
    );
    spy.mockRestore();
  });

  it("does not call onWarn on success", () => {
    const repoDir = createTestRepo();
    const onWarn = vi.fn();
    const result = listWorktrees(repoDir, onWarn);
    expect(result).toEqual([]);
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe("mergeWorktreeBranch onWarn", () => {
  it("routes stash pop failure through onWarn callback", () => {
    const repoDir = createTestRepo();
    const info = createWorktree(repoDir, "warn-test", "main");

    // Worktree modifies README.md (will be merged to main)
    writeFileSync(join(info.path, "README.md"), "# Worktree version\n");
    execFileSync("git", ["add", "README.md"], { cwd: info.path, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Modify README in worktree"], { cwd: info.path, stdio: "pipe" });

    // Main has uncommitted change to same file (will conflict on stash pop)
    writeFileSync(join(repoDir, "README.md"), "# Dirty local version\n");

    const onWarn = vi.fn();
    const result = mergeWorktreeBranch(repoDir, "warn-test", "main", { onWarn });

    // The merge itself should succeed (stash clears the dirty state)
    expect(result.merged).toBe(true);

    // Stash pop should fail because both modified README.md, triggering onWarn
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("[worktree] Stash pop failed after merge"),
    );

    // Cleanup
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });
    } catch { /* ignore */ }
  });

  it("does not call onWarn when stash pop succeeds", () => {
    const repoDir = createTestRepo();
    const info = createWorktree(repoDir, "warn-clean", "main");

    // Worktree adds a new file (won't conflict with stash)
    writeFileSync(join(info.path, "feature.txt"), "feature content");
    execFileSync("git", ["add", "feature.txt"], { cwd: info.path, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add feature"], { cwd: info.path, stdio: "pipe" });

    // Main has uncommitted change to a different file (no conflict on pop)
    writeFileSync(join(repoDir, "README.md"), "# Dirty but safe\n");

    const onWarn = vi.fn();
    const result = mergeWorktreeBranch(repoDir, "warn-clean", "main", { onWarn });

    expect(result.merged).toBe(true);
    expect(onWarn).not.toHaveBeenCalled();

    // Cleanup
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: repoDir, stdio: "pipe" });
    } catch { /* ignore */ }
  });
});
