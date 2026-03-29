// Regression: ISSUE-003 — checkOrphanedTodoState had zero test coverage
// Found by /qa on 2026-03-29
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import {
  checkOrphanedTodoState,
  type DoctorOptions,
} from "../src/doctor.js";
import { safeWriteJSON } from "../src/safe-json.js";

const TEST_DIR = join(process.cwd(), ".test-doctor-orphan-tmp");
const GARYCLAW_DIR = join(TEST_DIR, ".garyclaw");
const TODO_STATE_DIR = join(GARYCLAW_DIR, "todo-state");

function defaultOptions(overrides?: Partial<DoctorOptions>): DoctorOptions {
  return {
    projectDir: TEST_DIR,
    fix: false,
    skipAuth: true,
    ...overrides,
  };
}

describe("checkOrphanedTodoState", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("PASS when no todo-state directory exists", () => {
    const result = checkOrphanedTodoState(defaultOptions());
    expect(result.status).toBe("PASS");
    expect(result.name).toBe("Orphaned TODO State");
    expect(result.message).toBe("No todo-state directory found");
  });

  it("PASS when todo-state directory is empty", () => {
    mkdirSync(TODO_STATE_DIR, { recursive: true });
    const result = checkOrphanedTodoState(defaultOptions());
    expect(result.status).toBe("PASS");
    expect(result.message).toBe("No TODO state files found");
  });

  it("PASS when all state files match TODOS.md titles", () => {
    mkdirSync(TODO_STATE_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "TODOS.md"), "- [ ] Add caching layer [P2]\n- [x] Fix login bug [P1]\n");
    safeWriteJSON(join(TODO_STATE_DIR, "add-caching-layer.json"), { title: "Add caching layer", state: "designed" });
    safeWriteJSON(join(TODO_STATE_DIR, "fix-login-bug.json"), { title: "Fix login bug", state: "complete" });

    const result = checkOrphanedTodoState(defaultOptions());
    expect(result.status).toBe("PASS");
    expect(result.message).toBe("2 TODO state file(s) verified");
  });

  it("WARN when state file title not found in TODOS.md", () => {
    mkdirSync(TODO_STATE_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "TODOS.md"), "- [ ] Add caching layer [P2]\n");
    safeWriteJSON(join(TODO_STATE_DIR, "deleted-feature.json"), { title: "Deleted feature", state: "implemented" });

    const result = checkOrphanedTodoState(defaultOptions());
    expect(result.status).toBe("WARN");
    expect(result.fixable).toBe(true);
    expect(result.message).toContain("1 orphaned");
    expect(result.details).toBeDefined();
    expect(result.details![0]).toContain("Deleted feature");
  });

  it("removes orphaned files when fix=true", () => {
    mkdirSync(TODO_STATE_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "TODOS.md"), "- [ ] Keep this [P1]\n");
    const orphanPath = join(TODO_STATE_DIR, "gone-item.json");
    safeWriteJSON(orphanPath, { title: "Gone item", state: "open" });

    const result = checkOrphanedTodoState(defaultOptions({ fix: true }));
    expect(result.status).toBe("WARN");
    expect(result.fixed).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
    expect(result.message).toContain("1 fixed");
  });

  it("skips state files without a title field", () => {
    mkdirSync(TODO_STATE_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "TODOS.md"), "- [ ] Something [P1]\n");
    safeWriteJSON(join(TODO_STATE_DIR, "no-title.json"), { state: "open" });

    const result = checkOrphanedTodoState(defaultOptions());
    // File without title is skipped, so no orphan detected — only verified count matters
    expect(result.status).toBe("PASS");
  });

  it("matches case-insensitively", () => {
    mkdirSync(TODO_STATE_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "TODOS.md"), "- [ ] Add OAuth Support [P2]\n");
    safeWriteJSON(join(TODO_STATE_DIR, "add-oauth-support.json"), { title: "add oauth support", state: "designed" });

    const result = checkOrphanedTodoState(defaultOptions());
    expect(result.status).toBe("PASS");
    expect(result.message).toBe("1 TODO state file(s) verified");
  });

  it("matches via substring inclusion", () => {
    mkdirSync(TODO_STATE_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "TODOS.md"), "- [ ] Implement OAuth 2.1 support with PKCE [P1]\n");
    safeWriteJSON(join(TODO_STATE_DIR, "oauth-support.json"), { title: "OAuth 2.1 support", state: "implemented" });

    const result = checkOrphanedTodoState(defaultOptions());
    expect(result.status).toBe("PASS");
  });

  it("PASS when no TODOS.md exists (no titles to compare against)", () => {
    mkdirSync(TODO_STATE_DIR, { recursive: true });
    safeWriteJSON(join(TODO_STATE_DIR, "some-item.json"), { title: "Some item", state: "open" });

    // No TODOS.md means todoTitles is empty, so `!found && todoTitles.length > 0` is false
    const result = checkOrphanedTodoState(defaultOptions());
    expect(result.status).toBe("PASS");
  });

  it("non-json files in todo-state dir are ignored", () => {
    mkdirSync(TODO_STATE_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "TODOS.md"), "- [ ] Real item [P1]\n");
    writeFileSync(join(TODO_STATE_DIR, "notes.txt"), "some notes");
    safeWriteJSON(join(TODO_STATE_DIR, "real-item.json"), { title: "Real item", state: "open" });

    const result = checkOrphanedTodoState(defaultOptions());
    expect(result.status).toBe("PASS");
    expect(result.message).toBe("1 TODO state file(s) verified");
  });
});
