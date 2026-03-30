// Regression: ISSUE-004 — startParallelInstances has zero direct test coverage
// Found by /qa on 2026-03-30
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
//
// The startParallelInstances() function handles budget validation, staggered fork,
// PID verification, and skip-already-running logic. All tested indirectly via CLI
// integration but no unit tests for the function itself.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock all external dependencies
vi.mock("../src/doctor.js", () => ({
  runAutoCleanup: vi.fn(async () => ({ cleaned: [] })),
}));

vi.mock("../src/daemon-registry.js", () => ({
  instanceDir: vi.fn((base: string, name: string) => join(base, "daemons", name)),
  resolveInstanceName: vi.fn((_base: string, name?: string) => name ?? "default"),
  listInstances: vi.fn(() => []),
  readGlobalBudget: vi.fn(() => ({ totalUsd: 0, jobCount: 0, byInstance: {} })),
}));

vi.mock("../src/daemon.js", () => ({
  readPidFile: vi.fn(() => null),
  isPidAlive: vi.fn(() => false),
  getWorktreeCommitCount: vi.fn(async () => 0),
  buildIPCHandler: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    fork: vi.fn(() => {
      const child = { pid: 12345, unref: vi.fn() };
      return child;
    }),
  };
});

// Suppress console output
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

import { startParallelInstances } from "../src/cli.js";
import { readGlobalBudget } from "../src/daemon-registry.js";
import { readPidFile, isPidAlive } from "../src/daemon.js";
import { runAutoCleanup } from "../src/doctor.js";
import { fork } from "node:child_process";

describe("startParallelInstances", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gc-parallel-"));
    configPath = join(tmpDir, "daemon.json");
    writeFileSync(configPath, JSON.stringify({
      budget: { dailyCostLimitUsd: 100, perJobCostLimitUsd: 5 },
    }));

    // Reset mocks to defaults
    vi.mocked(readGlobalBudget).mockReturnValue({
      totalUsd: 0, jobCount: 0, byInstance: {}, date: "2026-03-30",
    } as ReturnType<typeof readGlobalBudget>);
    vi.mocked(readPidFile).mockReturnValue(null);
    vi.mocked(isPidAlive).mockReturnValue(false);
    vi.mocked(runAutoCleanup).mockResolvedValue({ cleaned: [] });
  });

  it("returns correct counts on successful launch of N workers", async () => {
    // Make daemon dirs so instanceDir resolves
    for (let i = 1; i <= 3; i++) {
      mkdirSync(join(tmpDir, "daemons", `worker-${i}`), { recursive: true });
      // Write PID file so verification loop succeeds
      writeFileSync(join(tmpDir, "daemons", `worker-${i}`, "daemon.pid"), "12345");
    }

    const result = await startParallelInstances(3, tmpDir, tmpDir, configPath);
    expect(result.launched).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("rejects when budget is insufficient", async () => {
    vi.mocked(readGlobalBudget).mockReturnValue({
      totalUsd: 95, jobCount: 10, byInstance: {}, date: "2026-03-30",
    } as ReturnType<typeof readGlobalBudget>);

    // Need 5 * $5 = $25, only $5 remaining
    await expect(
      startParallelInstances(5, tmpDir, tmpDir, configPath),
    ).rejects.toThrow("process.exit");
  });

  it("rejects when no daemon config exists", async () => {
    await expect(
      startParallelInstances(3, tmpDir, tmpDir, "/nonexistent/daemon.json"),
    ).rejects.toThrow("process.exit");
  });

  it("skips already-running workers", async () => {
    vi.mocked(readPidFile).mockReturnValue(99999);
    vi.mocked(isPidAlive).mockReturnValue(true);

    const result = await startParallelInstances(3, tmpDir, tmpDir, configPath);
    expect(result.skipped).toBe(3);
    expect(result.launched).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("counts fork failure when child.pid is falsy", async () => {
    vi.mocked(fork).mockReturnValue({ pid: undefined, unref: vi.fn() } as never);

    const result = await startParallelInstances(2, tmpDir, tmpDir, configPath);
    expect(result.failed).toBe(2);
    expect(result.launched).toBe(0);
  });

  it("runs auto-cleanup before budget check", async () => {
    let cleanupCalledFirst = false;
    let budgetCalledSecond = false;
    let cleanupDone = false;

    vi.mocked(runAutoCleanup).mockImplementation(async () => {
      cleanupCalledFirst = true;
      cleanupDone = true;
      return { cleaned: ["stale PIDs"] };
    });
    vi.mocked(readGlobalBudget).mockImplementation(() => {
      if (cleanupDone) budgetCalledSecond = true;
      return { totalUsd: 0, jobCount: 0, byInstance: {}, date: "2026-03-30" } as ReturnType<typeof readGlobalBudget>;
    });

    for (let i = 1; i <= 2; i++) {
      mkdirSync(join(tmpDir, "daemons", `worker-${i}`), { recursive: true });
      writeFileSync(join(tmpDir, "daemons", `worker-${i}`, "daemon.pid"), "12345");
    }

    await startParallelInstances(2, tmpDir, tmpDir, configPath);
    expect(cleanupCalledFirst).toBe(true);
    expect(budgetCalledSecond).toBe(true);
  });

  it("accepts budget exactly at the limit", async () => {
    // Need 2 * $5 = $10, exactly $10 remaining
    vi.mocked(readGlobalBudget).mockReturnValue({
      totalUsd: 90, jobCount: 8, byInstance: {}, date: "2026-03-30",
    } as ReturnType<typeof readGlobalBudget>);

    for (let i = 1; i <= 2; i++) {
      mkdirSync(join(tmpDir, "daemons", `worker-${i}`), { recursive: true });
      writeFileSync(join(tmpDir, "daemons", `worker-${i}`, "daemon.pid"), "12345");
    }

    const result = await startParallelInstances(2, tmpDir, tmpDir, configPath);
    expect(result.launched).toBe(2);
  });

  it("resolves config from checkpoint dir when configPath omitted", async () => {
    // Write daemon.json into checkpointDir
    writeFileSync(join(tmpDir, "daemon.json"), JSON.stringify({
      budget: { dailyCostLimitUsd: 100, perJobCostLimitUsd: 5 },
    }));

    mkdirSync(join(tmpDir, "daemons", "worker-1"), { recursive: true });
    writeFileSync(join(tmpDir, "daemons", "worker-1", "daemon.pid"), "12345");

    const result = await startParallelInstances(1, tmpDir, tmpDir);
    expect(result.launched).toBe(1);
  });

  it("mixes skipped and launched workers in a single fleet", async () => {
    // worker-1 already running, worker-2 not running
    let callCount = 0;
    vi.mocked(readPidFile).mockImplementation(() => {
      callCount++;
      return callCount === 1 ? 99999 : null;
    });
    vi.mocked(isPidAlive).mockImplementation((pid) => pid === 99999);

    mkdirSync(join(tmpDir, "daemons", "worker-2"), { recursive: true });
    writeFileSync(join(tmpDir, "daemons", "worker-2", "daemon.pid"), "12345");

    const result = await startParallelInstances(2, tmpDir, tmpDir, configPath);
    expect(result.skipped).toBe(1);
    expect(result.launched).toBe(1);
  });
});
