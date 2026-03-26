/**
 * Daemon tests — config validation, PID lifecycle, IPC handler, logger.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  validateDaemonConfig,
  loadDaemonConfig,
  readPidFile,
  writePidFile,
  cleanupDaemonFiles,
  isPidAlive,
  createDaemonLogger,
  buildIPCHandler,
  startPollers,
} from "../src/daemon.js";
import type { DaemonConfig, Job } from "../src/types.js";
import type { JobRunner } from "../src/job-runner.js";

const TEST_DIR = join(process.cwd(), ".test-daemon-tmp");

function createValidConfig(): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [
      {
        type: "git_poll",
        intervalSeconds: 60,
        skills: ["qa"],
        debounceSeconds: 30,
      },
    ],
    budget: {
      dailyCostLimitUsd: 5,
      perJobCostLimitUsd: 1,
      maxJobsPerDay: 10,
    },
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: true },
    orchestrator: {
      maxTurnsPerSegment: 15,
      relayThresholdRatio: 0.85,
      maxRelaySessions: 10,
      askTimeoutMs: 300000,
    },
    logging: { level: "info", retainDays: 7 },
  };
}

describe("validateDaemonConfig", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("accepts valid config", () => {
    expect(validateDaemonConfig(createValidConfig())).toBeNull();
  });

  it("rejects null", () => {
    expect(validateDaemonConfig(null)).toContain("object");
  });

  it("rejects wrong version", () => {
    const config = createValidConfig();
    (config as any).version = 2;
    expect(validateDaemonConfig(config)).toContain("version");
  });

  it("rejects missing projectDir", () => {
    const config = createValidConfig();
    (config as any).projectDir = "";
    expect(validateDaemonConfig(config)).toContain("projectDir");
  });

  it("rejects invalid budget", () => {
    const config = createValidConfig();
    config.budget.dailyCostLimitUsd = -1;
    expect(validateDaemonConfig(config)).toContain("dailyCostLimitUsd");
  });

  it("rejects invalid trigger interval", () => {
    const config = createValidConfig();
    config.triggers[0].intervalSeconds = 0;
    expect(validateDaemonConfig(config)).toContain("intervalSeconds");
  });

  it("rejects trigger with empty skills", () => {
    const config = createValidConfig();
    (config.triggers[0] as any).skills = [];
    expect(validateDaemonConfig(config)).toContain("skills");
  });

  it("rejects trigger with unknown type", () => {
    const config = createValidConfig();
    (config.triggers[0] as any).type = "webhook";
    expect(validateDaemonConfig(config)).toContain("git_poll");
    expect(validateDaemonConfig(config)).toContain("cron");
  });
});

describe("loadDaemonConfig", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("loads valid config from file", () => {
    const config = createValidConfig();
    writeFileSync(join(TEST_DIR, "daemon.json"), JSON.stringify(config), "utf-8");

    const loaded = loadDaemonConfig(TEST_DIR);
    expect(loaded).not.toBeNull();
    expect(loaded!.projectDir).toBe("/tmp/project");
  });

  it("returns null for missing file", () => {
    expect(loadDaemonConfig(TEST_DIR)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    writeFileSync(join(TEST_DIR, "daemon.json"), "not json", "utf-8");
    expect(loadDaemonConfig(TEST_DIR)).toBeNull();
  });

  it("returns null for invalid config structure", () => {
    writeFileSync(join(TEST_DIR, "daemon.json"), JSON.stringify({ version: 99 }), "utf-8");
    expect(loadDaemonConfig(TEST_DIR)).toBeNull();
  });
});

describe("PID file lifecycle", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("writes and reads PID file", () => {
    writePidFile(TEST_DIR, 12345);
    const pid = readPidFile(TEST_DIR);
    expect(pid).toBe(12345);
  });

  it("returns null when no PID file exists", () => {
    expect(readPidFile(TEST_DIR)).toBeNull();
  });

  it("returns null for corrupt PID file", () => {
    writeFileSync(join(TEST_DIR, "daemon.pid"), "not-a-number", "utf-8");
    expect(readPidFile(TEST_DIR)).toBeNull();
  });

  it("cleanupDaemonFiles removes PID and socket files", () => {
    writeFileSync(join(TEST_DIR, "daemon.pid"), "12345", "utf-8");
    writeFileSync(join(TEST_DIR, "daemon.sock"), "", "utf-8");

    cleanupDaemonFiles(TEST_DIR);

    expect(existsSync(join(TEST_DIR, "daemon.pid"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "daemon.sock"))).toBe(false);
  });

  it("cleanupDaemonFiles is safe when files don't exist", () => {
    expect(() => cleanupDaemonFiles(TEST_DIR)).not.toThrow();
  });
});

describe("isPidAlive", () => {
  it("returns true for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for non-existent PID", () => {
    // Use a very high PID that's extremely unlikely to exist
    expect(isPidAlive(999999999)).toBe(false);
  });
});

describe("createDaemonLogger", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("writes log entries with timestamp", () => {
    const log = createDaemonLogger(TEST_DIR, "info");
    log("info", "Test message");

    const content = readFileSync(join(TEST_DIR, "daemon.log"), "utf-8");
    expect(content).toContain("[INFO]");
    expect(content).toContain("Test message");
  });

  it("respects log level threshold", () => {
    const log = createDaemonLogger(TEST_DIR, "warn");
    log("debug", "should not appear");
    log("info", "should not appear either");
    log("warn", "should appear");
    log("error", "should also appear");

    const content = readFileSync(join(TEST_DIR, "daemon.log"), "utf-8");
    expect(content).not.toContain("should not appear");
    expect(content).toContain("should appear");
    expect(content).toContain("should also appear");
  });
});

describe("buildIPCHandler", () => {
  function createMockRunner(stateOverride: Partial<ReturnType<JobRunner["getState"]>> = {}): JobRunner {
    const defaultState = {
      version: 1 as const,
      jobs: [] as Job[],
      dailyCost: { date: "2026-03-25", totalUsd: 0.5, jobCount: 2 },
      ...stateOverride,
    };

    return {
      enqueue: vi.fn().mockReturnValue("job-new-001"),
      processNext: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue(defaultState),
      isRunning: vi.fn().mockReturnValue(false),
    };
  }

  it("handles status request", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now() - 60000);

    const resp = await handler({ type: "status" });
    expect(resp.ok).toBe(true);
    expect((resp.data as any).running).toBe(false);
    expect((resp.data as any).dailyCost.totalUsd).toBe(0.5);
    expect((resp.data as any).uptimeSeconds).toBeGreaterThanOrEqual(59);
  });

  it("includes oracleHealth in status when metrics exist", async () => {
    // Create a project dir with oracle metrics
    const projectDir = join(TEST_DIR, "oracle-project");
    const oracleDir = join(projectDir, ".garyclaw", "oracle-memory");
    mkdirSync(oracleDir, { recursive: true });
    writeFileSync(join(oracleDir, "metrics.json"), JSON.stringify({
      totalDecisions: 25,
      accurateDecisions: 20,
      neutralDecisions: 3,
      failedDecisions: 2,
      accuracyPercent: 90.9,
      confidenceTrend: [8, 7, 9],
      lastReflectionTimestamp: "2026-03-26T10:00:00Z",
      circuitBreakerTripped: false,
    }), "utf-8");

    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now(), projectDir);

    const resp = await handler({ type: "status" });
    expect(resp.ok).toBe(true);
    const data = resp.data as any;
    expect(data.oracleHealth).not.toBeNull();
    expect(data.oracleHealth.accuracyPercent).toBeCloseTo(90.9);
    expect(data.oracleHealth.totalDecisions).toBe(25);
    expect(data.oracleHealth.lastReflectionTimestamp).toBe("2026-03-26T10:00:00Z");
    expect(data.oracleHealth.circuitBreakerTripped).toBe(false);
  });

  it("returns null oracleHealth when no metrics exist", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now(), "/tmp/nonexistent-project");

    const resp = await handler({ type: "status" });
    expect(resp.ok).toBe(true);
    expect((resp.data as any).oracleHealth).toBeNull();
  });

  it("returns null oracleHealth when projectDir not provided", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({ type: "status" });
    expect(resp.ok).toBe(true);
    expect((resp.data as any).oracleHealth).toBeNull();
  });

  it("handles trigger request", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({ type: "trigger", skills: ["qa"] });
    expect(resp.ok).toBe(true);
    expect((resp.data as any).jobId).toBe("job-new-001");
    expect(runner.enqueue).toHaveBeenCalledWith(["qa"], "manual", "CLI trigger", undefined);
  });

  it("handles trigger rejection (dedup/budget)", async () => {
    const runner = createMockRunner();
    (runner.enqueue as any).mockReturnValue(null);
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({ type: "trigger", skills: ["qa"] });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("rejected");
  });

  it("handles trigger with empty skills", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({ type: "trigger", skills: [] } as any);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("non-empty");
  });

  it("handles queue request", async () => {
    const runner = createMockRunner({
      jobs: [
        {
          id: "job-1",
          triggeredBy: "manual",
          triggerDetail: "test",
          skills: ["qa"],
          projectDir: "/tmp",
          status: "queued",
          enqueuedAt: "2026-01-01T00:00:00Z",
          costUsd: 0,
        },
      ],
    });
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({ type: "queue" });
    expect(resp.ok).toBe(true);
    expect((resp.data as any).jobs).toHaveLength(1);
    expect((resp.data as any).jobs[0].id).toBe("job-1");
  });

  it("handles unknown request type", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({ type: "unknown" } as any);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Unknown");
  });
});

describe("validateDaemonConfig — cron triggers", () => {
  it("accepts valid cron trigger", () => {
    const config = createValidConfig();
    config.triggers = [
      { type: "cron", expression: "0 2 * * *", skills: ["qa"] },
    ];
    expect(validateDaemonConfig(config)).toBeNull();
  });

  it("rejects cron trigger with missing expression", () => {
    const config = createValidConfig();
    config.triggers = [
      { type: "cron", expression: "", skills: ["qa"] } as any,
    ];
    expect(validateDaemonConfig(config)).toContain("expression");
  });

  it("rejects cron trigger with invalid expression", () => {
    const config = createValidConfig();
    config.triggers = [
      { type: "cron", expression: "bad cron", skills: ["qa"] },
    ];
    expect(validateDaemonConfig(config)).toContain("Invalid cron expression");
  });

  it("rejects cron trigger with empty skills", () => {
    const config = createValidConfig();
    config.triggers = [
      { type: "cron", expression: "0 2 * * *", skills: [] },
    ];
    expect(validateDaemonConfig(config)).toContain("skills");
  });
});

describe("startPollers", () => {
  function createMockRunner(): JobRunner {
    return {
      enqueue: vi.fn().mockReturnValue("job-001"),
      processNext: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue({ version: 1, jobs: [], dailyCost: { date: "", totalUsd: 0, jobCount: 0 } }),
      isRunning: vi.fn().mockReturnValue(false),
      updateBudget: vi.fn(),
    };
  }

  it("starts git pollers from config", () => {
    const config = createValidConfig();
    const runner = createMockRunner();
    const log = vi.fn();

    const pollers = startPollers(config, runner, log);
    expect(pollers).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("Git poller started"));
  });

  it("starts cron pollers from config", () => {
    const config = createValidConfig();
    config.triggers = [
      { type: "cron", expression: "0 2 * * *", skills: ["qa"] },
    ];
    const runner = createMockRunner();
    const log = vi.fn();

    const pollers = startPollers(config, runner, log);
    expect(pollers).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("info", expect.stringContaining("Cron poller started"));
  });

  it("skips invalid cron expression with warning", () => {
    const config = createValidConfig();
    config.triggers = [
      { type: "cron", expression: "invalid", skills: ["qa"] },
    ];
    const runner = createMockRunner();
    const log = vi.fn();

    const pollers = startPollers(config, runner, log);
    expect(pollers).toHaveLength(0);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("Invalid cron expression"));
  });

  it("starts mixed git + cron pollers", () => {
    const config = createValidConfig();
    config.triggers = [
      { type: "git_poll", intervalSeconds: 60, skills: ["qa"], debounceSeconds: 30 },
      { type: "cron", expression: "0 2 * * *", skills: ["design-review"] },
    ];
    const runner = createMockRunner();
    const log = vi.fn();

    const pollers = startPollers(config, runner, log);
    expect(pollers).toHaveLength(2);
  });
});
