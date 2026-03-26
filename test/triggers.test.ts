/**
 * Triggers tests — git poller HEAD detection, debounce, interval polling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGitPoller, getGitHead, parseCronExpression, parseCronField, matchesCronSchedule, createCronPoller, validateCronExpression } from "../src/triggers.js";
import type { GitPollTrigger, CronTrigger } from "../src/types.js";
import type { GitPollerDeps, CronPollerDeps, CronSchedule } from "../src/triggers.js";

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

// ── Cron tests ────────────────────────────────────────────────────

describe("parseCronField", () => {
  it("parses wildcard *", () => {
    const result = parseCronField("*", 0, 59);
    expect(result).toHaveLength(60);
    expect(result![0]).toBe(0);
    expect(result![59]).toBe(59);
  });

  it("parses specific number", () => {
    expect(parseCronField("5", 0, 59)).toEqual([5]);
  });

  it("parses range", () => {
    expect(parseCronField("1-5", 0, 59)).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses step */15", () => {
    expect(parseCronField("*/15", 0, 59)).toEqual([0, 15, 30, 45]);
  });

  it("parses range with step 1-10/3", () => {
    expect(parseCronField("1-10/3", 0, 59)).toEqual([1, 4, 7, 10]);
  });

  it("parses comma-separated values", () => {
    expect(parseCronField("1,15,30", 0, 59)).toEqual([1, 15, 30]);
  });

  it("parses mixed comma + range", () => {
    expect(parseCronField("1,5-7,20", 0, 59)).toEqual([1, 5, 6, 7, 20]);
  });

  it("rejects out-of-range number", () => {
    expect(parseCronField("60", 0, 59)).toBeNull();
  });

  it("rejects invalid range (start > end)", () => {
    expect(parseCronField("10-5", 0, 59)).toBeNull();
  });

  it("rejects step of 0", () => {
    expect(parseCronField("*/0", 0, 59)).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parseCronField("abc", 0, 59)).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseCronField("", 0, 59)).toBeNull();
  });
});

describe("parseCronExpression", () => {
  it("parses every minute: * * * * *", () => {
    const schedule = parseCronExpression("* * * * *");
    expect(schedule).not.toBeNull();
    expect(schedule!.minutes).toHaveLength(60);
    expect(schedule!.hours).toHaveLength(24);
  });

  it("parses specific time: 0 2 * * *", () => {
    const schedule = parseCronExpression("0 2 * * *");
    expect(schedule).not.toBeNull();
    expect(schedule!.minutes).toEqual([0]);
    expect(schedule!.hours).toEqual([2]);
  });

  it("parses weekday only: 0 9 * * 1-5", () => {
    const schedule = parseCronExpression("0 9 * * 1-5");
    expect(schedule).not.toBeNull();
    expect(schedule!.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses every 15 minutes: */15 * * * *", () => {
    const schedule = parseCronExpression("*/15 * * * *");
    expect(schedule).not.toBeNull();
    expect(schedule!.minutes).toEqual([0, 15, 30, 45]);
  });

  it("rejects 6-field expression", () => {
    expect(parseCronExpression("0 2 * * * *")).toBeNull();
  });

  it("rejects 4-field expression", () => {
    expect(parseCronExpression("0 2 * *")).toBeNull();
  });

  it("rejects invalid minute (60)", () => {
    expect(parseCronExpression("60 * * * *")).toBeNull();
  });

  it("rejects invalid hour (25)", () => {
    expect(parseCronExpression("0 25 * * *")).toBeNull();
  });

  it("rejects invalid day-of-week (7)", () => {
    expect(parseCronExpression("0 0 * * 7")).toBeNull();
  });
});

describe("matchesCronSchedule", () => {
  it("matches exact time", () => {
    const schedule = parseCronExpression("30 14 * * *")!;
    // 2026-03-26 14:30 (Thursday = day 4)
    const date = new Date(2026, 2, 26, 14, 30, 0);
    expect(matchesCronSchedule(schedule, date)).toBe(true);
  });

  it("does not match wrong hour", () => {
    const schedule = parseCronExpression("30 14 * * *")!;
    const date = new Date(2026, 2, 26, 15, 30, 0);
    expect(matchesCronSchedule(schedule, date)).toBe(false);
  });

  it("does not match wrong minute", () => {
    const schedule = parseCronExpression("30 14 * * *")!;
    const date = new Date(2026, 2, 26, 14, 31, 0);
    expect(matchesCronSchedule(schedule, date)).toBe(false);
  });

  it("matches day-of-week range", () => {
    const schedule = parseCronExpression("0 9 * * 1-5")!;
    // 2026-03-26 is a Thursday (day 4)
    const thursday = new Date(2026, 2, 26, 9, 0, 0);
    expect(matchesCronSchedule(schedule, thursday)).toBe(true);
  });

  it("does not match weekend when weekday-only", () => {
    const schedule = parseCronExpression("0 9 * * 1-5")!;
    // 2026-03-29 is a Sunday (day 0)
    const sunday = new Date(2026, 2, 29, 9, 0, 0);
    expect(matchesCronSchedule(schedule, sunday)).toBe(false);
  });

  it("matches step schedule */15", () => {
    const schedule = parseCronExpression("*/15 * * * *")!;
    expect(matchesCronSchedule(schedule, new Date(2026, 2, 26, 10, 0, 0))).toBe(true);
    expect(matchesCronSchedule(schedule, new Date(2026, 2, 26, 10, 15, 0))).toBe(true);
    expect(matchesCronSchedule(schedule, new Date(2026, 2, 26, 10, 7, 0))).toBe(false);
  });

  it("matches specific month", () => {
    const schedule = parseCronExpression("0 0 1 6 *")!; // midnight on June 1
    const june1 = new Date(2026, 5, 1, 0, 0, 0); // month 5 = June
    expect(matchesCronSchedule(schedule, june1)).toBe(true);
    const jan1 = new Date(2026, 0, 1, 0, 0, 0);
    expect(matchesCronSchedule(schedule, jan1)).toBe(false);
  });
});

describe("createCronPoller", () => {
  function createCronConfig(overrides: Partial<CronTrigger> = {}): CronTrigger {
    return {
      type: "cron",
      expression: "30 14 * * *",
      skills: ["qa"],
      ...overrides,
    };
  }

  function createMockCronDeps(nowDate: Date): CronPollerDeps & {
    _intervalCallbacks: (() => void)[];
    advanceTimers: () => void;
  } {
    const intervalCallbacks: (() => void)[] = [];
    return {
      now: vi.fn().mockReturnValue(nowDate),
      setInterval: vi.fn((fn: () => void, _ms: number) => {
        intervalCallbacks.push(fn);
        return 1 as any;
      }),
      clearInterval: vi.fn(),
      _intervalCallbacks: intervalCallbacks,
      advanceTimers() {
        for (const cb of intervalCallbacks) cb();
      },
    };
  }

  it("returns null for invalid cron expression", () => {
    const poller = createCronPoller(
      createCronConfig({ expression: "bad" }),
      vi.fn(),
    );
    expect(poller).toBeNull();
  });

  it("fires when current time matches cron expression", () => {
    const trigger = vi.fn();
    // Time matches "30 14 * * *"
    const matchingTime = new Date(2026, 2, 26, 14, 30, 0);
    const deps = createMockCronDeps(matchingTime);

    const poller = createCronPoller(createCronConfig(), trigger, deps);
    expect(poller).not.toBeNull();
    poller!.start();

    expect(trigger).toHaveBeenCalledOnce();
    expect(trigger.mock.calls[0][0]).toEqual(["qa"]);
    expect(trigger.mock.calls[0][1]).toContain("Cron matched");
  });

  it("does not fire when current time does not match", () => {
    const trigger = vi.fn();
    // 14:31 does not match "30 14 * * *"
    const nonMatchingTime = new Date(2026, 2, 26, 14, 31, 0);
    const deps = createMockCronDeps(nonMatchingTime);

    const poller = createCronPoller(createCronConfig(), trigger, deps);
    poller!.start();

    expect(trigger).not.toHaveBeenCalled();
  });

  it("does not double-fire in the same minute", () => {
    const trigger = vi.fn();
    const matchingTime = new Date(2026, 2, 26, 14, 30, 0);
    const deps = createMockCronDeps(matchingTime);

    const poller = createCronPoller(createCronConfig(), trigger, deps);
    poller!.start(); // First check fires
    deps.advanceTimers(); // Second check same minute — should not fire again

    expect(trigger).toHaveBeenCalledOnce();
  });

  it("fires again at next matching minute", () => {
    const trigger = vi.fn();
    const time1 = new Date(2026, 2, 26, 14, 30, 0);
    const time2 = new Date(2026, 2, 27, 14, 30, 0); // next day
    const deps = createMockCronDeps(time1);

    const poller = createCronPoller(createCronConfig(), trigger, deps);
    poller!.start();
    expect(trigger).toHaveBeenCalledOnce();

    // Advance to next day's matching time
    (deps.now as any).mockReturnValue(time2);
    deps.advanceTimers();
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it("stop prevents future checks", () => {
    const trigger = vi.fn();
    const matchingTime = new Date(2026, 2, 26, 14, 30, 0);
    const deps = createMockCronDeps(matchingTime);

    const poller = createCronPoller(createCronConfig(), trigger, deps);
    poller!.start();
    poller!.stop();

    expect(deps.clearInterval).toHaveBeenCalled();
  });

  it("sets interval to 60 seconds", () => {
    const deps = createMockCronDeps(new Date(2026, 2, 26, 10, 0, 0));
    const poller = createCronPoller(createCronConfig(), vi.fn(), deps);
    poller!.start();

    expect(deps.setInterval).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });
});

describe("validateCronExpression", () => {
  it("returns null for valid expression", () => {
    expect(validateCronExpression("0 2 * * *")).toBeNull();
  });

  it("returns error for invalid expression", () => {
    const result = validateCronExpression("bad");
    expect(result).not.toBeNull();
    expect(result).toContain("Invalid cron expression");
  });
});
