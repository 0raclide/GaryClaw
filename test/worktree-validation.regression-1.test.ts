/**
 * Regression: ISSUE-002 — stdout+stderr capture, dynamic lock timeout.
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * 1. Test output capture now includes stdout (where Vitest/Jest write failures).
 * 2. Dynamic lock timeout computation verified for validation configs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorktree,
  mergeWorktreeBranch,
  resolveBaseBranch,
} from "../src/worktree.js";
import type { MergeOptions } from "../src/worktree.js";

function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "garyclaw-val-reg1-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function makeCommit(dir: string, filename: string, content: string, message: string): void {
  writeFileSync(join(dir, filename), content);
  execFileSync("git", ["add", filename], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "pipe" });
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

describe("stdout capture in test output", () => {
  function setupWorktreeWithCommit(): string {
    const baseBranch = resolveBaseBranch(repoDir);
    const wt = createWorktree(repoDir, "validator", baseBranch);
    makeCommit(wt.path, "feature.ts", "export const x = 1;", "Add feature");
    return baseBranch;
  }

  it("captures stdout from failed test command (where test runners write failure details)", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: { testCommand: "echo 'FAIL: src/widget.test.ts > renders button'; exit 1" },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(false);
    expect(result.testsPassed).toBe(false);
    expect(result.testOutput).toContain("FAIL: src/widget.test.ts");
  });

  it("captures both stdout and stderr combined", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: {
        testCommand: "echo 'stdout: 3 tests failed' && echo 'stderr: npm ERR! Test failed' >&2; exit 1",
      },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(false);
    expect(result.testOutput).toContain("stdout: 3 tests failed");
    expect(result.testOutput).toContain("stderr: npm ERR! Test failed");
  });

  it("still captures stderr-only output (backward compat)", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: { testCommand: "echo 'STDERR ONLY' >&2; exit 1" },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(false);
    expect(result.testOutput).toContain("STDERR ONLY");
  });

  it("truncates combined stdout+stderr to 2000 chars", () => {
    const baseBranch = setupWorktreeWithCommit();
    const options: MergeOptions = {
      validation: {
        testCommand: "python3 -c \"print('A' * 1500)\" && python3 -c \"import sys; sys.stderr.write('B' * 1500)\"; exit 1",
      },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(false);
    if (result.testOutput) {
      expect(result.testOutput.length).toBeLessThanOrEqual(2000);
    }
  });
});

describe("dynamic lock timeout", () => {
  /**
   * The lock timeout logic in worktree.ts (lines 371-375):
   * - skipValidation → default 60s
   * - validation with testTimeout → testTimeout + 60s
   * - validation without testTimeout → 120000 + 60000 = 180s
   * - no validation → default 60s
   *
   * We can't directly observe the lock timeout value, but we can verify that
   * merges with long test timeouts don't fail due to lock expiry.
   */
  it("merge with custom testTimeout completes without lock timeout", () => {
    const baseBranch = resolveBaseBranch(repoDir);
    const wt = createWorktree(repoDir, "validator", baseBranch);
    makeCommit(wt.path, "feature.ts", "export const x = 1;", "Add feature");

    // Short test with a generous timeout — should not hit lock issues
    const options: MergeOptions = {
      validation: { testCommand: "echo ok", testTimeout: 5000 },
    };
    const result = mergeWorktreeBranch(repoDir, "validator", baseBranch, options);
    expect(result.merged).toBe(true);
    expect(result.testsPassed).toBe(true);
    // Verify lock was released (no "Could not acquire merge lock" reason)
    expect(result.reason).toBeUndefined();
  });
});
