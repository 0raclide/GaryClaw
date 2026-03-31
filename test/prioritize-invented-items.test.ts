import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeInventedItems } from "../src/prioritize.js";

const TEST_DIR = join(tmpdir(), `garyclaw-invented-items-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(join(TEST_DIR, ".garyclaw"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("mergeInventedItems", () => {
  it("returns 0 when staging file does not exist", () => {
    writeFileSync(join(TEST_DIR, "TODOS.md"), "# TODOs\n");
    const count = mergeInventedItems(TEST_DIR);
    expect(count).toBe(0);
  });

  it("returns 0 and cleans up empty staging file", () => {
    writeFileSync(join(TEST_DIR, "TODOS.md"), "# TODOs\n");
    writeFileSync(join(TEST_DIR, ".garyclaw/invented-items.md"), "");
    const count = mergeInventedItems(TEST_DIR);
    expect(count).toBe(0);
    expect(existsSync(join(TEST_DIR, ".garyclaw/invented-items.md"))).toBe(false);
  });

  it("returns 0 for whitespace-only staging file", () => {
    writeFileSync(join(TEST_DIR, "TODOS.md"), "# TODOs\n");
    writeFileSync(join(TEST_DIR, ".garyclaw/invented-items.md"), "   \n  \n");
    const count = mergeInventedItems(TEST_DIR);
    expect(count).toBe(0);
  });

  it("appends invented items to existing TODOS.md", () => {
    const existing = "# TODOs\n\n## P2: Existing Item\nSome content\n";
    const invented = "## P3: New Feature\n**What:** Something new\n**Why:** Because\n**Effort:** S\n";
    writeFileSync(join(TEST_DIR, "TODOS.md"), existing);
    writeFileSync(join(TEST_DIR, ".garyclaw/invented-items.md"), invented);

    const count = mergeInventedItems(TEST_DIR);
    expect(count).toBe(1);

    const result = readFileSync(join(TEST_DIR, "TODOS.md"), "utf-8");
    // Existing content preserved
    expect(result).toContain("## P2: Existing Item");
    expect(result).toContain("Some content");
    // New content appended
    expect(result).toContain("## P3: New Feature");
    expect(result).toContain("Something new");
  });

  it("preserves existing TODOS.md content exactly", () => {
    const existing = "# TODOs\n\n## P2: Item A\nContent A\n\n## P3: Item B\nContent B\n";
    const invented = "## P3: Item C\nContent C\n";
    writeFileSync(join(TEST_DIR, "TODOS.md"), existing);
    writeFileSync(join(TEST_DIR, ".garyclaw/invented-items.md"), invented);

    mergeInventedItems(TEST_DIR);

    const result = readFileSync(join(TEST_DIR, "TODOS.md"), "utf-8");
    // The existing content should appear at the start, unchanged
    expect(result.startsWith(existing)).toBe(true);
  });

  it("counts multiple P\\d headings correctly", () => {
    const invented = [
      "## P3: Feature One",
      "**What:** Thing 1",
      "",
      "## P3: Feature Two",
      "**What:** Thing 2",
      "",
      "## P4: Feature Three",
      "**What:** Thing 3",
    ].join("\n");
    writeFileSync(join(TEST_DIR, "TODOS.md"), "# TODOs\n");
    writeFileSync(join(TEST_DIR, ".garyclaw/invented-items.md"), invented);

    const count = mergeInventedItems(TEST_DIR);
    expect(count).toBe(3);
  });

  it("deletes staging file after successful merge", () => {
    writeFileSync(join(TEST_DIR, "TODOS.md"), "# TODOs\n");
    writeFileSync(join(TEST_DIR, ".garyclaw/invented-items.md"), "## P3: New\nContent\n");

    mergeInventedItems(TEST_DIR);

    expect(existsSync(join(TEST_DIR, ".garyclaw/invented-items.md"))).toBe(false);
  });

  it("creates TODOS.md if it does not exist", () => {
    const invented = "## P3: First Item\n**What:** Bootstrap\n";
    writeFileSync(join(TEST_DIR, ".garyclaw/invented-items.md"), invented);

    const count = mergeInventedItems(TEST_DIR);
    expect(count).toBe(1);

    const result = readFileSync(join(TEST_DIR, "TODOS.md"), "utf-8");
    expect(result).toContain("## P3: First Item");
  });

  it("handles invented content without P\\d headings (returns 0 count but still appends)", () => {
    writeFileSync(join(TEST_DIR, "TODOS.md"), "# TODOs\n");
    writeFileSync(join(TEST_DIR, ".garyclaw/invented-items.md"), "Some freeform notes\nAbout the project\n");

    const count = mergeInventedItems(TEST_DIR);
    expect(count).toBe(0); // no P\d headings counted

    const result = readFileSync(join(TEST_DIR, "TODOS.md"), "utf-8");
    expect(result).toContain("Some freeform notes");
  });
});
