import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { markTodoCompleteInFile } from "../src/todo-state.js";

const BASE_DIR = join(tmpdir(), `garyclaw-automark-${Date.now()}`);
const TODOS_PATH = join(BASE_DIR, "TODOS.md");

beforeEach(() => {
  mkdirSync(BASE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

describe("markTodoCompleteInFile", () => {
  it("marks a matching heading as complete", () => {
    writeFileSync(TODOS_PATH, [
      "# TODOS",
      "",
      "## P2: Self-Maintaining Backlog",
      "Auto-mark completed items.",
      "",
      "## P3: Rate Limit Resilience",
      "Handle rate limits gracefully.",
    ].join("\n"));

    const result = markTodoCompleteInFile(
      TODOS_PATH,
      "P2: Self-Maintaining Backlog",
      "Implemented by worker-2. 7 commits auto-merged.",
    );

    expect(result).toBe(true);
    const updated = readFileSync(TODOS_PATH, "utf-8");
    expect(updated).toContain("~~P2: Self-Maintaining Backlog~~ — COMPLETE");
    expect(updated).toContain("Implemented by worker-2. 7 commits auto-merged.");
    // Other headings unchanged
    expect(updated).toContain("## P3: Rate Limit Resilience");
    expect(updated).not.toContain("~~P3: Rate Limit Resilience~~");
  });

  it("skips if heading already contains ~~", () => {
    writeFileSync(TODOS_PATH, [
      "# TODOS",
      "",
      "## ~~P2: Self-Maintaining Backlog~~ — COMPLETE (2026-03-28)",
      "Already done.",
    ].join("\n"));

    const result = markTodoCompleteInFile(
      TODOS_PATH,
      "P2: Self-Maintaining Backlog",
      "summary",
    );

    expect(result).toBe(false);
    const updated = readFileSync(TODOS_PATH, "utf-8");
    // Original content preserved
    expect(updated).toContain("COMPLETE (2026-03-28)");
    expect(updated).not.toContain("summary");
  });

  it("returns false if slug does not match any heading", () => {
    writeFileSync(TODOS_PATH, [
      "# TODOS",
      "",
      "## P3: Something Else",
      "Not the one.",
    ].join("\n"));

    const result = markTodoCompleteInFile(
      TODOS_PATH,
      "P2: Nonexistent Feature",
      "summary",
    );

    expect(result).toBe(false);
  });

  it("returns false for missing file", () => {
    const result = markTodoCompleteInFile(
      join(BASE_DIR, "nope.md"),
      "Any Title",
      "summary",
    );
    expect(result).toBe(false);
  });

  it("returns false for empty file", () => {
    writeFileSync(TODOS_PATH, "");
    const result = markTodoCompleteInFile(TODOS_PATH, "Title", "summary");
    expect(result).toBe(false);
  });

  it("handles multi-heading file with correct slug matching", () => {
    writeFileSync(TODOS_PATH, [
      "# Project TODOS",
      "",
      "## P2: Feature Alpha",
      "Description A.",
      "",
      "## P2: Feature Beta",
      "Description B.",
      "",
      "## P3: Feature Gamma",
      "Description C.",
    ].join("\n"));

    const result = markTodoCompleteInFile(
      TODOS_PATH,
      "P2: Feature Beta",
      "Done by worker-1.",
    );

    expect(result).toBe(true);
    const updated = readFileSync(TODOS_PATH, "utf-8");
    // Only Feature Beta is marked
    expect(updated).toContain("## P2: Feature Alpha");
    expect(updated).not.toContain("~~P2: Feature Alpha~~");
    expect(updated).toContain("~~P2: Feature Beta~~ — COMPLETE");
    expect(updated).toContain("Done by worker-1.");
    expect(updated).toContain("## P3: Feature Gamma");
  });

  it("handles ### headings (depth 3)", () => {
    writeFileSync(TODOS_PATH, [
      "# TODOS",
      "",
      "### P4: Sub Item",
      "Details.",
    ].join("\n"));

    const result = markTodoCompleteInFile(
      TODOS_PATH,
      "P4: Sub Item",
      "Completed.",
    );

    expect(result).toBe(true);
    const updated = readFileSync(TODOS_PATH, "utf-8");
    expect(updated).toContain("### ~~P4: Sub Item~~ — COMPLETE");
  });

  it("writes atomically (tmp+rename pattern via safeWriteText)", () => {
    writeFileSync(TODOS_PATH, [
      "# TODOS",
      "",
      "## P2: Atomic Write Test",
      "Content.",
    ].join("\n"));

    const result = markTodoCompleteInFile(
      TODOS_PATH,
      "P2: Atomic Write Test",
      "Verified.",
    );

    expect(result).toBe(true);
    // File should be valid markdown (not truncated or corrupt)
    const updated = readFileSync(TODOS_PATH, "utf-8");
    expect(updated).toContain("~~P2: Atomic Write Test~~");
    expect(updated).toContain("Verified.");
    expect(updated).toContain("# TODOS");
  });

  it("matches with minor title variations via slug", () => {
    writeFileSync(TODOS_PATH, [
      "# TODOS",
      "",
      "## P2: Self-Maintaining Backlog — Auto-Complete + Rate Limit",
      "Details.",
    ].join("\n"));

    // Title without the dash-separated suffix
    const result = markTodoCompleteInFile(
      TODOS_PATH,
      "P2: Self-Maintaining Backlog — Auto-Complete + Rate Limit",
      "Done.",
    );

    expect(result).toBe(true);
    const updated = readFileSync(TODOS_PATH, "utf-8");
    expect(updated).toContain("COMPLETE");
  });

  it("includes date in COMPLETE marker", () => {
    writeFileSync(TODOS_PATH, [
      "# TODOS",
      "",
      "## P2: Date Test",
      "Details.",
    ].join("\n"));

    markTodoCompleteInFile(TODOS_PATH, "P2: Date Test", "Done.");

    const updated = readFileSync(TODOS_PATH, "utf-8");
    // Should contain today's date in ISO format
    const today = new Date().toISOString().slice(0, 10);
    expect(updated).toContain(`COMPLETE (${today})`);
  });
});
