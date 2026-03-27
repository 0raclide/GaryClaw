// Regression: ISSUE-002 — branchName doesn't sanitize illegal git branch chars
// Found by /qa on 2026-03-27
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md

import { describe, it, expect } from "vitest";
import { branchName, sanitizeBranchComponent } from "../src/worktree.js";

describe("sanitizeBranchComponent — illegal git chars regression", () => {
  it("strips tilde", () => {
    expect(sanitizeBranchComponent("test~bad")).toBe("test-bad");
  });

  it("strips caret", () => {
    expect(sanitizeBranchComponent("test^bad")).toBe("test-bad");
  });

  it("strips colon", () => {
    expect(sanitizeBranchComponent("test:bad")).toBe("test-bad");
  });

  it("strips backslash", () => {
    expect(sanitizeBranchComponent("test\\bad")).toBe("test-bad");
  });

  it("strips spaces", () => {
    expect(sanitizeBranchComponent("test bad")).toBe("test-bad");
  });

  it("strips @{ sequence", () => {
    expect(sanitizeBranchComponent("test@{bad")).toBe("test-bad");
  });

  it("collapses double-dot sequences", () => {
    expect(sanitizeBranchComponent("test..bad")).toBe("test.bad");
  });

  it("removes .lock suffix", () => {
    expect(sanitizeBranchComponent("test.lock")).toBe("test-lock");
  });

  it("removes leading dot", () => {
    expect(sanitizeBranchComponent(".test")).toBe("test");
  });

  it("removes trailing dot", () => {
    expect(sanitizeBranchComponent("test.")).toBe("test");
  });

  it("handles multiple illegal chars", () => {
    const result = sanitizeBranchComponent("my~bad^name:here");
    expect(result).toBe("my-bad-name-here");
  });

  it("passes through clean names unchanged", () => {
    expect(sanitizeBranchComponent("review-bot")).toBe("review-bot");
    expect(sanitizeBranchComponent("builder")).toBe("builder");
    expect(sanitizeBranchComponent("qa-runner-2")).toBe("qa-runner-2");
  });

  it("collapses repeated dashes from multiple replacements", () => {
    expect(sanitizeBranchComponent("a~~b")).toBe("a-b");
  });
});

describe("branchName — sanitization integration", () => {
  it("sanitizes illegal chars in the instance name portion", () => {
    expect(branchName("test~bot")).toBe("garyclaw/test-bot");
  });

  it("preserves valid instance names", () => {
    expect(branchName("review-bot")).toBe("garyclaw/review-bot");
  });

  it("handles control chars", () => {
    const result = branchName("bad\x00name");
    expect(result).toBe("garyclaw/bad-name");
  });
});
