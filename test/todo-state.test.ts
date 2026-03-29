import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  slugify,
  readTodoState,
  writeTodoState,
  findTodoState,
  detectArtifacts,
  reconcileState,
  getStartSkill,
  findNextSkill,
  skillToTodoState,
  SKILL_TO_STATE,
  PIPELINE_LIFECYCLE_ORDER,
} from "../src/todo-state.js";
import type { TodoState, DetectedArtifacts } from "../src/todo-state.js";

const BASE_DIR = join(tmpdir(), `garyclaw-todo-state-${Date.now()}`);

function makeState(overrides: Partial<TodoState> = {}): TodoState {
  return {
    title: "TODO State Tracking",
    slug: "todo-state-tracking",
    state: "open",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeArtifacts(overrides: Partial<DetectedArtifacts> = {}): DetectedArtifacts {
  return {
    branchExists: false,
    branchCommitCount: 0,
    commitsOnMain: false,
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(BASE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

// ── slugify ──────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric with hyphens", () => {
    expect(slugify("TODO State Tracking")).toBe("todo-state-tracking");
  });

  it("handles em dashes and special chars", () => {
    expect(slugify("TODO State Tracking — Artifact Detection + State Files"))
      .toBe("todo-state-tracking-artifact-detection-state-files");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("foo---bar")).toBe("foo-bar");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("--hello--world--")).toBe("hello-world");
  });

  it("truncates at word boundary when > 80 chars", () => {
    const long = "this is a very long title that should be truncated at a word boundary to prevent excessively long filenames from being created";
    const result = slugify(long);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith("-")).toBe(false);
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles all-special-char string", () => {
    expect(slugify("—+—")).toBe("");
  });

  it("is deterministic (same input → same output)", () => {
    const title = "Oracle Decision Batching";
    expect(slugify(title)).toBe(slugify(title));
  });

  it("handles numbers", () => {
    expect(slugify("Phase 5a: Memory")).toBe("phase-5a-memory");
  });
});

// ── State file I/O ───────────────────────────────────────────────

describe("readTodoState / writeTodoState", () => {
  it("round-trips state through write and read", () => {
    const state = makeState({ title: "Test Item", slug: "test-item" });
    writeTodoState(BASE_DIR, "test-item", state);
    const loaded = readTodoState(BASE_DIR, "test-item");
    expect(loaded).toEqual(state);
  });

  it("returns null for missing state file", () => {
    expect(readTodoState(BASE_DIR, "nonexistent")).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    mkdirSync(join(BASE_DIR, "todo-state"), { recursive: true });
    writeFileSync(join(BASE_DIR, "todo-state", "bad.json"), "{not valid json");
    expect(readTodoState(BASE_DIR, "bad")).toBeNull();
  });

  it("returns null for invalid schema (missing title)", () => {
    mkdirSync(join(BASE_DIR, "todo-state"), { recursive: true });
    writeFileSync(
      join(BASE_DIR, "todo-state", "invalid.json"),
      JSON.stringify({ slug: "x", state: "open", updatedAt: "2026-01-01" }),
    );
    expect(readTodoState(BASE_DIR, "invalid")).toBeNull();
  });

  it("returns null for invalid lifecycle state", () => {
    mkdirSync(join(BASE_DIR, "todo-state"), { recursive: true });
    writeFileSync(
      join(BASE_DIR, "todo-state", "bad-state.json"),
      JSON.stringify({ title: "x", slug: "x", state: "banana", updatedAt: "2026-01-01" }),
    );
    expect(readTodoState(BASE_DIR, "bad-state")).toBeNull();
  });

  it("creates directories as needed", () => {
    const nested = join(BASE_DIR, "deep", "nested");
    writeTodoState(nested, "test", makeState());
    expect(readTodoState(nested, "test")).not.toBeNull();
  });
});

// ── findTodoState with Levenshtein ──────────────────────────────

describe("findTodoState", () => {
  it("finds by exact slug match", () => {
    const state = makeState({ title: "Oracle Memory", slug: "oracle-memory" });
    writeTodoState(BASE_DIR, "oracle-memory", state);
    const found = findTodoState(BASE_DIR, "Oracle Memory");
    expect(found).toEqual(state);
  });

  it("finds by Levenshtein fallback on minor title change", () => {
    const state = makeState({ title: "TODO State Tracking", slug: "todo-state-tracking" });
    writeTodoState(BASE_DIR, "todo-state-tracking", state);

    // Slightly different title (lowercase change)
    const found = findTodoState(BASE_DIR, "Todo State Tracking");
    expect(found).toEqual(state);
  });

  it("returns null when no match exists", () => {
    writeTodoState(BASE_DIR, "oracle-memory", makeState({ title: "Oracle Memory", slug: "oracle-memory" }));
    expect(findTodoState(BASE_DIR, "Completely Different Title")).toBeNull();
  });

  it("returns null when state dir is empty", () => {
    mkdirSync(join(BASE_DIR, "todo-state"), { recursive: true });
    expect(findTodoState(BASE_DIR, "Anything")).toBeNull();
  });

  it("returns null when state dir does not exist", () => {
    expect(findTodoState(join(BASE_DIR, "nonexistent"), "Anything")).toBeNull();
  });

  it("picks closest Levenshtein match when multiple candidates exist", () => {
    writeTodoState(BASE_DIR, "oracle-memory", makeState({
      title: "Oracle Memory Infrastructure",
      slug: "oracle-memory",
      state: "designed",
    }));
    writeTodoState(BASE_DIR, "oracle-batch", makeState({
      title: "Oracle Decision Batching",
      slug: "oracle-batch",
      state: "implemented",
    }));

    const found = findTodoState(BASE_DIR, "Oracle Memory Infrastructur");
    expect(found?.slug).toBe("oracle-memory");
  });

  it("prefers exact slug match over Levenshtein", () => {
    // State file with slug "test-item" but title that's close to a different query
    writeTodoState(BASE_DIR, "test-item", makeState({
      title: "Test Item",
      slug: "test-item",
      state: "designed",
    }));
    writeTodoState(BASE_DIR, "test-items", makeState({
      title: "Test Items Extended",
      slug: "test-items",
      state: "implemented",
    }));

    const found = findTodoState(BASE_DIR, "Test Item");
    expect(found?.slug).toBe("test-item");
    expect(found?.state).toBe("designed");
  });
});

// ── getStartSkill ────────────────────────────────────────────────

describe("getStartSkill", () => {
  it("maps open → prioritize", () => {
    expect(getStartSkill(makeState({ state: "open" }))).toBe("prioritize");
  });

  it("maps designed → implement", () => {
    expect(getStartSkill(makeState({ state: "designed" }))).toBe("implement");
  });

  it("maps implemented → plan-eng-review", () => {
    expect(getStartSkill(makeState({ state: "implemented" }))).toBe("plan-eng-review");
  });

  it("maps reviewed → qa", () => {
    expect(getStartSkill(makeState({ state: "reviewed" }))).toBe("qa");
  });

  it("maps qa-complete → skip", () => {
    expect(getStartSkill(makeState({ state: "qa-complete" }))).toBe("skip");
  });

  it("maps merged → skip", () => {
    expect(getStartSkill(makeState({ state: "merged" }))).toBe("skip");
  });

  it("maps complete → skip", () => {
    expect(getStartSkill(makeState({ state: "complete" }))).toBe("skip");
  });
});

// ── findNextSkill ────────────────────────────────────────────────

describe("findNextSkill", () => {
  it("returns 0 for unknown preferred skill", () => {
    expect(findNextSkill(["prioritize", "implement"], "unknown-skill")).toBe(0);
  });

  it("skips to implement when preferred is implement", () => {
    const pipeline = ["prioritize", "office-hours", "implement", "qa"];
    expect(findNextSkill(pipeline, "implement")).toBe(2);
  });

  it("handles partial pipeline: skips to qa when preferred is plan-eng-review", () => {
    const pipeline = ["prioritize", "implement", "qa"];
    // plan-eng-review is between implement and qa in lifecycle order
    expect(findNextSkill(pipeline, "plan-eng-review")).toBe(2); // qa
  });

  it("returns pipeline.length when all skills are before preferred", () => {
    const pipeline = ["prioritize", "office-hours"];
    expect(findNextSkill(pipeline, "qa")).toBe(2);
  });

  it("returns 0 when preferred is prioritize", () => {
    const pipeline = ["prioritize", "implement", "qa"];
    expect(findNextSkill(pipeline, "prioritize")).toBe(0);
  });

  it("handles single-skill pipeline", () => {
    expect(findNextSkill(["qa"], "qa")).toBe(0);
    expect(findNextSkill(["qa"], "prioritize")).toBe(0);
    expect(findNextSkill(["prioritize"], "qa")).toBe(1);
  });
});

// ── skillToTodoState ─────────────────────────────────────────────

describe("skillToTodoState", () => {
  it("maps office-hours → designed", () => {
    expect(skillToTodoState("office-hours")).toBe("designed");
  });

  it("maps implement → implemented", () => {
    expect(skillToTodoState("implement")).toBe("implemented");
  });

  it("maps plan-eng-review → reviewed", () => {
    expect(skillToTodoState("plan-eng-review")).toBe("reviewed");
  });

  it("maps qa → qa-complete", () => {
    expect(skillToTodoState("qa")).toBe("qa-complete");
  });

  it("returns null for non-lifecycle skills", () => {
    expect(skillToTodoState("bootstrap")).toBeNull();
    expect(skillToTodoState("research")).toBeNull();
    expect(skillToTodoState("evaluate")).toBeNull();
    expect(skillToTodoState("prioritize")).toBeNull();
  });
});

// ── SKILL_TO_STATE and PIPELINE_LIFECYCLE_ORDER constants ────────

describe("constants", () => {
  it("SKILL_TO_STATE has exactly 4 entries", () => {
    expect(Object.keys(SKILL_TO_STATE)).toHaveLength(4);
  });

  it("PIPELINE_LIFECYCLE_ORDER has 5 entries in correct order", () => {
    expect(PIPELINE_LIFECYCLE_ORDER).toEqual([
      "prioritize", "office-hours", "implement", "plan-eng-review", "qa",
    ]);
  });
});

// ── reconcileState ───────────────────────────────────────────────

describe("reconcileState", () => {
  it("creates state from artifacts when no stored state exists", () => {
    const artifacts = makeArtifacts({ designDoc: "docs/designs/foo.md" });
    const result = reconcileState(null, artifacts);
    expect(result.state).toBe("designed");
    expect(result.designDocPath).toBe("docs/designs/foo.md");
  });

  it("infers 'open' when no artifacts and no stored state", () => {
    const result = reconcileState(null, makeArtifacts());
    expect(result.state).toBe("open");
  });

  it("infers 'implemented' from branch with commits", () => {
    const artifacts = makeArtifacts({ branchExists: true, branchCommitCount: 5 });
    const result = reconcileState(null, artifacts);
    expect(result.state).toBe("implemented");
  });

  it("infers 'merged' from commits on main", () => {
    const artifacts = makeArtifacts({ commitsOnMain: true });
    const result = reconcileState(null, artifacts);
    expect(result.state).toBe("merged");
  });

  it("promotes stored state when artifacts show more progress", () => {
    const stored = makeState({ state: "designed" });
    const artifacts = makeArtifacts({ branchExists: true, branchCommitCount: 3 });
    const result = reconcileState(stored, artifacts);
    expect(result.state).toBe("implemented");
  });

  it("trusts stored state when recent and artifacts show less progress", () => {
    const stored = makeState({
      state: "implemented",
      updatedAt: new Date().toISOString(), // recent
    });
    const artifacts = makeArtifacts({ designDoc: "docs/designs/foo.md" }); // only designed
    const result = reconcileState(stored, artifacts);
    expect(result.state).toBe("implemented"); // trusts stored
  });

  it("trusts stored state when stale but designed or later (never demotes)", () => {
    const twoHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const stored = makeState({
      state: "designed",
      updatedAt: twoHoursAgo,
    });
    const artifacts = makeArtifacts(); // no artifacts
    const result = reconcileState(stored, artifacts);
    expect(result.state).toBe("designed"); // never demotes from designed
  });

  it("resets stale 'implemented' to 'designed' when no branch and instance dead", () => {
    const twoHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    // Create a fake daemon dir with no PID file (instance dead)
    const checkpointDir = join(BASE_DIR, "ckpt");
    mkdirSync(join(checkpointDir, "daemons", "worker-1"), { recursive: true });

    const stored = makeState({
      state: "implemented",
      updatedAt: twoHoursAgo,
      instanceName: "worker-1",
    });
    const artifacts = makeArtifacts(); // no branch, no commits
    const result = reconcileState(stored, artifacts, checkpointDir);
    expect(result.state).toBe("designed");
  });

  it("keeps stale 'implemented' when instance has no instanceName", () => {
    const twoHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const stored = makeState({
      state: "implemented",
      updatedAt: twoHoursAgo,
      // no instanceName
    });
    const artifacts = makeArtifacts();
    const result = reconcileState(stored, artifacts);
    // Without checkpointDir, can't check instance liveness → trust B
    expect(result.state).toBe("implemented");
  });

  it("updates designDocPath when artifacts find one and stored doesn't have it", () => {
    const stored = makeState({ state: "designed" });
    const artifacts = makeArtifacts({ designDoc: "docs/designs/found.md" });
    // Same state level, but artifact has designDoc
    const result = reconcileState(stored, artifacts);
    expect(result.designDocPath).toBe("docs/designs/found.md");
  });

  it("preserves all stored fields on promotion", () => {
    const stored = makeState({
      state: "designed",
      title: "My Item",
      slug: "my-item",
      instanceName: "worker-1",
      lastJobId: "job-123",
      designDocPath: "docs/designs/my-item.md",
    });
    const artifacts = makeArtifacts({ branchExists: true, branchCommitCount: 2 });
    const result = reconcileState(stored, artifacts);
    expect(result.state).toBe("implemented");
    expect(result.title).toBe("My Item");
    expect(result.slug).toBe("my-item");
    expect(result.instanceName).toBe("worker-1");
    expect(result.lastJobId).toBe("job-123");
    expect(result.designDocPath).toBe("docs/designs/my-item.md");
  });

  it("prefers artifact designDoc over stored on promotion", () => {
    const stored = makeState({
      state: "open",
      designDocPath: undefined,
    });
    const artifacts = makeArtifacts({ designDoc: "docs/designs/new.md" });
    const result = reconcileState(stored, artifacts);
    expect(result.state).toBe("designed");
    expect(result.designDocPath).toBe("docs/designs/new.md");
  });
});

// ── detectArtifacts (mocked git) ─────────────────────────────────

describe("detectArtifacts", () => {
  it("returns empty artifacts for non-git directory", () => {
    const result = detectArtifacts(BASE_DIR, "Test Item", "test-item");
    expect(result.branchExists).toBe(false);
    expect(result.branchCommitCount).toBe(0);
    expect(result.commitsOnMain).toBe(false);
    expect(result.designDoc).toBeUndefined();
  });

  it("finds design doc by slug match", () => {
    const designDir = join(BASE_DIR, "docs", "designs");
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, "todo-state-tracking.md"), "# Design\n\nDetails here");

    const result = detectArtifacts(BASE_DIR, "TODO State Tracking", "todo-state-tracking");
    expect(result.designDoc).toBe("docs/designs/todo-state-tracking.md");
  });

  it("finds design doc by keyword match in first 5 lines", () => {
    const designDir = join(BASE_DIR, "docs", "designs");
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, "some-design.md"), "# Oracle Memory Infrastructure\n\nOracle memory details");

    const result = detectArtifacts(BASE_DIR, "Oracle Memory Infrastructure", "oracle-memory-infrastructure");
    // "oracle" and "memory" are keywords, both in first 5 lines
    expect(result.designDoc).toBe("docs/designs/some-design.md");
  });

  it("does not false-positive on single keyword match", () => {
    const designDir = join(BASE_DIR, "docs", "designs");
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, "unrelated.md"), "# Fix validation\n\nSome validation stuff");

    const result = detectArtifacts(BASE_DIR, "Semantic Validation for Bootstrap", "semantic-validation-bootstrap");
    // "validation" matches but nothing else → single keyword, not enough
    // (depends on keyword extraction — "semantic", "validation", "bootstrap" are keywords)
    // "unrelated.md" has "validation" but not "semantic" or "bootstrap"
    expect(result.designDoc).toBeUndefined();
  });
});
