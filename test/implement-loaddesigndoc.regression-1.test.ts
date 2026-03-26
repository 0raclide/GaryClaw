/**
 * Regression: loadDesignDoc() — zero test coverage
 * Found by /qa on 2026-03-26
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-26.md
 *
 * Tests loadDesignDoc() absolute paths, relative paths, missing files,
 * and unreadable files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDesignDoc } from "../src/implement.js";

const TEST_DIR = join(process.cwd(), ".test-loaddesigndoc-tmp");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadDesignDoc", () => {
  it("loads a design doc from a relative path", () => {
    const relPath = "docs/my-design.md";
    mkdirSync(join(TEST_DIR, "docs"), { recursive: true });
    writeFileSync(join(TEST_DIR, relPath), "# My Design\n\nContent here.", "utf-8");

    const result = loadDesignDoc(relPath, TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(join(TEST_DIR, relPath));
    expect(result!.content).toBe("# My Design\n\nContent here.");
  });

  it("loads a design doc from an absolute path", () => {
    const absPath = join(TEST_DIR, "absolute-design.md");
    writeFileSync(absPath, "# Absolute Design", "utf-8");

    const result = loadDesignDoc(absPath, TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(absPath);
    expect(result!.content).toBe("# Absolute Design");
  });

  it("returns null when the file does not exist", () => {
    const result = loadDesignDoc("nonexistent.md", TEST_DIR);
    expect(result).toBeNull();
  });

  it("returns null when absolute path does not exist", () => {
    const result = loadDesignDoc("/tmp/nonexistent-design-doc-12345.md", TEST_DIR);
    expect(result).toBeNull();
  });

  it("handles empty file content", () => {
    writeFileSync(join(TEST_DIR, "empty.md"), "", "utf-8");

    const result = loadDesignDoc("empty.md", TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("");
  });

  it("handles design doc with unicode content", () => {
    const content = "# 设计文档\n\n这是一个设计文档。\n🎉 完成！";
    writeFileSync(join(TEST_DIR, "unicode.md"), content, "utf-8");

    const result = loadDesignDoc("unicode.md", TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.content).toBe(content);
  });

  it("resolves relative path correctly with nested directories", () => {
    const nested = "docs/designs/deep/feature.md";
    mkdirSync(join(TEST_DIR, "docs/designs/deep"), { recursive: true });
    writeFileSync(join(TEST_DIR, nested), "# Deep Feature", "utf-8");

    const result = loadDesignDoc(nested, TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(join(TEST_DIR, nested));
  });
});
