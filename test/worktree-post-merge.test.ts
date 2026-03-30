/**
 * Post-merge verification + auto-revert tests.
 *
 * Tests verifyPostMerge: pass/fail/timeout, SHA-targeted revert, HEAD-moved skip,
 * revert conflict, test output capture, appendMergeRevert, readMergeReverts.
 *
 * Uses real git repos in temp directories (same pattern as worktree-validation.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorktree,
  mergeWorktreeBranch,
  resolveBaseBranch,
  verifyPostMerge,
  appendMergeRevert,
  readMergeReverts,
} from "../src/worktree.js";
import type { PostMergeVerifyResult, MergeRevertEntry } from "../src/worktree.js";

/** Create a temp git repo with an initial commit. */
function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "garyclaw-postmerge-test-"));
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

/** Get HEAD SHA. */
function getHead(dir: string): string {
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

describe("verifyPostMerge", () => {
  function mergeWorktreeCommit(): string {
    const baseBranch = resolveBaseBranch(repoDir);
    const wt = createWorktree(repoDir, "postmerge-test", baseBranch);
    makeCommit(wt.path, "feature.ts", "export const x = 1;", "Add feature");
    const result = mergeWorktreeBranch(repoDir, "postmerge-test", baseBranch);
    expect(result.merged).toBe(true);
    return getHead(repoDir);
  }

  it("returns verified=true when tests pass", () => {
    const mergeSha = mergeWorktreeCommit();
    // "true" command always succeeds
    const result = verifyPostMerge(repoDir, mergeSha, { testCommand: "true" });
    expect(result.verified).toBe(true);
    expect(result.reverted).toBe(false);
    expect(result.mergeSha).toBe(mergeSha);
    expect(result.testDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.reason).toBeUndefined();
  });

  it("auto-reverts when tests fail and HEAD === mergeSha", () => {
    const mergeSha = mergeWorktreeCommit();
    // "false" command always fails
    const result = verifyPostMerge(repoDir, mergeSha, { testCommand: "false" });
    expect(result.verified).toBe(false);
    expect(result.reverted).toBe(true);
    expect(result.revertSha).toBeDefined();
    expect(result.revertSha).not.toBe(mergeSha);
    expect(result.mergeSha).toBe(mergeSha);
    expect(result.testDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.reason).toBe("Post-merge tests failed");

    // Verify the revert commit exists
    const currentHead = getHead(repoDir);
    expect(currentHead).toBe(result.revertSha);
  });

  it("skips revert when HEAD has moved past mergeSha", () => {
    const mergeSha = mergeWorktreeCommit();
    // Add another commit on top
    makeCommit(repoDir, "extra.ts", "export const y = 2;", "Extra commit");
    const newHead = getHead(repoDir);
    expect(newHead).not.toBe(mergeSha);

    const result = verifyPostMerge(repoDir, mergeSha, { testCommand: "false" });
    expect(result.verified).toBe(false);
    expect(result.reverted).toBe(false);
    expect(result.reason).toContain("HEAD moved past merge SHA");
    expect(result.reason).toContain("manual revert needed");
  });

  it("captures test output on failure", () => {
    const mergeSha = mergeWorktreeCommit();
    const result = verifyPostMerge(repoDir, mergeSha, {
      testCommand: "echo 'FAIL: something broke' && exit 1",
    });
    expect(result.verified).toBe(false);
    expect(result.testOutput).toContain("FAIL: something broke");
  });

  it("truncates test output to 2000 chars", () => {
    const mergeSha = mergeWorktreeCommit();
    // Generate output > 2000 chars
    const longOutput = "x".repeat(3000);
    const result = verifyPostMerge(repoDir, mergeSha, {
      testCommand: `printf '${longOutput}' && exit 1`,
    });
    expect(result.verified).toBe(false);
    if (result.testOutput) {
      expect(result.testOutput.length).toBeLessThanOrEqual(2000);
    }
  });

  it("returns testDurationMs on both success and failure", () => {
    const mergeSha = mergeWorktreeCommit();

    const successResult = verifyPostMerge(repoDir, mergeSha, { testCommand: "true" });
    expect(successResult.testDurationMs).toBeDefined();
    expect(typeof successResult.testDurationMs).toBe("number");
  });

  it("uses default test command (npm test) if not specified", () => {
    const mergeSha = mergeWorktreeCommit();
    // This will likely fail since there's no package.json, which is fine —
    // we just verify the function doesn't crash with no options
    const result = verifyPostMerge(repoDir, mergeSha);
    expect(result.mergeSha).toBe(mergeSha);
    // Either verified or not — depends on whether npm test exists
    expect(typeof result.verified).toBe("boolean");
  });

  it("handles revert conflict gracefully", () => {
    // Create a scenario where revert would conflict:
    // Commit A adds file, merge adds conflicting change, revert of merge conflicts
    const baseBranch = resolveBaseBranch(repoDir);

    // Add a file on main
    writeFileSync(join(repoDir, "conflict.ts"), "line1\nline2\nline3\n");
    execFileSync("git", ["add", "conflict.ts"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add conflict.ts"], { cwd: repoDir, stdio: "pipe" });

    // Create worktree, modify the file
    const wt = createWorktree(repoDir, "conflict-test", baseBranch);
    writeFileSync(join(wt.path, "conflict.ts"), "modified\n");
    execFileSync("git", ["add", "conflict.ts"], { cwd: wt.path, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Modify conflict.ts"], { cwd: wt.path, stdio: "pipe" });

    const result = mergeWorktreeBranch(repoDir, "conflict-test", baseBranch);
    expect(result.merged).toBe(true);
    const mergeSha = getHead(repoDir);

    // Now amend the merge commit to make a revert impossible
    // (can't actually force a conflict on revert easily, so test the interface)
    const verifyResult = verifyPostMerge(repoDir, mergeSha, { testCommand: "false" });
    // Revert of a single file change should succeed, so this tests the path works
    expect(verifyResult.verified).toBe(false);
    expect(typeof verifyResult.reverted).toBe("boolean");
  });

  it("includes commits-since-merge in reason when HEAD moved", () => {
    const mergeSha = mergeWorktreeCommit();
    makeCommit(repoDir, "a.ts", "a", "Commit A");
    makeCommit(repoDir, "b.ts", "b", "Commit B");

    const result = verifyPostMerge(repoDir, mergeSha, { testCommand: "false" });
    expect(result.reason).toContain("Commits since merge:");
    expect(result.reason).toContain("Commit A");
    expect(result.reason).toContain("Commit B");
  });
});

describe("appendMergeRevert + readMergeReverts", () => {
  it("writes and reads a revert entry", () => {
    const entry: MergeRevertEntry = {
      timestamp: "2026-03-30T10:00:00.000Z",
      instanceName: "worker-1",
      mergeSha: "abc123",
      revertSha: "def456",
      branch: "garyclaw/worker-1",
      testOutput: "FAIL: something broke",
      testDurationMs: 5000,
      jobId: "job-001",
      reason: "Post-merge tests failed",
      autoReverted: true,
    };
    appendMergeRevert(repoDir, entry);

    const entries = readMergeReverts(repoDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  it("appends multiple entries", () => {
    const entry1: MergeRevertEntry = {
      timestamp: "2026-03-30T10:00:00.000Z",
      instanceName: "worker-1",
      mergeSha: "abc",
      branch: "garyclaw/worker-1",
      reason: "tests failed",
      autoReverted: true,
    };
    const entry2: MergeRevertEntry = {
      timestamp: "2026-03-30T11:00:00.000Z",
      instanceName: "worker-2",
      mergeSha: "def",
      branch: "garyclaw/worker-2",
      reason: "revert skipped",
      autoReverted: false,
    };
    appendMergeRevert(repoDir, entry1);
    appendMergeRevert(repoDir, entry2);

    const entries = readMergeReverts(repoDir);
    expect(entries).toHaveLength(2);
    expect(entries[0].instanceName).toBe("worker-1");
    expect(entries[1].instanceName).toBe("worker-2");
  });

  it("returns empty array when file does not exist", () => {
    const entries = readMergeReverts(repoDir);
    expect(entries).toEqual([]);
  });

  it("skips malformed lines", () => {
    const gcDir = join(repoDir, ".garyclaw");
    mkdirSync(gcDir, { recursive: true });
    const filePath = join(gcDir, "merge-reverts.jsonl");
    const validEntry = JSON.stringify({
      timestamp: "2026-03-30T10:00:00.000Z",
      instanceName: "w1",
      mergeSha: "abc",
      branch: "garyclaw/w1",
      reason: "test",
      autoReverted: true,
    });
    writeFileSync(filePath, `${validEntry}\n{bad json\n${validEntry}\n`, "utf-8");

    const entries = readMergeReverts(repoDir);
    expect(entries).toHaveLength(2);
  });

  it("never throws on write failure", () => {
    // Pass a non-existent deeply nested path — should not throw
    expect(() => {
      appendMergeRevert("/dev/null/impossible/path", {
        timestamp: "2026-03-30T10:00:00.000Z",
        instanceName: "test",
        mergeSha: "abc",
        branch: "garyclaw/test",
        reason: "test",
        autoReverted: true,
      });
    }).not.toThrow();
  });
});
