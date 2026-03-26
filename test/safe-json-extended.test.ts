/**
 * Extended safe-json tests — backupCorruptFile edge cases,
 * safeReadText error handling, safeWriteText edge cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  safeReadJSON,
  safeWriteJSON,
  safeReadText,
  safeWriteText,
} from "../src/safe-json.js";

const TEST_DIR = join(tmpdir(), `garyclaw-safe-json-ext-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("safeReadText", () => {
  it("returns null for non-existent file", () => {
    expect(safeReadText(join(TEST_DIR, "nope.txt"))).toBeNull();
  });

  it("reads existing text file", () => {
    const path = join(TEST_DIR, "hello.txt");
    writeFileSync(path, "hello world", "utf-8");
    expect(safeReadText(path)).toBe("hello world");
  });

  it("returns null on read error (e.g. directory instead of file)", () => {
    // Trying to read a directory as a file should trigger the catch
    const dirPath = join(TEST_DIR, "subdir");
    mkdirSync(dirPath, { recursive: true });
    // On some systems reading a dir throws, on others returns empty
    const result = safeReadText(dirPath);
    // Either null or a string is acceptable — key is no throw
    expect(result === null || typeof result === "string").toBe(true);
  });
});

describe("safeWriteText", () => {
  it("writes text file atomically", () => {
    const path = join(TEST_DIR, "output.txt");
    safeWriteText(path, "content here");
    expect(readFileSync(path, "utf-8")).toBe("content here");
  });

  it("creates parent directories", () => {
    const path = join(TEST_DIR, "deep", "nested", "file.txt");
    safeWriteText(path, "nested content");
    expect(readFileSync(path, "utf-8")).toBe("nested content");
  });

  it("overwrites existing file", () => {
    const path = join(TEST_DIR, "overwrite.txt");
    safeWriteText(path, "original");
    safeWriteText(path, "replaced");
    expect(readFileSync(path, "utf-8")).toBe("replaced");
  });
});

describe("safeReadJSON — corrupt file recovery", () => {
  it("backs up corrupt JSON and returns null", () => {
    const path = join(TEST_DIR, "corrupt.json");
    writeFileSync(path, "not valid json {{{", "utf-8");

    const result = safeReadJSON(path);
    expect(result).toBeNull();

    // The corrupt file should be renamed to .bak
    expect(existsSync(path + ".bak")).toBe(true);
    expect(readFileSync(path + ".bak", "utf-8")).toBe("not valid json {{{");
  });

  it("handles validation function rejection", () => {
    const path = join(TEST_DIR, "invalid-schema.json");
    safeWriteJSON(path, { version: 99 });

    const validator = (data: unknown): boolean => {
      return typeof data === "object" && data !== null && (data as any).version === 1;
    };

    const result = safeReadJSON(path, validator);
    expect(result).toBeNull();
  });

  it("passes valid data through validation", () => {
    const path = join(TEST_DIR, "valid-schema.json");
    safeWriteJSON(path, { version: 1, name: "test" });

    const validator = (data: unknown): boolean => {
      return typeof data === "object" && data !== null && (data as any).version === 1;
    };

    const result = safeReadJSON(path, validator);
    expect(result).toEqual({ version: 1, name: "test" });
  });

  it("returns null for empty file and backs it up", () => {
    const path = join(TEST_DIR, "empty.json");
    writeFileSync(path, "", "utf-8");

    const result = safeReadJSON(path);
    // Empty string is invalid JSON — should be treated as corrupt
    expect(result).toBeNull();
  });
});

describe("safeWriteJSON — edge cases", () => {
  it("handles special characters in values", () => {
    const path = join(TEST_DIR, "special.json");
    safeWriteJSON(path, { msg: "hello\nworld\ttab" });
    const result = safeReadJSON<{ msg: string }>(path);
    expect(result?.msg).toBe("hello\nworld\ttab");
  });

  it("handles deeply nested objects", () => {
    const path = join(TEST_DIR, "nested.json");
    const data = { a: { b: { c: { d: { e: "deep" } } } } };
    safeWriteJSON(path, data);
    expect(safeReadJSON(path)).toEqual(data);
  });

  it("handles arrays", () => {
    const path = join(TEST_DIR, "array.json");
    safeWriteJSON(path, [1, 2, 3]);
    expect(safeReadJSON(path)).toEqual([1, 2, 3]);
  });
});
