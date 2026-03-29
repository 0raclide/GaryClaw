/**
 * Merge audit log tests — append, read, truncation, JSONL format,
 * instance isolation, missing dir creation.
 *
 * Uses temp directories with synthetic data (no real git repos needed).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendMergeAudit } from "../src/worktree.js";
import type { MergeResult, MergeOptions, MergeAuditEntry } from "../src/worktree.js";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "garyclaw-audit-test-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function readAuditEntries(instanceName: string, auditDir?: string): MergeAuditEntry[] {
  const dir = auditDir ?? join(testDir, ".garyclaw", "daemons", instanceName);
  const filePath = join(dir, "merge-audit.jsonl");
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("appendMergeAudit", () => {
  it("creates parent directory and writes JSONL entry", () => {
    const result: MergeResult = { merged: true, commitCount: 3 };
    appendMergeAudit(testDir, "builder", "garyclaw/builder", "main", result);

    const entries = readAuditEntries("builder");
    expect(entries).toHaveLength(1);
    expect(entries[0].instanceName).toBe("builder");
    expect(entries[0].branch).toBe("garyclaw/builder");
    expect(entries[0].baseBranch).toBe("main");
    expect(entries[0].commitCount).toBe(3);
    expect(entries[0].merged).toBe(true);
    expect(entries[0].timestamp).toBeTruthy();
  });

  it("appends multiple entries to the same file", () => {
    const result1: MergeResult = { merged: true, commitCount: 2 };
    const result2: MergeResult = { merged: false, reason: "conflict", commitCount: 1 };

    appendMergeAudit(testDir, "builder", "garyclaw/builder", "main", result1);
    appendMergeAudit(testDir, "builder", "garyclaw/builder", "main", result2);

    const entries = readAuditEntries("builder");
    expect(entries).toHaveLength(2);
    expect(entries[0].merged).toBe(true);
    expect(entries[1].merged).toBe(false);
    expect(entries[1].reason).toBe("conflict");
  });

  it("records test results when present", () => {
    const result: MergeResult = {
      merged: false,
      reason: "Pre-merge tests failed",
      testsPassed: false,
      testOutput: "Error: 2 tests failed",
      testDurationMs: 34567,
      commitCount: 5,
    };
    appendMergeAudit(testDir, "worker-1", "garyclaw/worker-1", "main", result);

    const entries = readAuditEntries("worker-1");
    expect(entries[0].testsPassed).toBe(false);
    expect(entries[0].testOutput).toBe("Error: 2 tests failed");
    expect(entries[0].testDurationMs).toBe(34567);
  });

  it("records jobId from options", () => {
    const result: MergeResult = { merged: true, commitCount: 1 };
    const options: MergeOptions = { jobId: "job-123-abc" };
    appendMergeAudit(testDir, "builder", "garyclaw/builder", "main", result, options);

    const entries = readAuditEntries("builder");
    expect(entries[0].jobId).toBe("job-123-abc");
  });

  it("truncates testOutput to 2000 chars", () => {
    const longOutput = "X".repeat(5000);
    const result: MergeResult = {
      merged: false,
      testsPassed: false,
      testOutput: longOutput,
      commitCount: 1,
    };
    appendMergeAudit(testDir, "builder", "garyclaw/builder", "main", result);

    const entries = readAuditEntries("builder");
    expect(entries[0].testOutput!.length).toBeLessThanOrEqual(2000);
  });

  it("uses auditDir override when provided", () => {
    const customDir = join(testDir, "custom-audit");
    mkdirSync(customDir, { recursive: true });

    const result: MergeResult = { merged: true, commitCount: 1 };
    const options: MergeOptions = { auditDir: customDir };
    appendMergeAudit(testDir, "builder", "garyclaw/builder", "main", result, options);

    const entries = readAuditEntries("builder", customDir);
    expect(entries).toHaveLength(1);

    // Default location should NOT have entries
    const defaultEntries = readAuditEntries("builder");
    expect(defaultEntries).toHaveLength(0);
  });

  it("isolates entries per instance", () => {
    const result: MergeResult = { merged: true, commitCount: 1 };
    appendMergeAudit(testDir, "worker-1", "garyclaw/worker-1", "main", result);
    appendMergeAudit(testDir, "worker-2", "garyclaw/worker-2", "main", result);

    expect(readAuditEntries("worker-1")).toHaveLength(1);
    expect(readAuditEntries("worker-2")).toHaveLength(1);
  });

  it("defaults commitCount to 0 when undefined in result", () => {
    const result: MergeResult = { merged: false, reason: "branch missing" };
    appendMergeAudit(testDir, "builder", "garyclaw/builder", "main", result);

    const entries = readAuditEntries("builder");
    expect(entries[0].commitCount).toBe(0);
  });

  it("does not throw on write failure (best effort)", () => {
    // Use a path that can't be created (file as parent dir)
    const badRepoDir = join(testDir, "not-a-dir");
    // Write a file at that path so mkdir will fail
    const fs = require("node:fs");
    fs.writeFileSync(join(testDir, "not-a-dir"), "file");

    const result: MergeResult = { merged: true, commitCount: 1 };
    // Should not throw
    expect(() => {
      appendMergeAudit(badRepoDir, "builder", "garyclaw/builder", "main", result);
    }).not.toThrow();
  });

  it("writes valid JSONL (each line is valid JSON)", () => {
    const result: MergeResult = { merged: true, commitCount: 2 };
    appendMergeAudit(testDir, "builder", "garyclaw/builder", "main", result);
    appendMergeAudit(testDir, "builder", "garyclaw/builder", "main", result);

    const filePath = join(testDir, ".garyclaw", "daemons", "builder", "merge-audit.jsonl");
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("omits undefined optional fields in JSON output", () => {
    const result: MergeResult = { merged: true, commitCount: 1 };
    appendMergeAudit(testDir, "builder", "garyclaw/builder", "main", result);

    const filePath = join(testDir, ".garyclaw", "daemons", "builder", "merge-audit.jsonl");
    const raw = readFileSync(filePath, "utf-8").trim();
    const parsed = JSON.parse(raw);
    // testsPassed, testOutput, testDurationMs should not be present (undefined → omitted)
    expect("testsPassed" in parsed).toBe(false);
    expect("testOutput" in parsed).toBe(false);
    expect("testDurationMs" in parsed).toBe(false);
  });
});
