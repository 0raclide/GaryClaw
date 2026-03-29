/**
 * File-Level Conflict Prevention tests — extractPredictedFiles, expandWithDependencies,
 * hasFileOverlap, DEFAULT_FILE_DEPS validation.
 */

import { describe, it, expect } from "vitest";
import {
  extractPredictedFiles,
  expandWithDependencies,
  hasFileOverlap,
  DEFAULT_FILE_DEPS,
} from "../src/file-conflict.js";
import type { FileDependencyMap } from "../src/file-conflict.js";

// ── extractPredictedFiles ─────────────────────────────────────────

describe("extractPredictedFiles", () => {
  it("extracts backtick-wrapped file paths", () => {
    const desc = "Modify `oracle.ts` and `dashboard.ts` to add new feature";
    expect(extractPredictedFiles(desc)).toEqual(
      expect.arrayContaining(["oracle.ts", "dashboard.ts"]),
    );
  });

  it("extracts backtick-wrapped paths with directory prefix", () => {
    const desc = "Update `src/job-runner.ts` and `test/oracle.test.ts`";
    const files = extractPredictedFiles(desc);
    expect(files).toContain("job-runner.ts");
    expect(files).toContain("oracle.test.ts");
  });

  it("extracts bare paths with src/ prefix", () => {
    const desc = "Changes needed in src/oracle.ts and src/types.ts for this feature";
    const files = extractPredictedFiles(desc);
    expect(files).toContain("oracle.ts");
    expect(files).toContain("types.ts");
  });

  it("extracts bare paths with test/ prefix", () => {
    const desc = "Add tests in test/oracle.test.ts for the new behavior";
    const files = extractPredictedFiles(desc);
    expect(files).toContain("oracle.test.ts");
  });

  it("extracts paths from **Files:** section", () => {
    const desc = "## Feature\n**Files:** `pipeline.ts`, `types.ts`\nDo the thing.";
    const files = extractPredictedFiles(desc);
    expect(files).toContain("pipeline.ts");
    expect(files).toContain("types.ts");
  });

  it("extracts paths from **Implementation notes:** section", () => {
    const desc = "**Implementation notes:** Change `src/daemon.ts` to support new config";
    const files = extractPredictedFiles(desc);
    expect(files).toContain("daemon.ts");
  });

  it("returns empty array when no file paths found", () => {
    const desc = "Add a new feature to improve performance";
    expect(extractPredictedFiles(desc)).toEqual([]);
  });

  it("deduplicates extracted files", () => {
    const desc = "Modify `oracle.ts` first, then update `oracle.ts` again";
    const files = extractPredictedFiles(desc);
    const oracleCount = files.filter((f) => f === "oracle.ts").length;
    expect(oracleCount).toBe(1);
  });

  it("normalizes to basenames (strips directory prefix)", () => {
    const desc = "Update `src/deep/nested/oracle.ts`";
    const files = extractPredictedFiles(desc);
    expect(files).toContain("oracle.ts");
    expect(files).not.toContain("src/deep/nested/oracle.ts");
  });

  it("extracts from design doc content as well", () => {
    const desc = "Implement the new feature";
    const designDoc = "## Implementation\nModify `orchestrator.ts` and `relay.ts`";
    const files = extractPredictedFiles(desc, designDoc);
    expect(files).toContain("orchestrator.ts");
    expect(files).toContain("relay.ts");
  });

  it("merges files from both description and design doc", () => {
    const desc = "Changes to `oracle.ts`";
    const designDoc = "Also modify `dashboard.ts`";
    const files = extractPredictedFiles(desc, designDoc);
    expect(files).toContain("oracle.ts");
    expect(files).toContain("dashboard.ts");
  });

  it("handles undefined design doc content", () => {
    const desc = "Modify `oracle.ts`";
    const files = extractPredictedFiles(desc, undefined);
    expect(files).toContain("oracle.ts");
  });

  it("extracts .json and .md files", () => {
    const desc = "Update `file-deps.json` and `docs/designs/plan.md`";
    const files = extractPredictedFiles(desc);
    expect(files).toContain("file-deps.json");
    expect(files).toContain("plan.md");
  });
});

// ── expandWithDependencies ────────────────────────────────────────

describe("expandWithDependencies", () => {
  const testMap: FileDependencyMap = {
    "oracle.ts": ["types.ts", "oracle-memory.ts"],
    "dashboard.ts": ["types.ts"],
    "oracle-memory.ts": ["types.ts", "oracle.ts"],
  };

  it("expands a single file with its dependencies", () => {
    const expanded = expandWithDependencies(["oracle.ts"], testMap);
    expect(expanded).toContain("oracle.ts");
    expect(expanded).toContain("types.ts");
    expect(expanded).toContain("oracle-memory.ts");
  });

  it("returns original file when not in dep map", () => {
    const expanded = expandWithDependencies(["unknown.ts"], testMap);
    expect(expanded).toEqual(["unknown.ts"]);
  });

  it("deduplicates expanded files", () => {
    // Both oracle.ts and dashboard.ts depend on types.ts
    const expanded = expandWithDependencies(["oracle.ts", "dashboard.ts"], testMap);
    const typesCount = expanded.filter((f) => f === "types.ts").length;
    expect(typesCount).toBe(1);
  });

  it("does single-level expansion (not transitive)", () => {
    // oracle.ts -> oracle-memory.ts -> oracle.ts (cycle), types.ts
    // Should NOT transitively expand oracle-memory.ts's deps again
    const expanded = expandWithDependencies(["oracle.ts"], testMap);
    // oracle-memory.ts is in the expansion, but its deps (types.ts, oracle.ts)
    // are already included anyway via oracle.ts's direct deps
    expect(expanded).toEqual(
      expect.arrayContaining(["oracle.ts", "types.ts", "oracle-memory.ts"]),
    );
    expect(expanded.length).toBe(3);
  });

  it("handles empty input array", () => {
    const expanded = expandWithDependencies([], testMap);
    expect(expanded).toEqual([]);
  });

  it("handles empty dep map", () => {
    const expanded = expandWithDependencies(["oracle.ts"], {});
    expect(expanded).toEqual(["oracle.ts"]);
  });

  it("handles custom dep map", () => {
    const customMap: FileDependencyMap = {
      "foo.ts": ["bar.ts", "baz.ts"],
    };
    const expanded = expandWithDependencies(["foo.ts"], customMap);
    expect(expanded).toEqual(expect.arrayContaining(["foo.ts", "bar.ts", "baz.ts"]));
  });

  it("preserves files not in dep map alongside expanded ones", () => {
    const expanded = expandWithDependencies(["oracle.ts", "cli.ts"], testMap);
    expect(expanded).toContain("cli.ts");
    expect(expanded).toContain("oracle.ts");
    expect(expanded).toContain("types.ts");
  });
});

// ── hasFileOverlap ───────────────────────────────────────────────

describe("hasFileOverlap", () => {
  it("returns no overlap for disjoint sets", () => {
    const result = hasFileOverlap(["oracle.ts", "dashboard.ts"], ["cli.ts", "relay.ts"]);
    expect(result.overlaps).toBe(false);
    expect(result.conflictingFiles).toEqual([]);
  });

  it("detects single file overlap", () => {
    const result = hasFileOverlap(["oracle.ts", "types.ts"], ["types.ts", "cli.ts"]);
    expect(result.overlaps).toBe(true);
    expect(result.conflictingFiles).toEqual(["types.ts"]);
  });

  it("detects multiple file overlaps", () => {
    const result = hasFileOverlap(
      ["oracle.ts", "types.ts", "dashboard.ts"],
      ["types.ts", "dashboard.ts", "cli.ts"],
    );
    expect(result.overlaps).toBe(true);
    expect(result.conflictingFiles).toEqual(
      expect.arrayContaining(["types.ts", "dashboard.ts"]),
    );
    expect(result.conflictingFiles.length).toBe(2);
  });

  it("handles empty predicted files", () => {
    const result = hasFileOverlap([], ["types.ts"]);
    expect(result.overlaps).toBe(false);
    expect(result.conflictingFiles).toEqual([]);
  });

  it("handles empty claimed files", () => {
    const result = hasFileOverlap(["oracle.ts"], []);
    expect(result.overlaps).toBe(false);
    expect(result.conflictingFiles).toEqual([]);
  });

  it("handles both empty", () => {
    const result = hasFileOverlap([], []);
    expect(result.overlaps).toBe(false);
    expect(result.conflictingFiles).toEqual([]);
  });
});

// ── DEFAULT_FILE_DEPS validation ──────────────────────────────────

describe("DEFAULT_FILE_DEPS", () => {
  it("has all entries as valid string arrays", () => {
    for (const [key, deps] of Object.entries(DEFAULT_FILE_DEPS)) {
      expect(typeof key).toBe("string");
      expect(Array.isArray(deps)).toBe(true);
      for (const dep of deps) {
        expect(typeof dep).toBe("string");
      }
    }
  });

  it("has no self-references", () => {
    for (const [key, deps] of Object.entries(DEFAULT_FILE_DEPS)) {
      expect(deps).not.toContain(key);
    }
  });

  it("includes types.ts as a dependency (most common co-modification target)", () => {
    const entriesWithTypes = Object.values(DEFAULT_FILE_DEPS).filter((deps) =>
      deps.includes("types.ts"),
    );
    // Most entries should depend on types.ts
    expect(entriesWithTypes.length).toBeGreaterThan(5);
  });
});
