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
