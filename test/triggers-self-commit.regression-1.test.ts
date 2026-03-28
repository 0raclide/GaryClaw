/**
 * Regression: ISSUE-002 — getCommitEmails >100 cap returns [] instead of truncated list
 * Found by /qa on 2026-03-28
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md
 *
 * Regression: ISSUE-004 — buildSdkEnv only tags commits in daemon context
 * Found by /qa on 2026-03-28
 */

import { describe, it, expect, vi } from "vitest";
import { createGitPoller } from "../src/triggers.js";
import { buildSdkEnv, GARYCLAW_DAEMON_EMAIL } from "../src/sdk-wrapper.js";
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

describe("ISSUE-002 regression: >100 cap returns safe default", () => {
  it("trigger fires when getCommitEmails returns [] (cap hit scenario)", () => {
    // Before fix: .slice(0, 100) returned first 100 emails, which could be
    // all-daemon, causing the trigger to skip even when commit 101+ was human.
    // After fix: >100 returns [], which means "don't filter" — trigger fires.
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111")
      .mockReturnValueOnce("bbb2222222222");
    deps.getCommitEmails = vi.fn().mockReturnValue([]); // simulates >100 cap

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();
    deps.fireDebounce();

    expect(trigger).toHaveBeenCalledOnce();
  });

  it("trigger skips only when ALL emails confirmed as daemon (no truncation)", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111")
      .mockReturnValueOnce("bbb2222222222");
    // 3 daemon commits — small enough to be confident, not truncated
    deps.getCommitEmails = vi.fn().mockReturnValue([
      GARYCLAW_DAEMON_EMAIL,
      GARYCLAW_DAEMON_EMAIL,
      GARYCLAW_DAEMON_EMAIL,
    ]);

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();

    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("ISSUE-004 regression: buildSdkEnv daemon tagging is opt-in", () => {
  it("does NOT set GIT_COMMITTER fields by default (CLI context)", () => {
    // Before fix: every buildSdkEnv call set GIT_COMMITTER_EMAIL, meaning
    // direct CLI runs (garyclaw run qa) tagged commits as daemon-made.
    // The git poller would then skip those commits as "self-commits".
    const env = buildSdkEnv({ PATH: "/usr/bin", HOME: "/home/user" });
    expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
    expect(env.GIT_COMMITTER_NAME).toBeUndefined();
  });

  it("sets GIT_COMMITTER fields when tagDaemonCommits is true (daemon context)", () => {
    const env = buildSdkEnv(
      { PATH: "/usr/bin" },
      { tagDaemonCommits: true },
    );
    expect(env.GIT_COMMITTER_EMAIL).toBe(GARYCLAW_DAEMON_EMAIL);
    expect(env.GIT_COMMITTER_NAME).toBe("GaryClaw Daemon");
  });

  it("still strips ANTHROPIC_API_KEY regardless of tagging flag", () => {
    const env = buildSdkEnv(
      { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-secret" },
      { tagDaemonCommits: true },
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GIT_COMMITTER_EMAIL).toBe(GARYCLAW_DAEMON_EMAIL);
  });
});
