import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  safeReadJSON,
  safeWriteJSON,
  safeReadText,
  safeWriteText,
} from "../src/safe-json.js";

const TEST_DIR = join(tmpdir(), `garyclaw-safe-json-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("safe-json", () => {
  describe("safeWriteJSON", () => {
    it("writes a valid JSON file", () => {
      const path = join(TEST_DIR, "test.json");
      safeWriteJSON(path, { hello: "world" });

      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw);
      expect(data).toEqual({ hello: "world" });
    });

    it("writes with 2-space indent by default", () => {
      const path = join(TEST_DIR, "pretty.json");
      safeWriteJSON(path, { a: 1 });

      const raw = readFileSync(path, "utf-8");
      expect(raw).toBe('{\n  "a": 1\n}');
    });

    it("writes compact JSON when pretty=false", () => {
      const path = join(TEST_DIR, "compact.json");
      safeWriteJSON(path, { a: 1 }, false);

      const raw = readFileSync(path, "utf-8");
      expect(raw).toBe('{"a":1}');
    });

    it("creates parent directories", () => {
      const path = join(TEST_DIR, "nested", "deep", "file.json");
      safeWriteJSON(path, { nested: true });

      expect(existsSync(path)).toBe(true);
      const data = JSON.parse(readFileSync(path, "utf-8"));
      expect(data.nested).toBe(true);
    });

    it("overwrites existing file atomically", () => {
      const path = join(TEST_DIR, "overwrite.json");
      safeWriteJSON(path, { version: 1 });
      safeWriteJSON(path, { version: 2 });

      const data = JSON.parse(readFileSync(path, "utf-8"));
      expect(data.version).toBe(2);
    });

    it("leaves no tmp files after successful write", () => {
      const path = join(TEST_DIR, "clean.json");
      safeWriteJSON(path, { clean: true });

      const files = require("node:fs").readdirSync(TEST_DIR) as string[];
      const tmpFiles = files.filter((f: string) => f.includes(".tmp."));
      expect(tmpFiles).toHaveLength(0);
    });
  });

  describe("safeReadJSON", () => {
    it("reads a valid JSON file", () => {
      const path = join(TEST_DIR, "valid.json");
      writeFileSync(path, '{"key": "value"}', "utf-8");

      const data = safeReadJSON<{ key: string }>(path);
      expect(data).toEqual({ key: "value" });
    });

    it("returns null for missing file", () => {
      const result = safeReadJSON(join(TEST_DIR, "missing.json"));
      expect(result).toBeNull();
    });

    it("returns null and creates .bak for corrupt JSON", () => {
      const path = join(TEST_DIR, "corrupt.json");
      writeFileSync(path, "not valid json {{", "utf-8");

      const result = safeReadJSON(path);
      expect(result).toBeNull();

      // Original should be gone, .bak should exist
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.bak`)).toBe(true);
      expect(readFileSync(`${path}.bak`, "utf-8")).toBe("not valid json {{");
    });

    it("returns null when validation fails and creates .bak", () => {
      const path = join(TEST_DIR, "invalid-schema.json");
      writeFileSync(path, '{"wrong": "schema"}', "utf-8");

      const validate = (data: unknown): data is { version: number } => {
        return typeof data === "object" && data !== null && "version" in data;
      };

      const result = safeReadJSON(path, validate);
      expect(result).toBeNull();
      expect(existsSync(`${path}.bak`)).toBe(true);
    });

    it("returns typed data when validation passes", () => {
      const path = join(TEST_DIR, "valid-schema.json");
      writeFileSync(path, '{"version": 1, "name": "test"}', "utf-8");

      interface MyType {
        version: number;
        name: string;
      }
      const validate = (data: unknown): data is MyType => {
        return typeof data === "object" && data !== null && "version" in data;
      };

      const result = safeReadJSON<MyType>(path, validate);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(1);
      expect(result!.name).toBe("test");
    });

    it("reads empty object", () => {
      const path = join(TEST_DIR, "empty-obj.json");
      writeFileSync(path, "{}", "utf-8");

      const result = safeReadJSON(path);
      expect(result).toEqual({});
    });

    it("reads array", () => {
      const path = join(TEST_DIR, "array.json");
      writeFileSync(path, "[1, 2, 3]", "utf-8");

      const result = safeReadJSON<number[]>(path);
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe("safeWriteText", () => {
    it("writes text content", () => {
      const path = join(TEST_DIR, "test.md");
      safeWriteText(path, "# Hello\nWorld");

      const content = readFileSync(path, "utf-8");
      expect(content).toBe("# Hello\nWorld");
    });

    it("creates parent directories", () => {
      const path = join(TEST_DIR, "deep", "nested", "file.txt");
      safeWriteText(path, "content");

      expect(existsSync(path)).toBe(true);
    });

    it("overwrites existing file", () => {
      const path = join(TEST_DIR, "overwrite.txt");
      safeWriteText(path, "version 1");
      safeWriteText(path, "version 2");

      const content = readFileSync(path, "utf-8");
      expect(content).toBe("version 2");
    });
  });

  describe("safeReadText", () => {
    it("reads text file", () => {
      const path = join(TEST_DIR, "read.txt");
      writeFileSync(path, "hello world", "utf-8");

      const result = safeReadText(path);
      expect(result).toBe("hello world");
    });

    it("returns null for missing file", () => {
      const result = safeReadText(join(TEST_DIR, "missing.txt"));
      expect(result).toBeNull();
    });

    it("returns empty string for empty file", () => {
      const path = join(TEST_DIR, "empty.txt");
      writeFileSync(path, "", "utf-8");

      const result = safeReadText(path);
      expect(result).toBe("");
    });
  });

  describe("roundtrip", () => {
    it("write then read preserves data", () => {
      const path = join(TEST_DIR, "roundtrip.json");
      const original = { version: 1, items: ["a", "b"], nested: { x: 42 } };
      safeWriteJSON(path, original);

      const read = safeReadJSON(path);
      expect(read).toEqual(original);
    });

    it("text roundtrip preserves content", () => {
      const path = join(TEST_DIR, "roundtrip.md");
      const content = "# Heading\n\n- item 1\n- item 2\n\nParagraph.";
      safeWriteText(path, content);

      const read = safeReadText(path);
      expect(read).toBe(content);
    });
  });
});
