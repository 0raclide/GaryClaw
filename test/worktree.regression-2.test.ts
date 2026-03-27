/**
 * Regression: ISSUE-001/002 — sanitizeBranchComponent empty output and slash passthrough
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 *
 * Previously, sanitizeBranchComponent("") returned "" and branchName("")
 * returned "garyclaw/" which git rejects as invalid. Forward slashes also
 * passed through, creating nested ref paths.
 */

import { describe, it, expect } from "vitest";
import { sanitizeBranchComponent, branchName } from "../src/worktree.js";

describe("sanitizeBranchComponent degenerate inputs", () => {
  it("throws on empty string", () => {
    expect(() => sanitizeBranchComponent("")).toThrow("Cannot sanitize");
  });

  it("throws on all-dots input", () => {
    expect(() => sanitizeBranchComponent("...")).toThrow("Cannot sanitize");
  });

  it("throws on all-whitespace input", () => {
    expect(() => sanitizeBranchComponent("   ")).toThrow("Cannot sanitize");
  });

  it("throws on all-control-chars input", () => {
    expect(() => sanitizeBranchComponent("\x00\x01\x02")).toThrow("Cannot sanitize");
  });
});

describe("sanitizeBranchComponent slash handling", () => {
  it("converts forward slashes to dashes", () => {
    expect(sanitizeBranchComponent("a/b/c")).toBe("a-b-c");
  });

  it("collapses multiple slashes to single dash", () => {
    expect(sanitizeBranchComponent("a//b")).toBe("a-b");
  });

  it("handles mixed slashes and other illegal chars", () => {
    expect(sanitizeBranchComponent("a/b:c~d")).toBe("a-b-c-d");
  });

  it("normal names unchanged", () => {
    expect(sanitizeBranchComponent("review-bot")).toBe("review-bot");
    expect(sanitizeBranchComponent("test_123")).toBe("test_123");
    expect(sanitizeBranchComponent("my.instance")).toBe("my.instance");
  });
});

describe("branchName with sanitized components", () => {
  it("produces valid branch for slash-containing input", () => {
    expect(branchName("a/b/c")).toBe("garyclaw/a-b-c");
  });

  it("throws for empty input via sanitize", () => {
    expect(() => branchName("")).toThrow("Cannot sanitize");
  });
});
