/**
 * Regression: loadAutoFixContext direct SHA lookup.
 *
 * Bug: autoFixMergeSha was set on Job but never threaded to GaryClawConfig,
 * so loadAutoFixContext always fell back to newest-file-by-mtime. In parallel
 * daemon scenarios, this could load the wrong context file.
 *
 * Fix: Added autoFixMergeSha to GaryClawConfig, threaded it in buildGaryClawConfig,
 * and loadAutoFixContext now does direct path lookup when SHA is available.
 *
 * Found by /qa on 2026-03-30
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAutoFixContext } from "../src/implement.js";
import type { GaryClawConfig } from "../src/types.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-autofix-ctx-regression-1");

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

describe("loadAutoFixContext direct SHA lookup (regression)", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("uses autoFixMergeSha for direct lookup when available", () => {
    const contextDir = join(TMP, ".garyclaw", "auto-fix-context");
    mkdirSync(contextDir, { recursive: true });
    // Write two context files — the older one is the correct one for this job
    writeFileSync(join(contextDir, "abc123def456.md"), "correct context for abc123");
    writeFileSync(join(contextDir, "zzz999aaa888.md"), "wrong context (newer by mtime)");

    const config = makeConfig({ autoFixMergeSha: "abc123def456abcdef1234567890abcdef12345678" });
    const result = loadAutoFixContext(TMP, config);
    expect(result).toContain("correct context for abc123");
  });

  it("falls back to newest-file when autoFixMergeSha file not found", () => {
    const contextDir = join(TMP, ".garyclaw", "auto-fix-context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "zzz999aaa888.md"), "fallback context");

    // SHA doesn't match any file
    const config = makeConfig({ autoFixMergeSha: "nomatch12345678" });
    const result = loadAutoFixContext(TMP, config);
    expect(result).toContain("fallback context");
  });

  it("falls back to newest-file when autoFixMergeSha is undefined", () => {
    const contextDir = join(TMP, ".garyclaw", "auto-fix-context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "abc123def456.md"), "only file");

    const config = makeConfig(); // no autoFixMergeSha
    const result = loadAutoFixContext(TMP, config);
    expect(result).toContain("only file");
  });

  it("direct lookup also truncates to 4000 chars", () => {
    const contextDir = join(TMP, ".garyclaw", "auto-fix-context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "abc123def456.md"), "X".repeat(5000));

    const config = makeConfig({ autoFixMergeSha: "abc123def456abcdef" });
    const result = loadAutoFixContext(TMP, config);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4000);
  });
});
