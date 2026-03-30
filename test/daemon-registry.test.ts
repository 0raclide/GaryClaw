/**
 * Daemon Registry tests — instance discovery, global budget, cross-instance dedup, migration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DaemonState, GlobalBudget, Job } from "../src/types.js";
import {
  resolveInstanceName,
  instanceDir,
  ensureInstanceDir,
  listInstances,
  readGlobalBudget,
  updateGlobalBudget,
  isSkillSetActive,
  getCompletedTodoTitles,
  migrateToInstanceDir,
  setGlobalRateLimitHold,
  clearGlobalRateLimitHold,
} from "../src/daemon-registry.js";
import { isBudgetLocked } from "../src/budget-lock.js";

const TEST_DIR = join(process.cwd(), ".test-registry-tmp");

function makeDaemonsDir(): string {
  const dir = join(TEST_DIR, "daemons");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeInstancePid(name: string, pid: number): void {
  const dir = join(TEST_DIR, "daemons", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "daemon.pid"), String(pid), "utf-8");
}

function writeInstanceState(name: string, state: DaemonState): void {
  const dir = join(TEST_DIR, "daemons", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "daemon-state.json"), JSON.stringify(state), "utf-8");
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-001",
    triggeredBy: "manual",
    triggerDetail: "test",
    skills: ["qa"],
    projectDir: "/tmp/project",
    status: "queued",
    enqueuedAt: new Date().toISOString(),
    costUsd: 0,
    ...overrides,
  };
}

function makeState(jobs: Job[]): DaemonState {
  return {
    version: 1,
    jobs,
    dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
  };
}

describe("Daemon Registry", () => {
  beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  // ── resolveInstanceName ──────────────────────────────────────

  describe("resolveInstanceName", () => {
    it("returns 'default' for undefined", () => {
      expect(resolveInstanceName()).toBe("default");
    });

    it("returns 'default' for empty string", () => {
      expect(resolveInstanceName("")).toBe("default");
    });

    it("returns 'default' for whitespace-only", () => {
      expect(resolveInstanceName("   ")).toBe("default");
    });

    it("returns trimmed name for valid input", () => {
      expect(resolveInstanceName("review-bot")).toBe("review-bot");
    });
  });

  // ── instanceDir ──────────────────────────────────────────────

  describe("instanceDir", () => {
    it("constructs path under daemons/ with name", () => {
      const dir = instanceDir("/foo/.garyclaw", "bot");
      expect(dir).toBe("/foo/.garyclaw/daemons/bot");
    });

    it("uses 'default' for empty name", () => {
      const dir = instanceDir("/foo/.garyclaw", "");
      expect(dir).toBe("/foo/.garyclaw/daemons/default");
    });
  });

  // ── ensureInstanceDir ────────────────────────────────────────

  describe("ensureInstanceDir", () => {
    it("creates the directory", () => {
      const dir = ensureInstanceDir(TEST_DIR, "test-instance");
      expect(existsSync(dir)).toBe(true);
    });
  });

  // ── listInstances ────────────────────────────────────────────

  describe("listInstances", () => {
    it("returns empty array when no daemons/ dir", () => {
      expect(listInstances(TEST_DIR)).toEqual([]);
    });

    it("returns empty array when daemons/ dir is empty", () => {
      makeDaemonsDir();
      expect(listInstances(TEST_DIR)).toEqual([]);
    });

    it("finds one alive instance", () => {
      // Use current process PID as a known-alive PID
      writeInstancePid("default", process.pid);

      const instances = listInstances(TEST_DIR);
      expect(instances).toHaveLength(1);
      expect(instances[0].name).toBe("default");
      expect(instances[0].pid).toBe(process.pid);
      expect(instances[0].alive).toBe(true);
      expect(instances[0].socketPath).toContain("daemon.sock");
      expect(instances[0].instanceDir).toContain("daemons/default");
    });

    it("finds stale instance (dead PID)", () => {
      writeInstancePid("stale-bot", 999999999);

      const instances = listInstances(TEST_DIR);
      expect(instances).toHaveLength(1);
      expect(instances[0].name).toBe("stale-bot");
      expect(instances[0].alive).toBe(false);
    });

    it("finds multiple instances with mixed status", () => {
      writeInstancePid("alive", process.pid);
      writeInstancePid("dead", 999999999);

      const instances = listInstances(TEST_DIR);
      expect(instances).toHaveLength(2);

      const alive = instances.find((i) => i.name === "alive");
      const dead = instances.find((i) => i.name === "dead");
      expect(alive?.alive).toBe(true);
      expect(dead?.alive).toBe(false);
    });

    it("skips directories without PID file", () => {
      makeDaemonsDir();
      mkdirSync(join(TEST_DIR, "daemons", "no-pid"), { recursive: true });

      const instances = listInstances(TEST_DIR);
      expect(instances).toHaveLength(0);
    });

    it("skips PID files with invalid content", () => {
      const dir = join(TEST_DIR, "daemons", "bad");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "daemon.pid"), "not-a-number", "utf-8");

      const instances = listInstances(TEST_DIR);
      expect(instances).toHaveLength(0);
    });

    it("handles corrupted PID file gracefully", () => {
      const dir = join(TEST_DIR, "daemons", "corrupt");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "daemon.pid"), "", "utf-8");

      const instances = listInstances(TEST_DIR);
      expect(instances).toHaveLength(0);
    });
  });

  // ── readGlobalBudget ─────────────────────────────────────────

  describe("readGlobalBudget", () => {
    it("returns fresh budget when file missing", () => {
      const budget = readGlobalBudget(TEST_DIR);
      expect(budget.totalUsd).toBe(0);
      expect(budget.jobCount).toBe(0);
      expect(budget.date).toBe(new Date().toISOString().slice(0, 10));
      expect(budget.byInstance).toEqual({});
    });

    it("reads valid budget file", () => {
      const today = new Date().toISOString().slice(0, 10);
      const data: GlobalBudget = {
        date: today,
        totalUsd: 2.5,
        jobCount: 3,
        byInstance: { default: { totalUsd: 2.5, jobCount: 3 } },
      };
      writeFileSync(join(TEST_DIR, "global-budget.json"), JSON.stringify(data), "utf-8");

      const budget = readGlobalBudget(TEST_DIR);
      expect(budget.totalUsd).toBe(2.5);
      expect(budget.jobCount).toBe(3);
    });

    it("resets on date rollover", () => {
      const data: GlobalBudget = {
        date: "2020-01-01",
        totalUsd: 99,
        jobCount: 50,
        byInstance: {},
      };
      writeFileSync(join(TEST_DIR, "global-budget.json"), JSON.stringify(data), "utf-8");

      const budget = readGlobalBudget(TEST_DIR);
      expect(budget.totalUsd).toBe(0);
      expect(budget.jobCount).toBe(0);
    });

    it("returns fresh budget for corrupt file", () => {
      writeFileSync(join(TEST_DIR, "global-budget.json"), "not-json", "utf-8");

      const budget = readGlobalBudget(TEST_DIR);
      expect(budget.totalUsd).toBe(0);
    });

    it("returns fresh budget for invalid schema", () => {
      writeFileSync(join(TEST_DIR, "global-budget.json"), JSON.stringify({ foo: 1 }), "utf-8");

      const budget = readGlobalBudget(TEST_DIR);
      expect(budget.totalUsd).toBe(0);
    });
  });

  // ── updateGlobalBudget ───────────────────────────────────────

  describe("updateGlobalBudget", () => {
    it("creates file on first write", () => {
      const budget = updateGlobalBudget(TEST_DIR, 0.5, "default");

      expect(budget.totalUsd).toBe(0.5);
      expect(budget.jobCount).toBe(1);
      expect(existsSync(join(TEST_DIR, "global-budget.json"))).toBe(true);
    });

    it("increments existing budget", () => {
      updateGlobalBudget(TEST_DIR, 1.0, "default");
      const budget = updateGlobalBudget(TEST_DIR, 0.5, "default");

      expect(budget.totalUsd).toBe(1.5);
      expect(budget.jobCount).toBe(2);
    });

    it("resets on daily rollover then adds", () => {
      const oldData: GlobalBudget = {
        date: "2020-01-01",
        totalUsd: 99,
        jobCount: 50,
        byInstance: {},
      };
      writeFileSync(join(TEST_DIR, "global-budget.json"), JSON.stringify(oldData), "utf-8");

      const budget = updateGlobalBudget(TEST_DIR, 0.25, "bot");

      expect(budget.totalUsd).toBe(0.25);
      expect(budget.jobCount).toBe(1);
    });

    it("tracks per-instance attribution", () => {
      updateGlobalBudget(TEST_DIR, 1.0, "default");
      updateGlobalBudget(TEST_DIR, 0.5, "review-bot");
      const budget = updateGlobalBudget(TEST_DIR, 0.3, "default");

      expect(budget.byInstance["default"].totalUsd).toBe(1.3);
      expect(budget.byInstance["default"].jobCount).toBe(2);
      expect(budget.byInstance["review-bot"].totalUsd).toBe(0.5);
      expect(budget.byInstance["review-bot"].jobCount).toBe(1);
    });

    it("total equals sum of instances", () => {
      updateGlobalBudget(TEST_DIR, 1.0, "a");
      updateGlobalBudget(TEST_DIR, 2.0, "b");
      const budget = updateGlobalBudget(TEST_DIR, 3.0, "c");

      expect(budget.totalUsd).toBe(6.0);
      expect(budget.jobCount).toBe(3);
    });

    it("persists to disk", () => {
      updateGlobalBudget(TEST_DIR, 1.5, "default");

      const raw = JSON.parse(readFileSync(join(TEST_DIR, "global-budget.json"), "utf-8"));
      expect(raw.totalUsd).toBe(1.5);
    });

    it("resolves empty instance name to default", () => {
      const budget = updateGlobalBudget(TEST_DIR, 1.0, "");

      expect(budget.byInstance["default"]).toBeDefined();
      expect(budget.byInstance["default"].totalUsd).toBe(1.0);
    });

    it("handles concurrent-like rapid writes", () => {
      for (let i = 0; i < 10; i++) {
        updateGlobalBudget(TEST_DIR, 0.1, "default");
      }
      const budget = readGlobalBudget(TEST_DIR);
      expect(budget.jobCount).toBe(10);
      expect(budget.totalUsd).toBeCloseTo(1.0, 5);
    });
  });

  // ── isSkillSetActive ─────────────────────────────────────────

  describe("isSkillSetActive", () => {
    it("returns false when no daemons dir", () => {
      expect(isSkillSetActive(TEST_DIR, ["qa"])).toBe(false);
    });

    it("returns false when no instances have matching skills", () => {
      writeInstanceState("default", makeState([
        makeJob({ skills: ["design-review"], status: "queued" }),
      ]));

      expect(isSkillSetActive(TEST_DIR, ["qa"])).toBe(false);
    });

    it("returns true when skills queued in one instance", () => {
      writeInstanceState("default", makeState([
        makeJob({ skills: ["qa"], status: "queued" }),
      ]));

      expect(isSkillSetActive(TEST_DIR, ["qa"])).toBe(true);
    });

    it("returns true when skills running in one instance", () => {
      writeInstanceState("bot", makeState([
        makeJob({ skills: ["qa"], status: "running" }),
      ]));

      expect(isSkillSetActive(TEST_DIR, ["qa"])).toBe(true);
    });

    it("ignores completed jobs", () => {
      writeInstanceState("default", makeState([
        makeJob({ skills: ["qa"], status: "complete" }),
      ]));

      expect(isSkillSetActive(TEST_DIR, ["qa"])).toBe(false);
    });

    it("ignores failed jobs", () => {
      writeInstanceState("default", makeState([
        makeJob({ skills: ["qa"], status: "failed" }),
      ]));

      expect(isSkillSetActive(TEST_DIR, ["qa"])).toBe(false);
    });

    it("finds skills across multiple instances", () => {
      writeInstanceState("instance-a", makeState([
        makeJob({ skills: ["design-review"], status: "queued" }),
      ]));
      writeInstanceState("instance-b", makeState([
        makeJob({ skills: ["qa"], status: "running" }),
      ]));

      expect(isSkillSetActive(TEST_DIR, ["qa"])).toBe(true);
      expect(isSkillSetActive(TEST_DIR, ["design-review"])).toBe(true);
    });

    it("excludes specified instance from check", () => {
      writeInstanceState("default", makeState([
        makeJob({ skills: ["qa"], status: "queued" }),
      ]));

      // Exclude default — should return false
      expect(isSkillSetActive(TEST_DIR, ["qa"], "default")).toBe(false);
    });

    it("still finds in other instances when one is excluded", () => {
      writeInstanceState("default", makeState([
        makeJob({ skills: ["qa"], status: "queued" }),
      ]));
      writeInstanceState("bot", makeState([
        makeJob({ skills: ["qa"], status: "running" }),
      ]));

      // Exclude default, but bot still has it
      expect(isSkillSetActive(TEST_DIR, ["qa"], "default")).toBe(true);
    });

    it("handles corrupt state file gracefully", () => {
      const dir = join(TEST_DIR, "daemons", "corrupt");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "daemon-state.json"), "not-json", "utf-8");

      expect(isSkillSetActive(TEST_DIR, ["qa"])).toBe(false);
    });
  });

  // ── getCompletedTodoTitles ──────────────────────────────────

  describe("getCompletedTodoTitles", () => {
    it("finds completed jobs with claimedTodoTitle across instances", () => {
      writeInstanceState("worker-1", makeState([
        makeJob({ status: "complete", claimedTodoTitle: "Fix auto-merge" }),
      ]));
      writeInstanceState("worker-2", makeState([
        makeJob({ status: "complete", claimedTodoTitle: "Add dashboard stats" }),
      ]));

      const titles = getCompletedTodoTitles(TEST_DIR);
      expect(titles.size).toBe(2);
      expect(titles.has("Fix auto-merge")).toBe(true);
      expect(titles.has("Add dashboard stats")).toBe(true);
    });

    it("excludes the requesting instance", () => {
      writeInstanceState("worker-1", makeState([
        makeJob({ status: "complete", claimedTodoTitle: "Fix auto-merge" }),
      ]));
      writeInstanceState("worker-2", makeState([
        makeJob({ status: "complete", claimedTodoTitle: "Add dashboard stats" }),
      ]));

      const titles = getCompletedTodoTitles(TEST_DIR, "worker-1");
      expect(titles.size).toBe(1);
      expect(titles.has("Fix auto-merge")).toBe(false);
      expect(titles.has("Add dashboard stats")).toBe(true);
    });

    it("skips jobs without claimedTodoTitle", () => {
      writeInstanceState("worker-1", makeState([
        makeJob({ status: "complete" }), // no claimedTodoTitle
        makeJob({ id: "job-002", status: "complete", claimedTodoTitle: "Has title" }),
      ]));

      const titles = getCompletedTodoTitles(TEST_DIR);
      expect(titles.size).toBe(1);
      expect(titles.has("Has title")).toBe(true);
    });

    it("skips non-completed jobs", () => {
      writeInstanceState("worker-1", makeState([
        makeJob({ status: "queued", claimedTodoTitle: "Queued item" }),
        makeJob({ id: "job-002", status: "running", claimedTodoTitle: "Running item" }),
        makeJob({ id: "job-003", status: "failed", claimedTodoTitle: "Failed item" }),
      ]));

      const titles = getCompletedTodoTitles(TEST_DIR);
      expect(titles.size).toBe(0);
    });

    it("returns empty set when no instances exist", () => {
      const titles = getCompletedTodoTitles(TEST_DIR);
      expect(titles.size).toBe(0);
    });
  });

  // ── migrateToInstanceDir ─────────────────────────────────────

  describe("migrateToInstanceDir", () => {
    it("migrates flat files to daemons/default/", () => {
      writeFileSync(join(TEST_DIR, "daemon.pid"), "12345", "utf-8");
      writeFileSync(join(TEST_DIR, "daemon-state.json"), '{"version":1,"jobs":[]}', "utf-8");

      const result = migrateToInstanceDir(TEST_DIR);
      expect(result).toBe(true);

      const defaultDir = join(TEST_DIR, "daemons", "default");
      expect(existsSync(join(defaultDir, "daemon.pid"))).toBe(true);
      expect(readFileSync(join(defaultDir, "daemon.pid"), "utf-8")).toBe("12345");
      expect(existsSync(join(defaultDir, "daemon-state.json"))).toBe(true);
    });

    it("returns false when no old files exist", () => {
      const result = migrateToInstanceDir(TEST_DIR);
      expect(result).toBe(false);
    });

    it("returns false when already migrated", () => {
      // Create new-style files
      const defaultDir = join(TEST_DIR, "daemons", "default");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(join(defaultDir, "daemon.pid"), "12345", "utf-8");
      // Also create old-style
      writeFileSync(join(TEST_DIR, "daemon.pid"), "12345", "utf-8");

      const result = migrateToInstanceDir(TEST_DIR);
      expect(result).toBe(false);
    });

    it("cleans up old files after successful migration", () => {
      writeFileSync(join(TEST_DIR, "daemon.pid"), "12345", "utf-8");
      migrateToInstanceDir(TEST_DIR);

      // Old file should be deleted after successful copy to avoid orphaned duplicates
      expect(existsSync(join(TEST_DIR, "daemon.pid"))).toBe(false);
      // New file should exist
      const defaultDir = join(TEST_DIR, "daemons", "default");
      expect(existsSync(join(defaultDir, "daemon.pid"))).toBe(true);
    });
  });

  // ── Budget lock integration ──────────────────────────────────

  describe("budget lock integration", () => {
    it("updateGlobalBudget releases lock after write", () => {
      updateGlobalBudget(TEST_DIR, 1.0, "worker-1");
      // Lock should be released after the call
      expect(isBudgetLocked(TEST_DIR)).toBe(false);
    });

    it("updateGlobalBudget releases lock even on safeWriteJSON error", () => {
      // Write a valid budget first so the read succeeds
      const budgetPath = join(TEST_DIR, "global-budget.json");
      const today = new Date().toISOString().slice(0, 10);
      writeFileSync(budgetPath, JSON.stringify({
        date: today, totalUsd: 0, jobCount: 0, byInstance: {},
      }), "utf-8");

      // Normal call should succeed and release lock
      updateGlobalBudget(TEST_DIR, 0.5, "default");
      expect(isBudgetLocked(TEST_DIR)).toBe(false);
    });

    it("setGlobalRateLimitHold releases lock after write", () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      setGlobalRateLimitHold(TEST_DIR, future, "worker-1");
      expect(isBudgetLocked(TEST_DIR)).toBe(false);
    });

    it("clearGlobalRateLimitHold releases lock after write", () => {
      // Set a hold first
      const future = new Date(Date.now() + 60_000).toISOString();
      setGlobalRateLimitHold(TEST_DIR, future, "worker-1");

      clearGlobalRateLimitHold(TEST_DIR);
      expect(isBudgetLocked(TEST_DIR)).toBe(false);
    });

    it("updateGlobalBudget correctly updates under lock", () => {
      updateGlobalBudget(TEST_DIR, 1.5, "worker-1");
      updateGlobalBudget(TEST_DIR, 0.5, "worker-2");

      const budget = readGlobalBudget(TEST_DIR);
      expect(budget.totalUsd).toBe(2.0);
      expect(budget.jobCount).toBe(2);
    });
  });
});
