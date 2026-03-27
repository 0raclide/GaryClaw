/**
 * Job runner auto-research integration tests — enqueueWithTopic, processNext
 * trigger block, buildGaryClawConfig passthrough, collectAllDecisions.
 *
 * Regression: ISSUE-003 — pipeline decisions not read
 * Found by /qa on 2026-03-27
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-27.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createJobRunner } from "../src/job-runner.js";
import { collectAllDecisions } from "../src/job-runner.js";
import type { DaemonConfig, DaemonState, Decision, GaryClawConfig, OrchestratorCallbacks } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-jr-autoresearch-tmp");

function createTestConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    version: 1,
    projectDir: "/tmp/project",
    triggers: [],
    budget: {
      dailyCostLimitUsd: 5,
      perJobCostLimitUsd: 1,
      maxJobsPerDay: 10,
    },
    notifications: { enabled: false, onComplete: false, onError: false, onEscalation: false },
    orchestrator: {
      maxTurnsPerSegment: 15,
      relayThresholdRatio: 0.85,
      maxRelaySessions: 10,
      askTimeoutMs: 300000,
    },
    logging: { level: "info", retainDays: 7 },
    ...overrides,
  };
}

function makeDecisionLine(question: string, confidence: number): string {
  const d: Decision = {
    timestamp: new Date().toISOString(),
    sessionIndex: 0,
    question,
    options: [
      { label: "A", description: "Option A" },
      { label: "B", description: "Option B" },
    ],
    chosen: "A",
    confidence,
    rationale: "test",
    principle: "P1",
  };
  return JSON.stringify(d);
}

function createMockDeps() {
  return {
    runPipeline: vi.fn().mockResolvedValue(undefined),
    runSkill: vi.fn().mockResolvedValue(undefined),
    buildSdkEnv: vi.fn().mockReturnValue({ HOME: "/home" }),
    notifyJobComplete: vi.fn(),
    notifyJobError: vi.fn(),
    writeSummary: vi.fn(),
    log: vi.fn(),
  };
}

describe("collectAllDecisions", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("reads top-level decisions.jsonl", () => {
    const line = makeDecisionLine("WebSocket library?", 3);
    writeFileSync(join(TEST_DIR, "decisions.jsonl"), line + "\n");

    const decisions = collectAllDecisions(TEST_DIR);
    expect(decisions.length).toBe(1);
    expect(decisions[0].question).toBe("WebSocket library?");
  });

  it("reads pipeline skill subdir decisions", () => {
    mkdirSync(join(TEST_DIR, "skill-0-qa"), { recursive: true });
    mkdirSync(join(TEST_DIR, "skill-1-design-review"), { recursive: true });

    writeFileSync(
      join(TEST_DIR, "skill-0-qa", "decisions.jsonl"),
      makeDecisionLine("SSL certificate?", 3) + "\n",
    );
    writeFileSync(
      join(TEST_DIR, "skill-1-design-review", "decisions.jsonl"),
      makeDecisionLine("API design?", 4) + "\n",
    );

    const decisions = collectAllDecisions(TEST_DIR);
    expect(decisions.length).toBe(2);
    expect(decisions.map((d) => d.question)).toContain("SSL certificate?");
    expect(decisions.map((d) => d.question)).toContain("API design?");
  });

  it("combines top-level and subdir decisions", () => {
    writeFileSync(
      join(TEST_DIR, "decisions.jsonl"),
      makeDecisionLine("Top level?", 5) + "\n",
    );
    mkdirSync(join(TEST_DIR, "skill-0-qa"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "skill-0-qa", "decisions.jsonl"),
      makeDecisionLine("Subdir?", 3) + "\n",
    );

    const decisions = collectAllDecisions(TEST_DIR);
    expect(decisions.length).toBe(2);
  });

  it("returns empty array when no decision files exist", () => {
    const decisions = collectAllDecisions(TEST_DIR);
    expect(decisions).toEqual([]);
  });

  it("ignores non-skill directories", () => {
    mkdirSync(join(TEST_DIR, "other-dir"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "other-dir", "decisions.jsonl"),
      makeDecisionLine("Ignored?", 3) + "\n",
    );

    const decisions = collectAllDecisions(TEST_DIR);
    expect(decisions).toEqual([]);
  });

  it("handles empty decisions.jsonl files gracefully", () => {
    writeFileSync(join(TEST_DIR, "decisions.jsonl"), "");
    mkdirSync(join(TEST_DIR, "skill-0-qa"), { recursive: true });
    writeFileSync(join(TEST_DIR, "skill-0-qa", "decisions.jsonl"), "");

    const decisions = collectAllDecisions(TEST_DIR);
    expect(decisions).toEqual([]);
  });
});

describe("Job Runner auto-research integration", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("enqueues research jobs after job with low-confidence decisions", async () => {
    const deps = createMockDeps();

    // When the job runs, write low-confidence decisions to the job dir
    deps.runSkill.mockImplementation(async (config: GaryClawConfig) => {
      mkdirSync(config.checkpointDir, { recursive: true });
      const lines = [
        makeDecisionLine("WebSocket library performance benchmarks?", 3),
        makeDecisionLine("WebSocket library connection pooling strategy?", 4),
        makeDecisionLine("WebSocket library reconnection handling?", 2),
      ].join("\n") + "\n";
      writeFileSync(join(config.checkpointDir, "decisions.jsonl"), lines);
    });

    const config = createTestConfig({
      autoResearch: {
        enabled: true,
        lowConfidenceThreshold: 6,
        minDecisionsToTrigger: 3,
        maxTopicsPerJob: 2,
      },
    });

    const runner = createJobRunner(config, TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    // Original job + at least 1 auto-research job
    const researchJobs = state.jobs.filter((j) => j.skills.includes("research"));
    expect(researchJobs.length).toBeGreaterThanOrEqual(1);
    expect(researchJobs[0].researchTopic).toBeTruthy();
  });

  it("does NOT enqueue research when autoResearch.enabled is false", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockImplementation(async (config: GaryClawConfig) => {
      mkdirSync(config.checkpointDir, { recursive: true });
      const lines = [
        makeDecisionLine("WebSocket library performance?", 3),
        makeDecisionLine("WebSocket library connection?", 4),
        makeDecisionLine("WebSocket library retry?", 2),
      ].join("\n") + "\n";
      writeFileSync(join(config.checkpointDir, "decisions.jsonl"), lines);
    });

    const config = createTestConfig({
      autoResearch: {
        enabled: false,
        lowConfidenceThreshold: 6,
        minDecisionsToTrigger: 3,
        maxTopicsPerJob: 2,
      },
    });

    const runner = createJobRunner(config, TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    const researchJobs = state.jobs.filter((j) => j.skills.includes("research"));
    expect(researchJobs.length).toBe(0);
  });

  it("does NOT enqueue research when job fails", async () => {
    const deps = createMockDeps();
    deps.runSkill.mockRejectedValue(new Error("Job crashed"));

    const config = createTestConfig({
      autoResearch: {
        enabled: true,
        lowConfidenceThreshold: 6,
        minDecisionsToTrigger: 3,
        maxTopicsPerJob: 2,
      },
    });

    const runner = createJobRunner(config, TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    const state = runner.getState();
    const researchJobs = state.jobs.filter((j) => j.skills.includes("research"));
    expect(researchJobs.length).toBe(0);
  });

  it("passes researchTopic through buildGaryClawConfig to runSkill", async () => {
    const deps = createMockDeps();
    let capturedConfig: GaryClawConfig | null = null;

    // First job: writes low-confidence decisions
    deps.runSkill.mockImplementation(async (config: GaryClawConfig) => {
      if (config.skillName === "research") {
        capturedConfig = config;
        return;
      }
      mkdirSync(config.checkpointDir, { recursive: true });
      const lines = [
        makeDecisionLine("WebSocket library performance benchmarks?", 3),
        makeDecisionLine("WebSocket library connection pooling strategy?", 4),
        makeDecisionLine("WebSocket library reconnection handling?", 2),
      ].join("\n") + "\n";
      writeFileSync(join(config.checkpointDir, "decisions.jsonl"), lines);
    });

    const config = createTestConfig({
      autoResearch: {
        enabled: true,
        lowConfidenceThreshold: 6,
        minDecisionsToTrigger: 3,
        maxTopicsPerJob: 2,
      },
    });

    const runner = createJobRunner(config, TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    // Process the auto-enqueued research job
    await runner.processNext();

    expect(capturedConfig).not.toBeNull();
    expect(capturedConfig!.researchTopic).toBeTruthy();
    expect(capturedConfig!.skillName).toBe("research");
  });

  it("catches errors in auto-research trigger without crashing", async () => {
    const deps = createMockDeps();

    // runSkill succeeds but doesn't create decisions.jsonl — readDecisionsFromLog
    // should handle missing file gracefully, so no crash
    deps.runSkill.mockImplementation(async (config: GaryClawConfig) => {
      mkdirSync(config.checkpointDir, { recursive: true });
      // Write an invalid JSON line to trigger a parse error path
      writeFileSync(join(config.checkpointDir, "decisions.jsonl"), "not json\n");
    });

    const config = createTestConfig({
      autoResearch: {
        enabled: true,
        lowConfidenceThreshold: 6,
        minDecisionsToTrigger: 3,
        maxTopicsPerJob: 2,
      },
    });

    const runner = createJobRunner(config, TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");

    // Should not throw
    await expect(runner.processNext()).resolves.toBeUndefined();

    const state = runner.getState();
    expect(state.jobs[0].status).toBe("complete");
  });

  it("reads pipeline subdir decisions for auto-research trigger", async () => {
    const deps = createMockDeps();

    // Simulate pipeline job writing to subdirs
    deps.runPipeline.mockImplementation(async (skills: string[], config: GaryClawConfig) => {
      mkdirSync(join(config.checkpointDir, "skill-0-qa"), { recursive: true });
      mkdirSync(join(config.checkpointDir, "skill-1-design-review"), { recursive: true });

      const qaLines = [
        makeDecisionLine("WebSocket library performance?", 3),
        makeDecisionLine("WebSocket library connection?", 4),
      ].join("\n") + "\n";
      writeFileSync(join(config.checkpointDir, "skill-0-qa", "decisions.jsonl"), qaLines);

      const reviewLines = [
        makeDecisionLine("WebSocket library retry logic?", 2),
      ].join("\n") + "\n";
      writeFileSync(join(config.checkpointDir, "skill-1-design-review", "decisions.jsonl"), reviewLines);
    });

    const config = createTestConfig({
      autoResearch: {
        enabled: true,
        lowConfidenceThreshold: 6,
        minDecisionsToTrigger: 3,
        maxTopicsPerJob: 2,
      },
    });

    const runner = createJobRunner(config, TEST_DIR, deps);
    runner.enqueue(["qa", "design-review"], "manual", "pipeline test");
    await runner.processNext();

    const state = runner.getState();
    const researchJobs = state.jobs.filter((j) => j.skills.includes("research"));
    // 3 low-confidence decisions about websocket library across 2 pipeline skills
    expect(researchJobs.length).toBeGreaterThanOrEqual(1);
  });

  it("enqueueWithTopic returns null when budget exhausted", async () => {
    const deps = createMockDeps();

    deps.runSkill.mockImplementation(async (config: GaryClawConfig) => {
      mkdirSync(config.checkpointDir, { recursive: true });
      const lines = [
        makeDecisionLine("WebSocket library performance benchmarks?", 3),
        makeDecisionLine("WebSocket library connection pooling strategy?", 4),
        makeDecisionLine("WebSocket library reconnection handling?", 2),
      ].join("\n") + "\n";
      writeFileSync(join(config.checkpointDir, "decisions.jsonl"), lines);
    });

    // Budget allows only 1 job per day
    const config = createTestConfig({
      budget: {
        dailyCostLimitUsd: 5,
        perJobCostLimitUsd: 1,
        maxJobsPerDay: 1,
      },
      autoResearch: {
        enabled: true,
        lowConfidenceThreshold: 6,
        minDecisionsToTrigger: 3,
        maxTopicsPerJob: 2,
      },
    });

    const runner = createJobRunner(config, TEST_DIR, deps);
    runner.enqueue(["qa"], "manual", "test");
    await runner.processNext();

    // After the qa job completes (counts as 1 job), research enqueue should be blocked by budget
    const state = runner.getState();
    const researchJobs = state.jobs.filter((j) => j.skills.includes("research"));
    // The research job was blocked by maxJobsPerDay=1 (qa consumed it)
    expect(researchJobs.length).toBe(0);

    // Verify the skip was logged
    const logCalls = deps.log.mock.calls.map((c: any[]) => c[1] as string);
    const skipLog = logCalls.find((msg: string) => msg.includes("budget/dedup"));
    expect(skipLog).toBeTruthy();
  });
});
