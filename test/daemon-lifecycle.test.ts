/**
 * Daemon lifecycle integration tests (10A) — tests the wiring of startDaemon,
 * signal handlers, PID management, and poller startup.
 * Tests the functions that compose the daemon lifecycle, not startDaemon() itself
 * (which calls process.exit and sets signal handlers that can't be cleanly tested).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  validateDaemonConfig,
  loadDaemonConfig,
  isPidAlive,
  readPidFile,
  writePidFile,
  cleanupDaemonFiles,
  createDaemonLogger,
  buildIPCHandler,
  startPollers,
} from "../src/daemon.js";

import type { DaemonConfig, BudgetConfig } from "../src/types.js";

vi.mock("../src/oracle-memory.js", () => ({
  defaultMemoryConfig: vi.fn().mockReturnValue({ globalDir: "/tmp/global", projectDir: "/tmp/project" }),
  readMetrics: vi.fn().mockReturnValue({
    totalDecisions: 5,
    accurateDecisions: 4,
    neutralDecisions: 1,
    failedDecisions: 0,
    accuracyPercent: 100,
    confidenceTrend: [7, 8, 9],
    lastReflectionTimestamp: "2026-03-26T00:00:00Z",
    circuitBreakerTripped: false,
  }),
}));

const TEST_DIR = join(tmpdir(), `garyclaw-daemon-lifecycle-${Date.now()}`);

function createValidConfig(): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/test-project",
    triggers: [
      { type: "git_poll", intervalSeconds: 60, skills: ["qa"] },
    ],
    budget: { dailyCostLimitUsd: 5, perJobCostLimitUsd: 1, maxJobsPerDay: 10 },
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: true },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 5000 },
    logging: { level: "info", retainDays: 7 },
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Daemon lifecycle: PID management", () => {
  it("writePidFile creates PID file and readPidFile reads it back", () => {
    writePidFile(TEST_DIR, 12345);
    const pid = readPidFile(TEST_DIR);
    expect(pid).toBe(12345);
  });

  it("readPidFile returns null when no PID file exists", () => {
    expect(readPidFile(TEST_DIR)).toBeNull();
  });

  it("cleanupDaemonFiles removes PID and socket files", () => {
    writePidFile(TEST_DIR, 99999);
    writeFileSync(join(TEST_DIR, "daemon.sock"), "", "utf-8");

    cleanupDaemonFiles(TEST_DIR);

    expect(existsSync(join(TEST_DIR, "daemon.pid"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "daemon.sock"))).toBe(false);
  });

  it("isPidAlive returns true for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("isPidAlive returns false for nonexistent PID", () => {
    expect(isPidAlive(999999999)).toBe(false);
  });
});

describe("Daemon lifecycle: Config loading", () => {
  it("loadDaemonConfig returns config from valid file", () => {
    const config = createValidConfig();
    writeFileSync(join(TEST_DIR, "daemon.json"), JSON.stringify(config), "utf-8");

    const loaded = loadDaemonConfig(TEST_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.projectDir).toBe("/tmp/test-project");
  });

  it("loadDaemonConfig returns null for missing file", () => {
    expect(loadDaemonConfig(TEST_DIR)).toBeNull();
  });

  it("loadDaemonConfig returns null for invalid config", () => {
    writeFileSync(join(TEST_DIR, "daemon.json"), '{"version": 99}', "utf-8");
    expect(loadDaemonConfig(TEST_DIR)).toBeNull();
  });
});

describe("Daemon lifecycle: Logger", () => {
  it("logger creates log file and writes entries", () => {
    const log = createDaemonLogger(TEST_DIR, "info");
    log("info", "Test message");

    const content = readFileSync(join(TEST_DIR, "daemon.log"), "utf-8");
    expect(content).toContain("[INFO] Test message");
  });

  it("logger respects log level threshold", () => {
    const log = createDaemonLogger(TEST_DIR, "warn");
    log("info", "Should be filtered");
    log("warn", "Should appear");

    const content = readFileSync(join(TEST_DIR, "daemon.log"), "utf-8");
    expect(content).not.toContain("Should be filtered");
    expect(content).toContain("Should appear");
  });

  it("logger rotates when exceeding max size (in-memory tracking)", () => {
    // Create a log file that's already at the max size
    const logPath = join(TEST_DIR, "daemon.log");
    const bigContent = "x".repeat(10 * 1024 * 1024 + 1); // Just over 10MB
    writeFileSync(logPath, bigContent, "utf-8");

    const log = createDaemonLogger(TEST_DIR, "info");
    log("info", "After rotation");

    // Original should have been rotated to .1
    expect(existsSync(logPath + ".1")).toBe(true);
    // New log should contain the new entry
    const newContent = readFileSync(logPath, "utf-8");
    expect(newContent).toContain("After rotation");
  });
});

describe("Daemon lifecycle: IPC handler", () => {
  it("buildIPCHandler status returns oracle health when projectDir provided", async () => {
    const runner = {
      getState: () => ({ version: 1, jobs: [], dailyCost: { date: "2026-03-26", totalUsd: 0, jobCount: 0 } }),
      isRunning: () => false,
      enqueue: vi.fn(),
      processNext: vi.fn(),
      updateBudget: vi.fn(),
    };

    const handler = buildIPCHandler(runner as any, Date.now(), "/tmp/test-project");
    const response = await handler({ type: "status" });

    expect(response.ok).toBe(true);
    expect((response.data as any).oracleHealth).not.toBeNull();
    expect((response.data as any).oracleHealth.accuracyPercent).toBe(100);
  });
});

describe("Daemon lifecycle: startPollers", () => {
  it("starts git pollers from config triggers", () => {
    const config = createValidConfig();
    const runner = { enqueue: vi.fn() } as any;
    const log = vi.fn();

    const pollers = startPollers(config, runner, log);

    expect(pollers.length).toBe(1);
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("Git poller started"));

    // Cleanup
    for (const p of pollers) p.stop();
  });

  it("skips invalid cron triggers with a warning", () => {
    const config = {
      ...createValidConfig(),
      triggers: [{ type: "cron" as const, expression: "invalid cron", skills: ["qa"] }],
    };
    const runner = { enqueue: vi.fn() } as any;
    const log = vi.fn();

    const pollers = startPollers(config, runner, log);

    expect(pollers.length).toBe(0);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("Invalid cron"));
  });
});
