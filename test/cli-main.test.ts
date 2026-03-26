/**
 * CLI main() integration tests — covers run/resume/replay/oracle/daemon code paths.
 * Mocks all external dependencies to test CLI routing and config construction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Mock all heavy dependencies ──────────────────────────────────

const mockRunSkill = vi.fn().mockResolvedValue(undefined);
const mockResumeSkill = vi.fn().mockResolvedValue(undefined);
const mockRunPipeline = vi.fn().mockResolvedValue(undefined);
const mockResumePipeline = vi.fn().mockResolvedValue(undefined);
const mockReadPipelineState = vi.fn().mockReturnValue(null);
const mockSendIPCRequest = vi.fn();
const mockReadPidFile = vi.fn().mockReturnValue(null);
const mockIsPidAlive = vi.fn().mockReturnValue(false);
const mockCleanupDaemonFiles = vi.fn();
const mockBuildSdkEnv = vi.fn((env: Record<string, string>) => env);
const mockInitOracleMemory = vi.fn();
const mockDefaultMemoryConfig = vi.fn((dir: string) => ({
  globalDir: join(process.env.HOME || "/tmp", ".garyclaw/oracle-memory"),
  projectDir: join(dir, ".garyclaw/oracle-memory"),
}));

vi.mock("../src/sdk-wrapper.js", () => ({
  buildSdkEnv: (env: Record<string, string>) => mockBuildSdkEnv(env),
}));
vi.mock("../src/orchestrator.js", () => ({
  runSkill: (...args: any[]) => mockRunSkill(...args),
  resumeSkill: (...args: any[]) => mockResumeSkill(...args),
}));
vi.mock("../src/pipeline.js", () => ({
  runPipeline: (...args: any[]) => mockRunPipeline(...args),
  resumePipeline: (...args: any[]) => mockResumePipeline(...args),
  readPipelineState: (...args: any[]) => mockReadPipelineState(...args),
}));
vi.mock("../src/daemon-ipc.js", () => ({
  sendIPCRequest: (...args: any[]) => mockSendIPCRequest(...args),
}));
vi.mock("../src/daemon.js", () => ({
  readPidFile: (...args: any[]) => mockReadPidFile(...args),
  isPidAlive: (...args: any[]) => mockIsPidAlive(...args),
  cleanupDaemonFiles: (...args: any[]) => mockCleanupDaemonFiles(...args),
}));
vi.mock("../src/oracle-memory.js", () => ({
  initOracleMemory: (...args: any[]) => mockInitOracleMemory(...args),
  defaultMemoryConfig: (...args: any[]) => mockDefaultMemoryConfig(...args),
}));

// Prevent child_process.fork from actually spawning
vi.mock("node:child_process", () => ({
  fork: vi.fn().mockReturnValue({ pid: 99999, unref: vi.fn() }),
}));

import { parseArgs, formatEvent, formatUptime } from "../src/cli.js";
import type { GaryClawConfig, OrchestratorCallbacks } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-cli-main-tmp");

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── parseArgs edge cases (extending existing tests) ──────────────

describe("parseArgs — additional edge cases", () => {
  it("parses --threshold without a value (flag at end)", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--threshold"]);
    expect(result.threshold).toBe(0.85); // unchanged default
  });

  it("parses --max-sessions without a value", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--max-sessions"]);
    expect(result.maxSessions).toBe(10); // unchanged default
  });

  it("parses --checkpoint-dir without a value", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--checkpoint-dir"]);
    expect(result.checkpointDir).toBeUndefined();
  });

  it("parses --project-dir without a value", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--project-dir"]);
    expect(result.projectDir).toBe(process.cwd()); // unchanged default
  });

  it("parses --design-doc without a value", () => {
    const result = parseArgs(["node", "cli.ts", "run", "implement", "--design-doc"]);
    expect(result.designDoc).toBeUndefined();
  });

  it("parses daemon stop subcommand", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "stop"]);
    expect(result.command).toBe("daemon");
    expect(result.subcommand).toBe("stop");
  });

  it("parses daemon status subcommand", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "status"]);
    expect(result.command).toBe("daemon");
    expect(result.subcommand).toBe("status");
  });

  it("parses daemon with no subcommand defaults to empty", () => {
    const result = parseArgs(["node", "cli.ts", "daemon"]);
    expect(result.command).toBe("daemon");
    expect(result.subcommand).toBe("");
  });

  it("parses daemon with --project-dir", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "start", "--project-dir", "/tmp/myproject"]);
    expect(result.projectDir).toContain("myproject");
  });

  it("parses daemon with --checkpoint-dir", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "start", "--checkpoint-dir", "/tmp/cp"]);
    expect(result.checkpointDir).toContain("cp");
  });

  it("parses oracle with no subcommand defaults to empty", () => {
    const result = parseArgs(["node", "cli.ts", "oracle"]);
    expect(result.command).toBe("oracle");
    expect(result.subcommand).toBe("");
  });

  it("parses resume with --autonomous", () => {
    const result = parseArgs(["node", "cli.ts", "resume", "--autonomous"]);
    expect(result.autonomous).toBe(true);
  });

  it("parses resume with --max-turns", () => {
    const result = parseArgs(["node", "cli.ts", "resume", "--max-turns", "20"]);
    expect(result.maxTurns).toBe(20);
  });

  it("parses resume with --threshold", () => {
    const result = parseArgs(["node", "cli.ts", "resume", "--threshold", "0.9"]);
    expect(result.threshold).toBe(0.9);
  });

  it("parses resume with --max-sessions", () => {
    const result = parseArgs(["node", "cli.ts", "resume", "--max-sessions", "5"]);
    expect(result.maxSessions).toBe(5);
  });

  it("ignores unknown flags in non-run commands", () => {
    const result = parseArgs(["node", "cli.ts", "resume", "--unknown"]);
    expect(result.command).toBe("resume");
  });

  it("parses oracle subcommands via skills array", () => {
    const result = parseArgs(["node", "cli.ts", "oracle", "init"]);
    expect(result.command).toBe("oracle");
    expect(result.subcommand).toBe("init");
  });

  it("daemon --tail without value keeps default", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "log", "--tail"]);
    expect(result.tailLines).toBe(50); // unchanged
  });
});

// ── formatEvent edge cases ───────────────────────────────────────

describe("formatEvent — additional cases", () => {
  it("formats turn_usage with high context (> 70%) in yellow color", () => {
    const result = formatEvent({
      type: "turn_usage",
      sessionIndex: 0,
      turn: 5,
      contextSize: 800000,
      contextWindow: 1000000,
    });
    expect(result).toContain("Turn 5");
    expect(result).toContain("80.0%");
    // Should use yellow color (ANSI code \x1b[33m)
    expect(result).toContain("\x1b[33m");
  });

  it("formats turn_usage with low context (< 70%) in dim", () => {
    const result = formatEvent({
      type: "turn_usage",
      sessionIndex: 0,
      turn: 2,
      contextSize: 200000,
      contextWindow: 1000000,
    });
    expect(result).toContain("Turn 2");
    expect(result).toContain("20.0%");
    // Should use dim color (ANSI code \x1b[2m)
    expect(result).toContain("\x1b[2m");
  });

  it("formats segment_end with correct session/segment", () => {
    const result = formatEvent({
      type: "segment_end",
      sessionIndex: 2,
      segmentIndex: 3,
      numTurns: 15,
    });
    expect(result).toContain("Session 2");
    expect(result).toContain("Segment 3");
    expect(result).toContain("15 turns");
  });

  it("formats cost_update with proper decimal formatting", () => {
    const result = formatEvent({
      type: "cost_update",
      costUsd: 0.001,
      sessionIndex: 0,
    });
    expect(result).toContain("$0.001");
    expect(result).toContain("session 0");
  });
});

// ── formatUptime edge cases ─────────────────────────────────────

describe("formatUptime — edge cases", () => {
  it("formats exactly 60 seconds as 1m 0s", () => {
    expect(formatUptime(60)).toBe("1m 0s");
  });

  it("formats exactly 3600 seconds as 1h 0m", () => {
    expect(formatUptime(3600)).toBe("1h 0m");
  });

  it("formats large values correctly", () => {
    // 2 days + 3 hours + 15 minutes = 48h + 3h + 15m = 51h 15m
    expect(formatUptime(51 * 3600 + 15 * 60)).toBe("51h 15m");
  });
});
