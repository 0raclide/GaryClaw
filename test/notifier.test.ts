/**
 * Notifier tests — notification formatting, summary generation, graceful failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Job, DaemonConfig } from "../src/types.js";

// Mock execSync to avoid actually sending notifications
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import {
  notifyJobComplete,
  notifyJobError,
  notifyEscalation,
  writeSummary,
  sendNotification,
} from "../src/notifier.js";

const TEST_DIR = join(process.cwd(), ".test-notifier-tmp");

function createTestJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-001",
    triggeredBy: "manual",
    triggerDetail: "CLI trigger",
    skills: ["qa"],
    projectDir: "/tmp/project",
    status: "complete",
    enqueuedAt: "2026-03-25T10:00:00.000Z",
    startedAt: "2026-03-25T10:00:01.000Z",
    completedAt: "2026-03-25T10:30:00.000Z",
    costUsd: 0.125,
    ...overrides,
  };
}

function createTestConfig(overrides: Partial<DaemonConfig["notifications"]> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: { dailyCostLimitUsd: 5, perJobCostLimitUsd: 1, maxJobsPerDay: 10 },
    notifications: {
      enabled: true,
      onComplete: true,
      onError: true,
      onEscalation: true,
      ...overrides,
    },
    orchestrator: {
      maxTurnsPerSegment: 15,
      relayThresholdRatio: 0.85,
      maxRelaySessions: 10,
      askTimeoutMs: 300000,
    },
    logging: { level: "info", retainDays: 7 },
  };
}

describe("notifyJobComplete", () => {
  beforeEach(() => {
    vi.mocked(execSync).mockClear();
  });

  it("sends notification for completed job", () => {
    const job = createTestJob();
    const config = createTestConfig();
    notifyJobComplete(job, config);

    expect(execSync).toHaveBeenCalledOnce();
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain("display notification");
    expect(cmd).toContain("/qa finished");
    expect(cmd).toContain("$0.125");
  });

  it("skips when notifications disabled", () => {
    const job = createTestJob();
    const config = createTestConfig({ enabled: false });
    notifyJobComplete(job, config);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("skips when onComplete disabled", () => {
    const job = createTestJob();
    const config = createTestConfig({ onComplete: false });
    notifyJobComplete(job, config);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("formats multi-skill notification", () => {
    const job = createTestJob({ skills: ["qa", "design-review", "ship"] });
    const config = createTestConfig();
    notifyJobComplete(job, config);

    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain("/qa");
    expect(cmd).toContain("/design-review");
    expect(cmd).toContain("/ship");
  });
});

describe("notifyJobError", () => {
  beforeEach(() => {
    vi.mocked(execSync).mockClear();
  });

  it("sends notification for failed job", () => {
    const job = createTestJob({ status: "failed", error: "Auth expired" });
    const config = createTestConfig();
    notifyJobError(job, config);

    expect(execSync).toHaveBeenCalledOnce();
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain("Job Failed");
    expect(cmd).toContain("Auth expired");
  });

  it("skips when onError disabled", () => {
    const job = createTestJob({ status: "failed", error: "boom" });
    const config = createTestConfig({ onError: false });
    notifyJobError(job, config);
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe("notifyEscalation", () => {
  beforeEach(() => {
    vi.mocked(execSync).mockClear();
  });

  it("sends escalation notification", () => {
    const config = createTestConfig();
    notifyEscalation("Should we delete the production database?", config);

    expect(execSync).toHaveBeenCalledOnce();
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain("Escalation");
    expect(cmd).toContain("delete the production database");
  });
});

describe("sendNotification", () => {
  beforeEach(() => {
    vi.mocked(execSync).mockClear();
  });

  it("returns true on success", () => {
    vi.mocked(execSync).mockReturnValue(Buffer.from(""));
    const result = sendNotification("Title", "Message");
    expect(result).toBe(true);
  });

  it("returns false when osascript fails", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("osascript not found");
    });
    const result = sendNotification("Title", "Message");
    expect(result).toBe(false);
  });

  it("escapes double quotes in title and message", () => {
    sendNotification('Has "quotes"', 'Also "quoted"');
    const cmd = vi.mocked(execSync).mock.calls[0][0] as string;
    expect(cmd).toContain('Has \\"quotes\\"');
    expect(cmd).toContain('Also \\"quoted\\"');
  });
});

describe("writeSummary", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("writes summary.md with job details", () => {
    const job = createTestJob();
    const jobDir = join(TEST_DIR, "job-001");
    writeSummary(job, jobDir);

    const content = readFileSync(join(jobDir, "summary.md"), "utf-8");
    expect(content).toContain("# Job Summary");
    expect(content).toContain("job-001");
    expect(content).toContain("/qa");
    expect(content).toContain("$0.125");
    expect(content).toContain("manual");
  });

  it("includes error section for failed jobs", () => {
    const job = createTestJob({ status: "failed", error: "Segment error: timeout" });
    const jobDir = join(TEST_DIR, "job-fail");
    writeSummary(job, jobDir);

    const content = readFileSync(join(jobDir, "summary.md"), "utf-8");
    expect(content).toContain("## Error");
    expect(content).toContain("Segment error: timeout");
  });

  it("includes report path when present", () => {
    const job = createTestJob({ reportPath: "/tmp/.garyclaw/report.md" });
    const jobDir = join(TEST_DIR, "job-rpt");
    writeSummary(job, jobDir);

    const content = readFileSync(join(jobDir, "summary.md"), "utf-8");
    expect(content).toContain("## Report");
    expect(content).toContain("/tmp/.garyclaw/report.md");
  });

  it("creates directory if it does not exist", () => {
    const job = createTestJob();
    const jobDir = join(TEST_DIR, "nested", "job-002");
    writeSummary(job, jobDir);
    expect(existsSync(join(jobDir, "summary.md"))).toBe(true);
  });
});
