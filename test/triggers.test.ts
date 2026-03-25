/**
 * Triggers tests — git poller HEAD detection, debounce, interval polling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGitPoller, getGitHead } from "../src/triggers.js";
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
      // Fire all interval callbacks
      for (const cb of intervalCallbacks) cb();
    },
    fireDebounce() {
      // Fire the most recent timeout callback
      const cb = timeoutCallbacks[timeoutCallbacks.length - 1];
      if (cb) cb();
    },
  };
}

describe("createGitPoller", () => {
  it("records initial HEAD on start without triggering", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();

    expect(deps.getHead).toHaveBeenCalledWith("/tmp/project", undefined);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("detects HEAD change and triggers after debounce", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111") // start() initial poll
      .mockReturnValueOnce("bbb2222222222"); // first interval tick

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();

    // Simulate interval tick
    deps.advanceTimers();

    // Not triggered yet (debouncing)
    expect(trigger).not.toHaveBeenCalled();

    // Fire debounce timer
    deps.fireDebounce();

    expect(trigger).toHaveBeenCalledOnce();
    expect(trigger.mock.calls[0][0]).toEqual(["qa"]);
    expect(trigger.mock.calls[0][1]).toContain("HEAD changed");
    expect(trigger.mock.calls[0][1]).toContain("aaa1111");
    expect(trigger.mock.calls[0][1]).toContain("bbb2222");
  });

  it("ignores same HEAD", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn().mockReturnValue("same-head-always");

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();

    // Multiple ticks with same HEAD
    deps.advanceTimers();
    deps.advanceTimers();
    deps.advanceTimers();

    expect(trigger).not.toHaveBeenCalled();
  });

  it("debounce resets on rapid HEAD changes", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111") // start
      .mockReturnValueOnce("bbb2222222222") // tick 1
      .mockReturnValueOnce("ccc3333333333"); // tick 2

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();

    // First change
    deps.advanceTimers();
    expect(deps.setTimeout).toHaveBeenCalledTimes(1);

    // Second change before debounce fires — should clearTimeout and set new one
    deps.advanceTimers();
    expect(deps.clearTimeout).toHaveBeenCalledTimes(1);
    expect(deps.setTimeout).toHaveBeenCalledTimes(2);

    // Fire debounce — should use latest HEAD
    deps.fireDebounce();
    expect(trigger).toHaveBeenCalledOnce();
    expect(trigger.mock.calls[0][1]).toContain("ccc3333");
  });

  it("handles getHead returning null (git error)", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn().mockReturnValue(null);

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();

    deps.advanceTimers();
    deps.advanceTimers();

    expect(trigger).not.toHaveBeenCalled();
  });

  it("stop() clears interval and debounce timers", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa")
      .mockReturnValueOnce("bbb");

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers(); // Trigger debounce

    poller.stop();

    expect(deps.clearInterval).toHaveBeenCalled();
    expect(deps.clearTimeout).toHaveBeenCalled();
  });

  it("passes branch to getHead when configured", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    const config = createTestConfig({ branch: "develop" });
    const poller = createGitPoller(config, "/tmp/project", trigger, deps);
    poller.start();

    expect(deps.getHead).toHaveBeenCalledWith("/tmp/project", "develop");
  });

  it("uses default debounce of 30s when not specified", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    const config = createTestConfig();
    delete (config as any).debounceSeconds;

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa")
      .mockReturnValueOnce("bbb");

    const poller = createGitPoller(config, "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();

    expect(deps.setTimeout).toHaveBeenCalledWith(expect.any(Function), 30000);
  });

  it("triggers with correct skills from config", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    const config = createTestConfig({ skills: ["qa", "design-review", "ship"] });
    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa")
      .mockReturnValueOnce("bbb");

    const poller = createGitPoller(config, "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();
    deps.fireDebounce();

    expect(trigger.mock.calls[0][0]).toEqual(["qa", "design-review", "ship"]);
  });

  it("uses configured debounce seconds", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    const config = createTestConfig({ debounceSeconds: 10 });
    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa")
      .mockReturnValueOnce("bbb");

    const poller = createGitPoller(config, "/tmp/project", trigger, deps);
    poller.start();
    deps.advanceTimers();

    expect(deps.setTimeout).toHaveBeenCalledWith(expect.any(Function), 10000);
  });

  it("can trigger multiple times for sequential HEAD changes", () => {
    const deps = createMockDeps();
    const trigger = vi.fn();

    deps.getHead = vi.fn()
      .mockReturnValueOnce("aaa1111111111") // start
      .mockReturnValueOnce("bbb2222222222") // tick 1
      .mockReturnValueOnce("bbb2222222222") // tick 2 (stable)
      .mockReturnValueOnce("ccc3333333333"); // tick 3 (new change)

    const poller = createGitPoller(createTestConfig(), "/tmp/project", trigger, deps);
    poller.start();

    // First change + debounce
    deps.advanceTimers();
    deps.fireDebounce();
    expect(trigger).toHaveBeenCalledTimes(1);

    // Same HEAD — no trigger
    deps.advanceTimers();

    // New change + debounce
    deps.advanceTimers();
    deps.fireDebounce();
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it("stop is safe to call multiple times", () => {
    const deps = createMockDeps();
    const poller = createGitPoller(createTestConfig(), "/tmp/project", vi.fn(), deps);
    poller.start();
    poller.stop();
    poller.stop(); // Should not throw
  });

  it("stop is safe before start", () => {
    const deps = createMockDeps();
    const poller = createGitPoller(createTestConfig(), "/tmp/project", vi.fn(), deps);
    poller.stop(); // Should not throw
  });

  it("uses configured interval seconds", () => {
    const deps = createMockDeps();
    const config = createTestConfig({ intervalSeconds: 120 });

    const poller = createGitPoller(config, "/tmp/project", vi.fn(), deps);
    poller.start();

    expect(deps.setInterval).toHaveBeenCalledWith(expect.any(Function), 120000);
  });
});

describe("getGitHead", () => {
  it("returns HEAD hash for current repo", () => {
    // This test runs against the actual GaryClaw repo
    const head = getGitHead(process.cwd());
    expect(head).toBeTruthy();
    expect(head!.length).toBe(40); // Full SHA
  });

  it("returns null for non-existent directory", () => {
    const head = getGitHead("/tmp/nonexistent-garyclaw-test-dir");
    expect(head).toBeNull();
  });
});
