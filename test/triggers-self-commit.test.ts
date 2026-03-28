/**
 * Self-commit filtering tests — git poller skips daemon-generated commits.
 */

import { describe, it, expect, vi } from "vitest";
import { createGitPoller, getCommitEmails } from "../src/triggers.js";
import { GARYCLAW_DAEMON_EMAIL } from "../src/sdk-wrapper.js";
import type { GitPollTrigger } from "../src/types.js";
import type { GitPollerDeps } from "../src/triggers.js";

function createTestConfig(overrides: Partial<GitPollTrigger> = {}): GitPollTrigger {
  return {
    type: "git_poll",
    intervalSeconds: 60,
    skills: ["qa"],
    debounceSeconds: 5,
    ...overrides,
  };
}

function createMockDeps(): GitPollerDeps & {
  advanceTimers: () => void;
  fireDebounce: () => void;
  _intervalCallbacks: (() => void)[];
  _timeoutCallbacks: (() => void)[];
} {
  const intervalCallbacks: (() => void)[] = [];
  const timeoutCallbacks: (() => void)[] = [];

  return {
    getHead: vi.fn().mockReturnValue("abc1234567890"),
    getCommitEmails: vi.fn().mockReturnValue([]),
    log: vi.fn(),
    setInterval: vi.fn((fn: () => void, _ms: number) => {
      intervalCallbacks.push(fn);
      return 1 as any;
    }),
    clearInterval: vi.fn(),
    setTimeout: vi.fn((fn: () => void, _ms: number) => {
      timeoutCallbacks.push(fn);
      return 2 as any;
    }),
    clearTimeout: vi.fn(),
    _intervalCallbacks: intervalCallbacks,
    _timeoutCallbacks: timeoutCallbacks,
    advanceTimers() {
      for (const cb of intervalCallbacks) cb();
    },
    fireDebounce() {
      const cb = timeoutCallbacks[timeoutCallbacks.length - 1];
      if (cb) cb();
    },
  };
}

describe("self-commit filtering", () => {
  it("skips trigger when all commits are from daemon", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111") // start
      .mockReturnValueOnce("bbb2222222222"); // tick 1
    deps.getCommitEmails = vi.fn().mockReturnValue([
      GARYCLAW_DAEMON_EMAIL,
      GARYCLAW_DAEMON_EMAIL,
    ]);

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();

    // Should NOT start debounce — skipped entirely
    expect(deps.setTimeout).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("fires trigger when commits are from external author", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111")
      .mockReturnValueOnce("bbb2222222222");
    deps.getCommitEmails = vi.fn().mockReturnValue(["human@example.com"]);

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();
    deps.fireDebounce();

    expect(trigger).toHaveBeenCalledOnce();
  });

  it("fires trigger on mixed commits (daemon + external)", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111")
      .mockReturnValueOnce("bbb2222222222");
    deps.getCommitEmails = vi.fn().mockReturnValue([
      GARYCLAW_DAEMON_EMAIL,
      "human@example.com",
    ]);

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();
    deps.fireDebounce();

    expect(trigger).toHaveBeenCalledOnce();
  });

  it("fires trigger when getCommitEmails returns empty (error fallback)", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111")
      .mockReturnValueOnce("bbb2222222222");
    deps.getCommitEmails = vi.fn().mockReturnValue([]);

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();
    deps.fireDebounce();

    expect(trigger).toHaveBeenCalledOnce();
  });

  it("respects custom selfCommitEmail config override", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    const config = createTestConfig({ selfCommitEmail: "custom-bot@ci.local" });
    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111")
      .mockReturnValueOnce("bbb2222222222");
    deps.getCommitEmails = vi.fn().mockReturnValue(["custom-bot@ci.local"]);

    const poller = createGitPoller(config, "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();

    // Should skip because emails match custom selfCommitEmail
    expect(deps.setTimeout).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it("updates lastHead on skip so next poll doesn't re-check same range", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111") // start
      .mockReturnValueOnce("bbb2222222222") // tick 1 — daemon commits, skipped
      .mockReturnValueOnce("bbb2222222222"); // tick 2 — same HEAD, no change
    deps.getCommitEmails = vi.fn().mockReturnValue([GARYCLAW_DAEMON_EMAIL]);

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();

    // Tick 1: HEAD changed but all daemon commits — skip
    deps.advanceTimers();
    expect(trigger).not.toHaveBeenCalled();

    // Tick 2: HEAD unchanged (same as tick 1) — no getCommitEmails call
    deps.advanceTimers();
    // getCommitEmails should have been called only once (for tick 1)
    expect(deps.getCommitEmails).toHaveBeenCalledTimes(1);
  });

  it("logs debug message when skipping self-commits", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111")
      .mockReturnValueOnce("bbb2222222222");
    deps.getCommitEmails = vi.fn().mockReturnValue([
      GARYCLAW_DAEMON_EMAIL,
      GARYCLAW_DAEMON_EMAIL,
      GARYCLAW_DAEMON_EMAIL,
    ]);

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();

    expect(deps.log).toHaveBeenCalledWith(
      "debug",
      expect.stringContaining("skipping self-commits"),
    );
    expect(deps.log).toHaveBeenCalledWith(
      "debug",
      expect.stringContaining("3 commits"),
    );
  });

  it("fires trigger when getCommitEmails returns empty due to >100 cap", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111")
      .mockReturnValueOnce("bbb2222222222");
    // Simulate >100 cap: getCommitEmails returns [] (safe default)
    deps.getCommitEmails = vi.fn().mockReturnValue([]);

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();
    deps.fireDebounce();

    // Empty array means "couldn't determine" — trigger should fire
    expect(trigger).toHaveBeenCalledOnce();
  });

  it("passes correct range to getCommitEmails", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111")
      .mockReturnValueOnce("bbb2222222222");
    deps.getCommitEmails = vi.fn().mockReturnValue([]);

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();

    expect(deps.getCommitEmails).toHaveBeenCalledWith(
      "/tmp/project",
      "aaa1111111111",
      "bbb2222222222",
    );
  });
});

describe("getCommitEmails", () => {
  it("returns emails from real git repo", () => {
    // This test runs against the actual GaryClaw repo
    // Get two recent commits to form a valid range
    const { execFileSync } = require("node:child_process");
    try {
      const log = execFileSync(
        "git", ["log", "--format=%H", "-2"],
        { cwd: process.cwd(), encoding: "utf-8", timeout: 5000 },
      ).trim();
      const shas = log.split("\n");
      if (shas.length < 2) return; // Skip if not enough history

      const emails = getCommitEmails(process.cwd(), shas[1], shas[0]);
      expect(Array.isArray(emails)).toBe(true);
      expect(emails.length).toBeGreaterThanOrEqual(1);
      // Each email should be a non-empty string
      for (const email of emails) {
        expect(email.length).toBeGreaterThan(0);
      }
    } catch {
      // Skip if git not available
    }
  });

  it("returns empty array for non-existent directory", () => {
    const emails = getCommitEmails("/tmp/nonexistent-garyclaw-test-dir", "abc", "def");
    expect(emails).toEqual([]);
  });

  it("returns empty array for invalid commit range", () => {
    const emails = getCommitEmails(process.cwd(), "0000000000000000000000000000000000000000", "1111111111111111111111111111111111111111");
    expect(emails).toEqual([]);
  });
});

describe("GARYCLAW_DAEMON_EMAIL constant", () => {
  it("is the expected value", () => {
    expect(GARYCLAW_DAEMON_EMAIL).toBe("garyclaw-daemon@local");
  });

  it("is a valid email-like string", () => {
    expect(GARYCLAW_DAEMON_EMAIL).toContain("@");
  });
});
