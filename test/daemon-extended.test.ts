/**
 * Daemon extended tests — createDaemonLogger rotation, buildIPCHandler edge cases,
 * validateDaemonConfig edge cases, cleanupDaemonFiles, PID helpers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  validateDaemonConfig,
  loadDaemonConfig,
  createDaemonLogger,
  buildIPCHandler,
  isPidAlive,
  readPidFile,
  writePidFile,
  cleanupDaemonFiles,
} from "../src/daemon.js";

const TEST_DIR = join(process.cwd(), ".test-daemon-ext-tmp");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── createDaemonLogger ─────────────────────────────────────────

describe("createDaemonLogger", () => {
  it("writes log lines to file", () => {
    const log = createDaemonLogger(TEST_DIR, "info");
    log("info", "Hello world");

    const content = readFileSync(join(TEST_DIR, "daemon.log"), "utf-8");
    expect(content).toContain("Hello world");
    expect(content).toContain("[INFO]");
  });

  it("respects log level threshold — filters debug when level=info", () => {
    const log = createDaemonLogger(TEST_DIR, "info");
    log("debug", "Debug message");
    log("info", "Info message");

    const content = readFileSync(join(TEST_DIR, "daemon.log"), "utf-8");
    expect(content).not.toContain("Debug message");
    expect(content).toContain("Info message");
  });

  it("allows all levels when level=debug", () => {
    const log = createDaemonLogger(TEST_DIR, "debug");
    log("debug", "Debug message");
    log("info", "Info message");

    const content = readFileSync(join(TEST_DIR, "daemon.log"), "utf-8");
    expect(content).toContain("Debug message");
    expect(content).toContain("Info message");
  });

  it("filters info and debug when level=warn", () => {
    const log = createDaemonLogger(TEST_DIR, "warn");
    log("debug", "D");
    log("info", "I");
    log("warn", "W");
    log("error", "E");

    const content = readFileSync(join(TEST_DIR, "daemon.log"), "utf-8");
    expect(content).not.toContain("[DEBUG]");
    expect(content).not.toContain("[INFO]");
    expect(content).toContain("[WARN]");
    expect(content).toContain("[ERROR]");
  });

  it("rotates log when exceeding 10MB", () => {
    const logPath = join(TEST_DIR, "daemon.log");
    // Write a file just over 10MB
    const bigContent = "x".repeat(10 * 1024 * 1024 + 1);
    writeFileSync(logPath, bigContent, "utf-8");

    const log = createDaemonLogger(TEST_DIR, "info");
    log("info", "After rotation");

    // Original should have been renamed to .1
    expect(existsSync(logPath + ".1")).toBe(true);
    // New log should contain the post-rotation message
    const newContent = readFileSync(logPath, "utf-8");
    expect(newContent).toContain("After rotation");
    // .1 file should be the big one
    const rotatedSize = statSync(logPath + ".1").size;
    expect(rotatedSize).toBeGreaterThan(10 * 1024 * 1024);
  });

  it("does not rotate when under 10MB", () => {
    const logPath = join(TEST_DIR, "daemon.log");
    writeFileSync(logPath, "small content\n", "utf-8");

    const log = createDaemonLogger(TEST_DIR, "info");
    log("info", "More content");

    expect(existsSync(logPath + ".1")).toBe(false);
    const content = readFileSync(logPath, "utf-8");
    expect(content).toContain("small content");
    expect(content).toContain("More content");
  });

  it("includes ISO timestamp in log lines", () => {
    const log = createDaemonLogger(TEST_DIR, "info");
    log("info", "Timestamp test");

    const content = readFileSync(join(TEST_DIR, "daemon.log"), "utf-8");
    // ISO date pattern: YYYY-MM-DDTHH:MM:SS
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
  });
});

// ── buildIPCHandler ────────────────────────────────────────────

describe("buildIPCHandler", () => {
  function createMockRunner() {
    return {
      getState: vi.fn().mockReturnValue({
        version: 1,
        jobs: [],
        dailyCost: { date: "2026-03-25", totalUsd: 0.5, jobCount: 2 },
      }),
      isRunning: vi.fn().mockReturnValue(false),
      enqueue: vi.fn().mockReturnValue("job-123"),
      processNext: vi.fn(),
      updateBudget: vi.fn(),
    };
  }

  it("handles 'status' request", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now() - 60000);

    const resp = await handler({ type: "status" });
    expect(resp.ok).toBe(true);
    expect(resp.data).toHaveProperty("running", false);
    expect(resp.data).toHaveProperty("queuedCount", 0);
    expect(resp.data).toHaveProperty("uptimeSeconds");
  });

  it("computes uptime correctly", async () => {
    const runner = createMockRunner();
    const startTime = Date.now() - 120_000; // 2 minutes ago
    const handler = buildIPCHandler(runner, startTime);

    const resp = await handler({ type: "status" });
    const uptime = (resp.data as any).uptimeSeconds;
    expect(uptime).toBeGreaterThanOrEqual(119);
    expect(uptime).toBeLessThanOrEqual(121);
  });

  it("includes current job in status when running", async () => {
    const runner = createMockRunner();
    runner.getState.mockReturnValue({
      version: 1,
      jobs: [
        {
          id: "job-running",
          skills: ["qa"],
          status: "running",
          triggeredBy: "manual",
          enqueuedAt: "2026-03-25T00:00:00Z",
          costUsd: 0.1,
          startedAt: "2026-03-25T00:01:00Z",
          projectDir: "/tmp",
          triggerDetail: "CLI",
        },
      ],
      dailyCost: { date: "2026-03-25", totalUsd: 0, jobCount: 0 },
    });
    runner.isRunning.mockReturnValue(true);

    const handler = buildIPCHandler(runner, Date.now());
    const resp = await handler({ type: "status" });
    expect((resp.data as any).currentJob).toBeTruthy();
    expect((resp.data as any).currentJob.id).toBe("job-running");
  });

  it("handles 'trigger' with valid skills", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({ type: "trigger", skills: ["qa", "ship"] });
    expect(resp.ok).toBe(true);
    expect((resp.data as any).jobId).toBe("job-123");
    expect(runner.enqueue).toHaveBeenCalledWith(["qa", "ship"], "manual", "CLI trigger", undefined);
  });

  it("rejects 'trigger' with empty skills", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({ type: "trigger", skills: [] });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("non-empty");
  });

  it("rejects 'trigger' when skills is not an array", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({ type: "trigger" } as any);
    expect(resp.ok).toBe(false);
  });

  it("returns error when enqueue is rejected (budget/dedup)", async () => {
    const runner = createMockRunner();
    runner.enqueue.mockReturnValue(null);
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({ type: "trigger", skills: ["qa"] });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("rejected");
  });

  it("handles 'queue' request", async () => {
    const runner = createMockRunner();
    runner.getState.mockReturnValue({
      version: 1,
      jobs: [
        {
          id: "j1", skills: ["qa"], status: "queued",
          triggeredBy: "git_poll", enqueuedAt: "2026-03-25T00:00:00Z", costUsd: 0,
          projectDir: "/tmp", triggerDetail: "new commit",
        },
      ],
      dailyCost: { date: "2026-03-25", totalUsd: 0, jobCount: 0 },
    });

    const handler = buildIPCHandler(runner, Date.now());
    const resp = await handler({ type: "queue" });
    expect(resp.ok).toBe(true);
    const jobs = (resp.data as any).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("j1");
    expect(jobs[0].triggeredBy).toBe("git_poll");
  });

  it("returns error for unknown request type", async () => {
    const runner = createMockRunner();
    const handler = buildIPCHandler(runner, Date.now());

    const resp = await handler({ type: "unknown" } as any);
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Unknown");
  });
});

// ── validateDaemonConfig edge cases ────────────────────────────

describe("validateDaemonConfig edge cases", () => {
  const validConfig = {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [{ type: "git_poll", intervalSeconds: 60, skills: ["qa"], branch: "main" }],
    budget: { dailyCostLimitUsd: 5, perJobCostLimitUsd: 1, maxJobsPerDay: 10 },
    notifications: { enabled: true, onComplete: true, onError: true, onEscalation: false },
    orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
    logging: { level: "info", retainDays: 7 },
  };

  it("accepts valid config", () => {
    expect(validateDaemonConfig(validConfig)).toBeNull();
  });

  it("rejects null", () => {
    expect(validateDaemonConfig(null)).toBe("Config must be an object");
  });

  it("rejects non-object", () => {
    expect(validateDaemonConfig("string")).toBe("Config must be an object");
  });

  it("rejects wrong version", () => {
    expect(validateDaemonConfig({ ...validConfig, version: 2 })).toBe("Config version must be 1");
  });

  it("rejects empty projectDir", () => {
    expect(validateDaemonConfig({ ...validConfig, projectDir: "" })).toBe("projectDir is required");
  });

  it("rejects non-string projectDir", () => {
    expect(validateDaemonConfig({ ...validConfig, projectDir: 42 })).toBe("projectDir is required");
  });

  it("rejects triggers as non-array", () => {
    expect(validateDaemonConfig({ ...validConfig, triggers: "not-array" })).toBe("triggers must be an array");
  });

  it("rejects budget with zero dailyCostLimitUsd", () => {
    const bad = { ...validConfig, budget: { ...validConfig.budget, dailyCostLimitUsd: 0 } };
    expect(validateDaemonConfig(bad)).toContain("dailyCostLimitUsd");
  });

  it("rejects budget with negative perJobCostLimitUsd", () => {
    const bad = { ...validConfig, budget: { ...validConfig.budget, perJobCostLimitUsd: -1 } };
    expect(validateDaemonConfig(bad)).toContain("perJobCostLimitUsd");
  });

  it("rejects trigger with unknown type", () => {
    const bad = { ...validConfig, triggers: [{ type: "webhook", intervalSeconds: 60, skills: ["qa"] }] };
    expect(validateDaemonConfig(bad)).toContain('type must be "git_poll" or "cron"');
  });

  it("rejects trigger with zero intervalSeconds", () => {
    const bad = { ...validConfig, triggers: [{ type: "git_poll", intervalSeconds: 0, skills: ["qa"] }] };
    expect(validateDaemonConfig(bad)).toContain("intervalSeconds");
  });

  it("rejects trigger with empty skills array", () => {
    const bad = { ...validConfig, triggers: [{ type: "git_poll", intervalSeconds: 60, skills: [] }] };
    expect(validateDaemonConfig(bad)).toContain("skills must be a non-empty array");
  });

  it("accepts config with no triggers", () => {
    expect(validateDaemonConfig({ ...validConfig, triggers: [] })).toBeNull();
  });
});

// ── loadDaemonConfig ───────────────────────────────────────────

describe("loadDaemonConfig", () => {
  it("returns null when config file doesn't exist", () => {
    expect(loadDaemonConfig(TEST_DIR)).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    writeFileSync(join(TEST_DIR, "daemon.json"), "{bad json}", "utf-8");
    expect(loadDaemonConfig(TEST_DIR)).toBeNull();
  });

  it("returns null for invalid config", () => {
    writeFileSync(join(TEST_DIR, "daemon.json"), JSON.stringify({ version: 99 }), "utf-8");
    expect(loadDaemonConfig(TEST_DIR)).toBeNull();
  });

  it("loads valid config", () => {
    const valid = {
      version: 1,
      projectDir: "/tmp/project",
      triggers: [],
      budget: { dailyCostLimitUsd: 5, perJobCostLimitUsd: 1, maxJobsPerDay: 10 },
      notifications: { enabled: false, onComplete: false, onError: false, onEscalation: false },
      orchestrator: { maxTurnsPerSegment: 15, relayThresholdRatio: 0.85, maxRelaySessions: 10, askTimeoutMs: 300000 },
      logging: { level: "info", retainDays: 7 },
    };
    writeFileSync(join(TEST_DIR, "daemon.json"), JSON.stringify(valid), "utf-8");
    const result = loadDaemonConfig(TEST_DIR);
    expect(result).not.toBeNull();
    expect(result!.projectDir).toBe("/tmp/project");
  });
});

// ── PID helpers ────────────────────────────────────────────────

describe("PID helpers", () => {
  it("readPidFile returns null when no file", () => {
    expect(readPidFile(TEST_DIR)).toBeNull();
  });

  it("readPidFile returns null for non-numeric content", () => {
    writeFileSync(join(TEST_DIR, "daemon.pid"), "not-a-number", "utf-8");
    expect(readPidFile(TEST_DIR)).toBeNull();
  });

  it("readPidFile reads valid PID", () => {
    writeFileSync(join(TEST_DIR, "daemon.pid"), "12345", "utf-8");
    expect(readPidFile(TEST_DIR)).toBe(12345);
  });

  it("writePidFile creates PID file", () => {
    writePidFile(TEST_DIR, 99999);
    expect(readFileSync(join(TEST_DIR, "daemon.pid"), "utf-8")).toBe("99999");
  });

  it("isPidAlive returns true for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("isPidAlive returns false for nonexistent PID", () => {
    expect(isPidAlive(999999999)).toBe(false);
  });

  it("cleanupDaemonFiles removes PID and socket files", () => {
    writeFileSync(join(TEST_DIR, "daemon.pid"), "123", "utf-8");
    writeFileSync(join(TEST_DIR, "daemon.sock"), "sock", "utf-8");
    cleanupDaemonFiles(TEST_DIR);
    expect(existsSync(join(TEST_DIR, "daemon.pid"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "daemon.sock"))).toBe(false);
  });

  it("cleanupDaemonFiles doesn't throw when files don't exist", () => {
    expect(() => cleanupDaemonFiles(TEST_DIR)).not.toThrow();
  });
});
