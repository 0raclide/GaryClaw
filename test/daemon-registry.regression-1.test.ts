/**
 * Daemon Registry regression: getClaimedTodoTitles cross-instance coordination.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getClaimedTodoTitles } from "../src/daemon-registry.js";

const TEST_DIR = join(process.cwd(), ".test-registry-claimed-tmp");
const GARYCLAW_DIR = join(TEST_DIR, ".garyclaw");
const DAEMONS_DIR = join(GARYCLAW_DIR, "daemons");

function writeDaemonState(instanceName: string, jobs: Array<{
  status: string;
  claimedTodoTitle?: string;
}>): void {
  const instanceDir = join(DAEMONS_DIR, instanceName);
  mkdirSync(instanceDir, { recursive: true });
  const state = {
    version: 1,
    jobs: jobs.map((j, i) => ({
      id: `job-${i}`,
      skills: ["prioritize"],
      status: j.status,
      enqueuedAt: new Date().toISOString(),
      costUsd: 0,
      claimedTodoTitle: j.claimedTodoTitle,
    })),
    dailyCostUsd: 0,
    dailyJobCount: 0,
    lastResetDate: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(
    join(instanceDir, "daemon-state.json"),
    JSON.stringify(state),
  );
}

describe("getClaimedTodoTitles", () => {
  beforeEach(() => mkdirSync(DAEMONS_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("returns empty when no daemons directory exists", () => {
    rmSync(DAEMONS_DIR, { recursive: true, force: true });
    const result = getClaimedTodoTitles(GARYCLAW_DIR);
    expect(result).toEqual([]);
  });

  it("returns empty when no instances have claimed items", () => {
    writeDaemonState("builder", [
      { status: "running" },
      { status: "completed" },
    ]);
    const result = getClaimedTodoTitles(GARYCLAW_DIR);
    expect(result).toEqual([]);
  });

  it("returns claimed titles from running jobs", () => {
    writeDaemonState("builder", [
      { status: "running", claimedTodoTitle: "Fix auth flow" },
    ]);
    const result = getClaimedTodoTitles(GARYCLAW_DIR);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ title: "Fix auth flow", instanceName: "builder" });
  });

  it("returns claimed titles from queued jobs", () => {
    writeDaemonState("builder", [
      { status: "queued", claimedTodoTitle: "Add tests" },
    ]);
    const result = getClaimedTodoTitles(GARYCLAW_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Add tests");
  });

  it("ignores completed jobs with claimed titles", () => {
    writeDaemonState("builder", [
      { status: "completed", claimedTodoTitle: "Already done" },
      { status: "running", claimedTodoTitle: "In progress" },
    ]);
    const result = getClaimedTodoTitles(GARYCLAW_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("In progress");
  });

  it("aggregates across multiple instances", () => {
    writeDaemonState("builder-1", [
      { status: "running", claimedTodoTitle: "Task A" },
    ]);
    writeDaemonState("builder-2", [
      { status: "queued", claimedTodoTitle: "Task B" },
    ]);
    const result = getClaimedTodoTitles(GARYCLAW_DIR);
    expect(result).toHaveLength(2);
    const titles = result.map((r) => r.title).sort();
    expect(titles).toEqual(["Task A", "Task B"]);
  });

  it("excludes specified instance", () => {
    writeDaemonState("builder-1", [
      { status: "running", claimedTodoTitle: "Task A" },
    ]);
    writeDaemonState("builder-2", [
      { status: "running", claimedTodoTitle: "Task B" },
    ]);
    const result = getClaimedTodoTitles(GARYCLAW_DIR, "builder-1");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Task B");
    expect(result[0].instanceName).toBe("builder-2");
  });

  it("handles corrupt state files gracefully", () => {
    const instanceDir = join(DAEMONS_DIR, "broken");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "daemon-state.json"), "not json");

    writeDaemonState("healthy", [
      { status: "running", claimedTodoTitle: "Task C" },
    ]);

    const result = getClaimedTodoTitles(GARYCLAW_DIR);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Task C");
  });
});
