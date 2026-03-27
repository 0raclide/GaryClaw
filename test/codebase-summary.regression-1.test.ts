/**
 * Regression: ISSUE-001/002 — narration slip-through + version false positives
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 */

import { describe, it, expect } from "vitest";
import {
  extractObservations,
  hasCodeAnchor,
} from "../src/codebase-summary.js";

// ── ISSUE-001: Narration patterns that previously slipped through ────

describe("ISSUE-001: expanded negative patterns", () => {
  it("blocks 'I will try' narration with 2+ signal words", () => {
    const text = "I will try the convention pattern for naming all modules.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("blocks 'let me look' narration with 2+ signal words", () => {
    const text = "Let me look at the naming convention used in this architecture.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("blocks 'let me examine' narration with signal words", () => {
    const text = "Let me examine the pattern and structure of this codebase module.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("blocks 'I plan to' narration with signal words", () => {
    const text = "I plan to use the naming convention and avoid the old pattern.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("blocks 'I need to' narration with signal words", () => {
    const text = "I need to understand the architecture pattern used in this structure.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("blocks 'I should' narration with signal words", () => {
    const text = "I should follow the naming convention and avoid breaking the pattern.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("blocks 'I want to' narration with signal words", () => {
    const text = "I want to use the same convention and pattern as the existing modules.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("still allows genuine observations with signal words", () => {
    const text = "This codebase uses a naming convention where all files are kebab-case.";
    const result = extractObservations(text);
    expect(result).toHaveLength(1);
  });
});

// ── ISSUE-002: Version string false positives in code anchor detection ──

describe("ISSUE-002: version string exclusion from code anchors", () => {
  it("rejects 'v1.2.3' as a code anchor", () => {
    expect(hasCodeAnchor("Upgrade to v1.2.3 for the fix")).toBe(false);
  });

  it("rejects '2.0.1' as a code anchor", () => {
    expect(hasCodeAnchor("Version 2.0.1 is available now")).toBe(false);
  });

  it("rejects 'v0.12.11.0' as a code anchor", () => {
    expect(hasCodeAnchor("Running gstack v0.12.11.0 currently")).toBe(false);
  });

  it("still accepts real file paths as code anchors", () => {
    expect(hasCodeAnchor("Check src/safe-json.ts for the utility")).toBe(true);
  });

  it("still accepts function calls as code anchors", () => {
    expect(hasCodeAnchor("Use safeReadJSON() for all file reads")).toBe(true);
  });

  it("still accepts dotted module names as code anchors", () => {
    expect(hasCodeAnchor("The codebase-summary.ts module handles extraction")).toBe(true);
  });

  it("does not promote version-only sentences with 1 signal word", () => {
    // "uses" is 1 signal word, "v1.2.3" should NOT count as code anchor
    const text = "The project uses version v1.2.3 of the dependency for builds.";
    const result = extractObservations(text);
    expect(result).toHaveLength(0);
  });

  it("still promotes code-anchored sentences with 1 signal word", () => {
    // "uses" is 1 signal word, "safe-json.ts" IS a code anchor
    const text = "The project always wraps I/O through src/safe-json.ts for safety.";
    const result = extractObservations(text);
    expect(result).toHaveLength(1);
  });
});
