/**
 * Daemon Registry file conflict tests — getClaimedFiles cross-instance scanning.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getClaimedFiles } from "../src/daemon-registry.js";
import type { DaemonState, Job } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-registry-fc-tmp");

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

describe("getClaimedFiles", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "daemons"), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns empty map when no daemons directory exists", () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    const result = getClaimedFiles("/nonexistent/path");
    expect(result.size).toBe(0);
  });

  it("returns empty map when no instances have claimedFiles", () => {
    writeInstanceState("worker-1", makeState([
      makeJob({ status: "running" }),
    ]));
    const result = getClaimedFiles(TEST_DIR);
    expect(result.size).toBe(0);
  });

  it("returns claimed files for a single instance", () => {
    writeInstanceState("worker-1", makeState([
      makeJob({
        status: "running",
        claimedFiles: ["oracle.ts", "types.ts"],
      }),
    ]));

    const result = getClaimedFiles(TEST_DIR);
    expect(result.size).toBe(1);
    expect(result.get("worker-1")).toEqual(["oracle.ts", "types.ts"]);
  });

  it("returns claimed files from multiple instances", () => {
    writeInstanceState("worker-1", makeState([
      makeJob({
        id: "job-1",
        status: "running",
        claimedFiles: ["oracle.ts", "types.ts"],
      }),
    ]));
    writeInstanceState("worker-2", makeState([
      makeJob({
        id: "job-2",
        status: "queued",
        claimedFiles: ["dashboard.ts", "types.ts"],
      }),
    ]));

    const result = getClaimedFiles(TEST_DIR);
    expect(result.size).toBe(2);
    expect(result.get("worker-1")).toEqual(["oracle.ts", "types.ts"]);
    expect(result.get("worker-2")).toEqual(["dashboard.ts", "types.ts"]);
  });

  it("excludes the specified instance (self-exclusion)", () => {
    writeInstanceState("worker-1", makeState([
      makeJob({
        id: "job-1",
        status: "running",
        claimedFiles: ["oracle.ts"],
      }),
    ]));
    writeInstanceState("worker-2", makeState([
      makeJob({
        id: "job-2",
        status: "running",
        claimedFiles: ["dashboard.ts"],
      }),
    ]));

    const result = getClaimedFiles(TEST_DIR, "worker-1");
    expect(result.size).toBe(1);
    expect(result.has("worker-1")).toBe(false);
    expect(result.get("worker-2")).toEqual(["dashboard.ts"]);
  });

  it("only includes running and queued jobs, not completed or failed", () => {
    writeInstanceState("worker-1", makeState([
      makeJob({
        id: "job-done",
        status: "complete",
        claimedFiles: ["oracle.ts", "types.ts"],
      }),
      makeJob({
        id: "job-fail",
        status: "failed",
        claimedFiles: ["dashboard.ts"],
      }),
      makeJob({
        id: "job-active",
        status: "running",
        claimedFiles: ["pipeline.ts"],
      }),
    ]));

    const result = getClaimedFiles(TEST_DIR);
    expect(result.size).toBe(1);
    expect(result.get("worker-1")).toEqual(["pipeline.ts"]);
  });

  it("aggregates files from multiple active jobs in the same instance", () => {
    writeInstanceState("worker-1", makeState([
      makeJob({
        id: "job-1",
        status: "running",
        claimedFiles: ["oracle.ts"],
      }),
      makeJob({
        id: "job-2",
        status: "queued",
        claimedFiles: ["dashboard.ts"],
      }),
    ]));

    const result = getClaimedFiles(TEST_DIR);
    expect(result.get("worker-1")).toEqual(["oracle.ts", "dashboard.ts"]);
  });
});
