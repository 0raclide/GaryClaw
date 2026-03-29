/**
 * Tests for buildEnrichedBootstrapPrompt — the enriched bootstrap prompt
 * generated after a quality gate failure. Verifies codebase analysis,
 * QA findings injection, existing CLAUDE.md handling, and token truncation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Mock checkpoint reader
vi.mock("../src/checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/checkpoint.js")>();
  return {
    ...actual,
    readCheckpoint: vi.fn().mockReturnValue(null),
    generateRelayPrompt: vi.fn().mockReturnValue("QA found 3 issues: test failures, missing deps, lint errors"),
  };
});

import { buildEnrichedBootstrapPrompt } from "../src/bootstrap.js";
import { readCheckpoint, generateRelayPrompt } from "../src/checkpoint.js";
import type { GaryClawConfig, Checkpoint } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-bootstrap-enriched-tmp");

function createTestConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skillName: "bootstrap",
    projectDir: TEST_DIR,
    maxTurnsPerSegment: 15,
    relayThresholdRatio: 0.85,
    checkpointDir: join(TEST_DIR, ".garyclaw"),
    settingSources: [],
    env: {},
    askTimeoutMs: 5000,
    maxRelaySessions: 10,
    autonomous: true,
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });
  vi.mocked(readCheckpoint).mockReturnValue(null);
  vi.mocked(generateRelayPrompt).mockReturnValue("QA found 3 issues: test failures, missing deps, lint errors");
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("buildEnrichedBootstrapPrompt", () => {
  it("includes existing CLAUDE.md content", async () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# My Project\n\nThis is a thin CLAUDE.md.");
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "console.log('hello');");

    const config = createTestConfig();
    const prompt = await buildEnrichedBootstrapPrompt(config, "/tmp/qa-checkpoint", TEST_DIR);

    expect(prompt).toContain("scored below the quality threshold");
    expect(prompt).toContain("# My Project");
    expect(prompt).toContain("This is a thin CLAUDE.md.");
  });

  it("handles missing CLAUDE.md gracefully", async () => {
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "console.log('hello');");

    const config = createTestConfig();
    const prompt = await buildEnrichedBootstrapPrompt(config, "/tmp/qa-checkpoint", TEST_DIR);

    expect(prompt).toContain("(empty — bootstrap produced no output)");
  });

  it("includes QA findings from checkpoint when available", async () => {
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");
    // Mock checkpoint exists
    vi.mocked(readCheckpoint).mockReturnValue({
      version: 1,
      timestamp: new Date().toISOString(),
      runId: "test-run",
      skillName: "qa",
      issues: [],
      findings: [],
      decisions: [],
      gitBranch: "main",
      gitHead: "abc123",
      tokenUsage: {
        lastContextSize: 0,
        contextWindow: 1_000_000,
        totalOutputTokens: 0,
        sessionCount: 1,
        estimatedCostUsd: 0,
        turnHistory: [],
      },
      screenshotPaths: [],
    } satisfies Checkpoint);

    const config = createTestConfig();
    const prompt = await buildEnrichedBootstrapPrompt(config, "/tmp/qa-checkpoint", TEST_DIR);

    expect(prompt).toContain("QA found 3 issues");
    expect(generateRelayPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: "qa" }),
      { maxTokens: 5_000 },
    );
  });

  it("shows fallback message when no QA checkpoint exists", async () => {
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");
    vi.mocked(readCheckpoint).mockReturnValue(null);

    const config = createTestConfig();
    const prompt = await buildEnrichedBootstrapPrompt(config, "/tmp/qa-checkpoint", TEST_DIR);

    expect(prompt).toContain("No QA findings captured.");
  });

  it("includes file tree from codebase analysis", async () => {
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");
    writeFileSync(join(TEST_DIR, "src", "utils.ts"), "export function foo() {}");

    const config = createTestConfig();
    const prompt = await buildEnrichedBootstrapPrompt(config, "/tmp/qa-checkpoint", TEST_DIR);

    expect(prompt).toContain("## File Tree");
    expect(prompt).toContain("src/index.ts");
    expect(prompt).toContain("src/utils.ts");
  });

  it("includes package.json content when present", async () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test-app", dependencies: { express: "^4" } }),
    );
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");

    const config = createTestConfig();
    const prompt = await buildEnrichedBootstrapPrompt(config, "/tmp/qa-checkpoint", TEST_DIR);

    expect(prompt).toContain("## Package Dependencies");
    expect(prompt).toContain("express");
  });

  it("shows fallback when no package.json exists", async () => {
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");

    const config = createTestConfig();
    const prompt = await buildEnrichedBootstrapPrompt(config, "/tmp/qa-checkpoint", TEST_DIR);

    expect(prompt).toContain("No package.json found.");
  });

  it("includes all required instruction sections", async () => {
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");

    const config = createTestConfig();
    const prompt = await buildEnrichedBootstrapPrompt(config, "/tmp/qa-checkpoint", TEST_DIR);

    expect(prompt).toContain("Architecture, Tech Stack, Test Strategy, Usage");
    expect(prompt).toContain("Rewrite CLAUDE.md");
    expect(prompt).toContain("update TODOS.md");
    expect(prompt).toContain("Write the updated files now.");
  });

  it("truncates large CLAUDE.md to token budget", async () => {
    // Create a CLAUDE.md that's ~20K tokens (70K chars at ~3.5 chars/token)
    const largeMd = "# Large Project\n" + "x".repeat(70_000);
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), largeMd);
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");

    const config = createTestConfig();
    const prompt = await buildEnrichedBootstrapPrompt(config, "/tmp/qa-checkpoint", TEST_DIR);

    // Should be truncated — not contain the full content
    expect(prompt).not.toContain("x".repeat(70_000));
    expect(prompt).toContain("(truncated)");
  });

  it("preserves small CLAUDE.md without truncation", async () => {
    const smallMd = "# Small Project\n\nJust a few lines.";
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), smallMd);
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");

    const config = createTestConfig();
    const prompt = await buildEnrichedBootstrapPrompt(config, "/tmp/qa-checkpoint", TEST_DIR);

    expect(prompt).toContain("Just a few lines.");
    expect(prompt).not.toContain("(truncated)");
  });
});
