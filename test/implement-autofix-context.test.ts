/**
 * Implement skill auto-fix context discovery tests.
 *
 * Tests that buildImplementPrompt discovers and injects auto-fix context
 * from .garyclaw/auto-fix-context/ files when present.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAutoFixContext } from "../src/implement.js";
import type { GaryClawConfig } from "../src/types.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-implement-autofix-test");

function makeConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skillName: "implement",
    projectDir: TMP,
    maxTurnsPerSegment: 15,
    relayThresholdRatio: 0.85,
    checkpointDir: join(TMP, ".garyclaw"),
    settingSources: [],
    env: {},
    askTimeoutMs: 30000,
    maxRelaySessions: 10,
    autonomous: true,
    ...overrides,
  };
}

describe("implement auto-fix context discovery", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("returns null when no auto-fix-context directory exists", () => {
    const config = makeConfig();
    const result = loadAutoFixContext(TMP, config);
    expect(result).toBeNull();
  });

  it("returns null when auto-fix-context directory is empty", () => {
    mkdirSync(join(TMP, ".garyclaw", "auto-fix-context"), { recursive: true });
    const config = makeConfig();
    const result = loadAutoFixContext(TMP, config);
    expect(result).toBeNull();
  });

  it("reads context file content", () => {
    const contextDir = join(TMP, ".garyclaw", "auto-fix-context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "abc123def456.md"), [
      "# Auto-Fix Context for abc123de",
      "",
      "**Original job:** job-001",
      "**Branch:** garyclaw/worker-1",
      "",
      "## Test Output",
      "```",
      "FAIL: test/foo.test.ts > bar > should pass",
      "```",
    ].join("\n"));

    const config = makeConfig();
    const result = loadAutoFixContext(TMP, config);
    expect(result).not.toBeNull();
    expect(result).toContain("abc123de");
    expect(result).toContain("FAIL: test/foo.test.ts");
  });

  it("picks the most recently modified context file", () => {
    const contextDir = join(TMP, ".garyclaw", "auto-fix-context");
    mkdirSync(contextDir, { recursive: true });

    // Write old file
    writeFileSync(join(contextDir, "old_sha.md"), "old context");
    // Write newer file (filesystem mtime will be >= old file)
    writeFileSync(join(contextDir, "new_sha.md"), "new context");

    const config = makeConfig();
    const result = loadAutoFixContext(TMP, config);
    expect(result).not.toBeNull();
    expect(result).toContain("new context");
  });

  it("truncates context to 4000 chars", () => {
    const contextDir = join(TMP, ".garyclaw", "auto-fix-context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "abc123.md"), "X".repeat(5000));

    const config = makeConfig();
    const result = loadAutoFixContext(TMP, config);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4000);
  });

  it("ignores non-.md files in context directory", () => {
    const contextDir = join(TMP, ".garyclaw", "auto-fix-context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "abc123.json"), '{"not": "a context file"}');

    const config = makeConfig();
    const result = loadAutoFixContext(TMP, config);
    expect(result).toBeNull();
  });
});
