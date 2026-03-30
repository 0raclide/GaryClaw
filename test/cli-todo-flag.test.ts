/**
 * CLI --todo flag tests: parsing, validation, IPC request formation.
 */

import { describe, it, expect, vi } from "vitest";

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

import { parseArgs } from "../src/cli.js";

// ── --todo flag parsing ──────────────────────────────────────────

describe("parseArgs --todo flag", () => {
  it("parses --todo with title in daemon trigger", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "trigger", "--todo", "Oracle-Driven Skill Selection", "implement", "qa"]);
    expect(result.command).toBe("daemon");
    expect(result.subcommand).toBe("trigger");
    expect(result.todoTitle).toBe("Oracle-Driven Skill Selection");
    expect(result.skills).toEqual(["implement", "qa"]);
  });

  it("parses --todo before skills", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "trigger", "--todo", "Fix bug", "qa"]);
    expect(result.todoTitle).toBe("Fix bug");
    expect(result.skills).toEqual(["qa"]);
  });

  it("parses --todo after skills", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "trigger", "implement", "--todo", "Fix bug"]);
    expect(result.todoTitle).toBe("Fix bug");
    expect(result.skills).toEqual(["implement"]);
  });

  it("parses --todo with --name", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "trigger", "--name", "worker-1", "--todo", "Fix bug", "implement", "qa"]);
    expect(result.name).toBe("worker-1");
    expect(result.todoTitle).toBe("Fix bug");
    expect(result.skills).toEqual(["implement", "qa"]);
  });

  it("todoTitle is undefined when --todo not specified", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "trigger", "qa"]);
    expect(result.todoTitle).toBeUndefined();
  });

  it("todoTitle is undefined for non-daemon commands", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa"]);
    expect(result.todoTitle).toBeUndefined();
  });
});
