/**
 * Worktree validation gate tests — test gate pass/fail/timeout, skip flag,
 * custom command, test output capture, worktree dir execution, backward compat.
 *
 * Uses real git repos in temp directories (same pattern as worktree.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorktree,
  mergeWorktreeBranch,
  resolveBaseBranch,
} from "../src/worktree.js";
import type { MergeOptions } from "../src/worktree.js";

/** Create a temp git repo with an initial commit. */
function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "garyclaw-val-test-"));
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

describe("mergeWorktreeBranch with validation", () => {
  function setupWorktreeWithCommit(): string {
    const baseBranch = resolveBaseBranch(repoDir);
    const wt = createWorktree(repoDir, "validator", baseBranch);
    makeCommit(wt.path, "feature.ts", "export const x = 1;", "Add feature");
    return baseBranch;
  }

  it("backward compat: no options = no tests, merge proceeds", () => {
    const baseBranch = setupWorktreeWithCommit();
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch);
    expect(result.merged).toBe(true);
    expect(result.commitCount).toBe(1);
    expect(result.testsPassed).toBeUndefined();
    expect(result.testDurationMs).toBeUndefined();
  });

  it("skipValidation = true skips tests, merge proceeds", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: { skipValidation: true },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(true);
    expect(result.testsPassed).toBeUndefined();
  });

  it("tests pass → merge succeeds with testsPassed=true", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: { testCommand: "echo tests-pass" },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(true);
    expect(result.testsPassed).toBe(true);
    expect(result.testDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.commitCount).toBe(1);
  });

  it("tests fail → merge blocked with testsPassed=false", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: { testCommand: "exit 1" },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(false);
    expect(result.testsPassed).toBe(false);
    expect(result.reason).toBe("Pre-merge tests failed");
    expect(result.testDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.commitCount).toBe(1);
  });

  it("test output captured in testOutput (stderr)", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: { testCommand: "echo 'FAIL: broken test' >&2; exit 1" },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(false);
    expect(result.testOutput).toContain("FAIL: broken test");
  });

  it("test output truncated to 2000 chars", () => {
    const baseBranch = setupWorktreeWithCommit();
    // Generate > 2000 chars of stderr
    const options: MergeOptions = {
      validation: { testCommand: "python3 -c \"import sys; sys.stderr.write('X' * 5000)\" ; exit 1" },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(false);
    if (result.testOutput) {
      expect(result.testOutput.length).toBeLessThanOrEqual(2000);
    }
  });

  it("test timeout aborts and blocks merge", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: { testCommand: "sleep 10", testTimeout: 500 },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(false);
    expect(result.testsPassed).toBe(false);
    expect(result.reason).toBe("Pre-merge tests failed");
  });

  it("custom test command runs in worktree directory", () => {
    const baseBranch = setupWorktreeWithCommit();
    // The worktree should have feature.ts, main repo should not
    const options: MergeOptions = {
      validation: { testCommand: "test -f feature.ts" },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(true);
    expect(result.testsPassed).toBe(true);
  });

  it("compound test command works (&&)", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: { testCommand: "echo lint-ok && echo test-ok" },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(true);
    expect(result.testsPassed).toBe(true);
  });

  it("default test command is npm test (fails gracefully if no package.json)", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: { testTimeout: 5000 }, // default: npm test
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    // npm test will fail since there's no package.json — that's expected
    expect(result.merged).toBe(false);
    expect(result.testsPassed).toBe(false);
  });

  it("rebase conflict still returns correct reason (not test failure)", () => {
    const baseBranch = resolveBaseBranch(repoDir);
    const wt = createWorktree(repoDir, "validator", baseBranch);
    // Make conflicting commits on both branches
    makeCommit(repoDir, "conflict.txt", "main version", "Main commit");
    makeCommit(wt.path, "conflict.txt", "branch version", "Branch commit");

    const options: MergeOptions = {
      validation: { testCommand: "echo should-not-run" },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(false);
    expect(result.reason).toContain("conflicts");
    expect(result.testsPassed).toBeUndefined(); // tests never ran
  });

  it("failed tests do NOT abort the rebase (branch stays rebased)", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: { testCommand: "exit 1" },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(false);

    // The branch should still have the commit (rebase succeeded, merge skipped)
    const branchLog = execFileSync(
      "git", ["log", "--oneline", "garyclaw/validator"],
      { cwd: repoDir, stdio: "pipe", encoding: "utf-8" },
    ).trim();
    expect(branchLog).toContain("Add feature");
  });

  it("zero commits = already up to date, no tests run", () => {
    const baseBranch = resolveBaseBranch(repoDir);
    createWorktree(repoDir, "validator", baseBranch);
    // No commits on worktree branch

    const options: MergeOptions = {
      validation: { testCommand: "exit 1" }, // would fail if run
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(true);
    expect(result.commitCount).toBe(0);
    expect(result.testsPassed).toBeUndefined(); // tests not run for 0-commit merge
  });
});
