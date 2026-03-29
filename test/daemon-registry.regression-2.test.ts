/**
 * Regression: getCompletedTodoTitles — todo-state/ directory scan coverage.
 *
 * The daemon-registry.test.ts suite covers the daemon-state.json job scan path,
 * but not the todo-state/ directory scan (lines 354-367) which picks up
 * merged/complete items that survive instance cleanup.
 *
 * Found by /plan-eng-review on 2026-03-29
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCompletedTodoTitles } from "../src/daemon-registry.js";

const TEST_DIR = join(process.cwd(), ".test-registry-todostate-tmp");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  // Create daemons dir so the function doesn't bail early
  mkdirSync(join(TEST_DIR, "daemons"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("getCompletedTodoTitles — todo-state/ scan", () => {
  it("picks up merged items from todo-state/ directory", () => {
    const todoDir = join(TEST_DIR, "todo-state");
    mkdirSync(todoDir, { recursive: true });
    writeFileSync(
      join(todoDir, "fix-auto-merge.json"),
      JSON.stringify({ title: "Fix auto-merge", slug: "fix-auto-merge", state: "merged", updatedAt: "2026-03-29T00:00:00Z" }),
    );

    const titles = getCompletedTodoTitles(TEST_DIR);
    expect(titles.has("Fix auto-merge")).toBe(true);
  });

  it("picks up complete items from todo-state/ directory", () => {
    const todoDir = join(TEST_DIR, "todo-state");
    mkdirSync(todoDir, { recursive: true });
    writeFileSync(
      join(todoDir, "add-dashboard.json"),
      JSON.stringify({ title: "Add dashboard", slug: "add-dashboard", state: "complete", updatedAt: "2026-03-29T00:00:00Z" }),
    );

    const titles = getCompletedTodoTitles(TEST_DIR);
    expect(titles.has("Add dashboard")).toBe(true);
  });

  it("ignores non-merged/non-complete items in todo-state/", () => {
    const todoDir = join(TEST_DIR, "todo-state");
    mkdirSync(todoDir, { recursive: true });
    writeFileSync(
      join(todoDir, "in-progress.json"),
      JSON.stringify({ title: "In progress item", slug: "in-progress", state: "implemented", updatedAt: "2026-03-29T00:00:00Z" }),
    );
    writeFileSync(
      join(todoDir, "open-item.json"),
      JSON.stringify({ title: "Open item", slug: "open-item", state: "open", updatedAt: "2026-03-29T00:00:00Z" }),
    );

    const titles = getCompletedTodoTitles(TEST_DIR);
    expect(titles.size).toBe(0);
  });

  it("merges todo-state/ titles with daemon-state.json job titles", () => {
    // daemon-state job
    const instanceDir = join(TEST_DIR, "daemons", "worker-1");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(
      join(instanceDir, "daemon-state.json"),
      JSON.stringify({
        version: 1,
        jobs: [{ id: "job-1", status: "complete", claimedTodoTitle: "From daemon job", skills: ["qa"], triggeredBy: "manual", createdAt: "2026-03-29T00:00:00Z" }],
      }),
    );

    // todo-state file
    const todoDir = join(TEST_DIR, "todo-state");
    mkdirSync(todoDir, { recursive: true });
    writeFileSync(
      join(todoDir, "from-state-file.json"),
      JSON.stringify({ title: "From state file", slug: "from-state-file", state: "merged", updatedAt: "2026-03-29T00:00:00Z" }),
    );

    const titles = getCompletedTodoTitles(TEST_DIR);
    expect(titles.size).toBe(2);
    expect(titles.has("From daemon job")).toBe(true);
    expect(titles.has("From state file")).toBe(true);
  });

  it("handles missing todo-state/ directory gracefully", () => {
    // No todo-state dir, no daemon instances with jobs
    const titles = getCompletedTodoTitles(TEST_DIR);
    expect(titles.size).toBe(0);
  });

  it("skips corrupt JSON files in todo-state/", () => {
    const todoDir = join(TEST_DIR, "todo-state");
    mkdirSync(todoDir, { recursive: true });
    writeFileSync(join(todoDir, "corrupt.json"), "not valid json{{{");
    writeFileSync(
      join(todoDir, "valid.json"),
      JSON.stringify({ title: "Valid item", slug: "valid", state: "merged", updatedAt: "2026-03-29T00:00:00Z" }),
    );

    const titles = getCompletedTodoTitles(TEST_DIR);
    expect(titles.size).toBe(1);
    expect(titles.has("Valid item")).toBe(true);
  });

  it("skips todo-state files missing title field", () => {
    const todoDir = join(TEST_DIR, "todo-state");
    mkdirSync(todoDir, { recursive: true });
    writeFileSync(
      join(todoDir, "no-title.json"),
      JSON.stringify({ slug: "no-title", state: "merged", updatedAt: "2026-03-29T00:00:00Z" }),
    );

    const titles = getCompletedTodoTitles(TEST_DIR);
    expect(titles.size).toBe(0);
  });
});
