/**
 * Regression: ISSUE-003 — CLI post-pipeline evaluate hook had zero test coverage.
 * Found by /qa on 2026-03-28
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md
 *
 * Tests: happy path, skip same project, skip missing candidates,
 * skip empty candidates, error handling on fs failure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Mock heavy deps so cli.ts can be imported
vi.mock("../src/sdk-wrapper.js", () => ({
  buildSdkEnv: vi.fn((env: Record<string, string>) => env),
}));
vi.mock("../src/orchestrator.js", () => ({
  runSkill: vi.fn(),
  resumeSkill: vi.fn(),
}));
vi.mock("../src/pipeline.js", () => ({
  runPipeline: vi.fn(),
  resumePipeline: vi.fn(),
  readPipelineState: vi.fn(),
}));
vi.mock("../src/daemon-ipc.js", () => ({
  sendIPCRequest: vi.fn(),
}));
vi.mock("../src/daemon.js", () => ({
  readPidFile: vi.fn(),
  isPidAlive: vi.fn(),
  cleanupDaemonFiles: vi.fn(),
}));

import { appendEvaluateCandidates } from "../src/cli.js";

const TEST_DIR = join(process.cwd(), ".test-cli-eval-hook-tmp");
const PROJECT_DIR = join(TEST_DIR, "target-project");
const GARYCLAW_ROOT = join(TEST_DIR, "garyclaw-root");

beforeEach(() => {
  mkdirSync(join(PROJECT_DIR, ".garyclaw"), { recursive: true });
  mkdirSync(GARYCLAW_ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("appendEvaluateCandidates", () => {
  it("appends candidates to TODOS.md when evaluate ran on different project", () => {
    const candidates = "## P2: Fix something\n\n**What:** Description\n\n## P3: Another thing\n\n**What:** Desc2";
    writeFileSync(join(PROJECT_DIR, ".garyclaw", "improvement-candidates.md"), candidates);
    writeFileSync(join(GARYCLAW_ROOT, "TODOS.md"), "# Existing TODOs\n\n## P1: Old task");

    const result = appendEvaluateCandidates(["bootstrap", "evaluate"], PROJECT_DIR, GARYCLAW_ROOT);

    expect(result.appended).toBe(true);
    expect(result.count).toBe(2);

    const todos = readFileSync(join(GARYCLAW_ROOT, "TODOS.md"), "utf-8");
    expect(todos).toContain("# Existing TODOs");
    expect(todos).toContain("## P2: Fix something");
    expect(todos).toContain("## P3: Another thing");
  });

  it("creates TODOS.md if it does not exist yet", () => {
    const candidates = "## P2: New improvement\n\n**What:** Something";
    writeFileSync(join(PROJECT_DIR, ".garyclaw", "improvement-candidates.md"), candidates);

    const result = appendEvaluateCandidates(["evaluate"], PROJECT_DIR, GARYCLAW_ROOT);

    expect(result.appended).toBe(true);
    expect(result.count).toBe(1);
    expect(existsSync(join(GARYCLAW_ROOT, "TODOS.md"))).toBe(true);
  });

  it("skips when pipeline does not include evaluate", () => {
    writeFileSync(join(PROJECT_DIR, ".garyclaw", "improvement-candidates.md"), "## P2: X");

    const result = appendEvaluateCandidates(["bootstrap", "qa"], PROJECT_DIR, GARYCLAW_ROOT);

    expect(result.appended).toBe(false);
    expect(result.count).toBe(0);
  });

  it("skips when project dir equals garyclaw root (self-evaluation)", () => {
    writeFileSync(join(PROJECT_DIR, ".garyclaw", "improvement-candidates.md"), "## P2: X");

    const result = appendEvaluateCandidates(["evaluate"], PROJECT_DIR, PROJECT_DIR);

    expect(result.appended).toBe(false);
    expect(result.count).toBe(0);
  });

  it("skips when candidates file does not exist", () => {
    // No candidates file written
    const result = appendEvaluateCandidates(["evaluate"], PROJECT_DIR, GARYCLAW_ROOT);

    expect(result.appended).toBe(false);
    expect(result.count).toBe(0);
  });

  it("skips when candidates file is empty", () => {
    writeFileSync(join(PROJECT_DIR, ".garyclaw", "improvement-candidates.md"), "   \n  ");

    const result = appendEvaluateCandidates(["evaluate"], PROJECT_DIR, GARYCLAW_ROOT);

    expect(result.appended).toBe(false);
    expect(result.count).toBe(0);
  });

  it("handles read errors gracefully", () => {
    // Point to a non-existent directory that existsSync will pass but readFileSync will fail
    const badPath = join(TEST_DIR, "nonexistent");
    mkdirSync(join(badPath, ".garyclaw"), { recursive: true });
    // Create file, then remove read permissions
    const filePath = join(badPath, ".garyclaw", "improvement-candidates.md");
    writeFileSync(filePath, "## P2: X");
    // Remove the file and replace with a directory to trigger read error
    rmSync(filePath);
    mkdirSync(filePath);

    const result = appendEvaluateCandidates(["evaluate"], badPath, GARYCLAW_ROOT);

    expect(result.appended).toBe(false);
    expect(result.count).toBe(0);
  });
});
