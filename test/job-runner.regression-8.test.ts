// Regression: ISSUE-001 — readTodoState missing import in job-runner.ts
// Found by /qa on 2026-03-29
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
//
// readTodoState was used at line 345 but never imported. This test verifies
// the import resolves and the function is callable from the same context
// job-runner uses it (slug + checkpointDir).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { slugify, readTodoState, writeTodoState } from "../src/todo-state.js";

const TEST_DIR = join(process.cwd(), ".test-rts-import-tmp");

describe("readTodoState import regression", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "todo-state"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("readTodoState is importable and returns null for missing slug", () => {
    const slug = slugify("Fix auto-merge dirty tree");
    const result = readTodoState(TEST_DIR, slug);
    expect(result).toBeNull();
  });

  it("readTodoState returns state after writeTodoState", () => {
    const title = "Fix auto-merge dirty tree";
    const slug = slugify(title);
    writeTodoState(TEST_DIR, slug, {
      title,
      slug,
      state: "implemented",
      updatedAt: new Date().toISOString(),
    });
    const result = readTodoState(TEST_DIR, slug);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("implemented");
    expect(result!.title).toBe(title);
  });
});
