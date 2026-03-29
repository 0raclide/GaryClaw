/**
 * Regression: ISSUE-002 — getClaimedFiles duplicate file entries per instance
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * When two queued/running jobs in the same instance both claimed the same file,
 * getClaimedFiles returned duplicates (e.g. ["types.ts", "types.ts"]).
 * Fix: use Set for per-instance dedup.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getClaimedFiles } from "../src/daemon-registry.js";
import type { DaemonState, Job } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-registry-fc-dedup-tmp");

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-001",
    triggeredBy: "manual",
    triggerDetail: "test",
    skills: ["qa"],
    projectDir: "/tmp/project",
    status: "running",
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

function writeInstanceState(name: string, state: DaemonState): void {
  const dir = join(TEST_DIR, "daemons", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "daemon-state.json"), JSON.stringify(state), "utf-8");
}

describe("getClaimedFiles dedup regression", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "daemons"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("deduplicates files when multiple jobs in the same instance claim the same file", () => {
    writeInstanceState("worker-1", makeState([
      makeJob({
        id: "job-1",
        status: "running",
        claimedFiles: ["oracle.ts", "types.ts"],
      }),
      makeJob({
        id: "job-2",
        status: "queued",
        claimedFiles: ["dashboard.ts", "types.ts"],
      }),
    ]));

    const result = getClaimedFiles(TEST_DIR);
    const files = result.get("worker-1")!;
    const typesCount = files.filter((f) => f === "types.ts").length;
    expect(typesCount).toBe(1);
    expect(files).toContain("oracle.ts");
    expect(files).toContain("dashboard.ts");
    expect(files).toContain("types.ts");
    expect(files.length).toBe(3);
  });

  it("deduplicates when same file appears in all jobs of an instance", () => {
    writeInstanceState("worker-1", makeState([
      makeJob({
        id: "job-1",
        status: "running",
        claimedFiles: ["types.ts"],
      }),
      makeJob({
        id: "job-2",
        status: "queued",
        claimedFiles: ["types.ts"],
      }),
      makeJob({
        id: "job-3",
        status: "queued",
        claimedFiles: ["types.ts"],
      }),
    ]));

    const result = getClaimedFiles(TEST_DIR);
    const files = result.get("worker-1")!;
    expect(files).toEqual(["types.ts"]);
  });
});
