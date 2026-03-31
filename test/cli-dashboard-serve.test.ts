/**
 * CLI dashboard --serve flag tests — parseArgs for dashboard subcommand.
 */

import { describe, it, expect, vi } from "vitest";

// Mock heavy dependencies (same pattern as cli.test.ts)
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

describe("parseArgs dashboard --serve", () => {
  it("--serve sets serve=true", () => {
    const parsed = parseArgs(["node", "garyclaw", "dashboard", "--serve"]);
    expect(parsed.command).toBe("dashboard");
    expect(parsed.serve).toBe(true);
    expect(parsed.servePort).toBeUndefined();
    expect(parsed.openBrowser).toBe(false);
  });

  it("--port sets servePort and implies serve", () => {
    const parsed = parseArgs(["node", "garyclaw", "dashboard", "--port", "8080"]);
    expect(parsed.serve).toBe(true);
    expect(parsed.servePort).toBe(8080);
  });

  it("--open implies serve", () => {
    const parsed = parseArgs(["node", "garyclaw", "dashboard", "--open"]);
    expect(parsed.serve).toBe(true);
    expect(parsed.openBrowser).toBe(true);
  });

  it("--serve --port --open all together", () => {
    const parsed = parseArgs(["node", "garyclaw", "dashboard", "--serve", "--port", "4444", "--open"]);
    expect(parsed.serve).toBe(true);
    expect(parsed.servePort).toBe(4444);
    expect(parsed.openBrowser).toBe(true);
  });

  it("--project-dir works with dashboard", () => {
    const parsed = parseArgs(["node", "garyclaw", "dashboard", "--serve", "--project-dir", "/tmp/myproject"]);
    expect(parsed.serve).toBe(true);
    expect(parsed.projectDir).toBe("/tmp/myproject");
  });

  it("plain dashboard command has serve=false", () => {
    const parsed = parseArgs(["node", "garyclaw", "dashboard"]);
    expect(parsed.command).toBe("dashboard");
    expect(parsed.serve).toBe(false);
    expect(parsed.openBrowser).toBe(false);
    expect(parsed.servePort).toBeUndefined();
  });

  it("non-dashboard commands have serve=false", () => {
    const parsed = parseArgs(["node", "garyclaw", "run", "qa"]);
    expect(parsed.serve).toBe(false);
    expect(parsed.openBrowser).toBe(false);
  });

  it("--port with default port value", () => {
    const parsed = parseArgs(["node", "garyclaw", "dashboard", "--port", "3333"]);
    expect(parsed.servePort).toBe(3333);
  });

  it("--checkpoint-dir works with dashboard --serve", () => {
    const parsed = parseArgs(["node", "garyclaw", "dashboard", "--serve", "--checkpoint-dir", "/tmp/.gc"]);
    expect(parsed.serve).toBe(true);
    expect(parsed.checkpointDir).toBe("/tmp/.gc");
  });
});
