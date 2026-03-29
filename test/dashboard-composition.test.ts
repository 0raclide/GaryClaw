/**
 * Dashboard composition stats tests — aggregateCompositionStats.
 * All synthetic data — no SDK calls.
 *
 * Gap identified by eng review test plan (2026-03-29):
 * "test/dashboard-composition.test.ts — aggregateCompositionStats:
 *  zero jobs, single composed, multiple composed, avg calculation,
 *  savings math with shared SKILL_COST_USD"
 */

import { describe, it, expect } from "vitest";
import { aggregateCompositionStats } from "../src/dashboard.js";
import type { Job } from "../src/types.js";

const TODAY = "2026-03-29";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    triggeredBy: "manual",
    triggerDetail: "CLI",
    skills: ["qa"],
    projectDir: "/tmp/project",
    status: "complete",
    enqueuedAt: `${TODAY}T10:00:00Z`,
    startedAt: `${TODAY}T10:00:00Z`,
    completedAt: `${TODAY}T10:08:32Z`,
    costUsd: 2.36,
    ...overrides,
  };
}

describe("aggregateCompositionStats", () => {
  it("returns zeros when no jobs exist", () => {
    const result = aggregateCompositionStats([], TODAY);
    expect(result).toEqual({
      composedJobs: 0,
      avgSkillsBefore: 0,
      avgSkillsAfter: 0,
      estimatedSavingsUsd: 0,
    });
  });

  it("returns zeros when jobs have no composedFrom field", () => {
    const jobs = [makeJob(), makeJob({ id: "job-2" })];
    const result = aggregateCompositionStats(jobs, TODAY);
    expect(result).toEqual({
      composedJobs: 0,
      avgSkillsBefore: 0,
      avgSkillsAfter: 0,
      estimatedSavingsUsd: 0,
    });
  });

  it("returns zeros when composedFrom is empty array", () => {
    const jobs = [makeJob({ composedFrom: [] })];
    const result = aggregateCompositionStats(jobs, TODAY);
    expect(result.composedJobs).toBe(0);
  });

  it("handles single composed job correctly", () => {
    const jobs = [
      makeJob({
        composedFrom: ["prioritize", "office-hours", "implement", "qa"],
        skills: ["implement", "qa"],
      }),
    ];
    const result = aggregateCompositionStats(jobs, TODAY);
    expect(result.composedJobs).toBe(1);
    expect(result.avgSkillsBefore).toBe(4);
    expect(result.avgSkillsAfter).toBe(2);
    // 2 skipped skills * $0.50 = $1.00
    expect(result.estimatedSavingsUsd).toBe(1.0);
  });

  it("computes averages across multiple composed jobs", () => {
    const jobs = [
      makeJob({
        id: "job-1",
        composedFrom: ["prioritize", "office-hours", "implement", "qa"],
        skills: ["implement", "qa"],
      }),
      makeJob({
        id: "job-2",
        composedFrom: ["prioritize", "implement", "qa"],
        skills: ["implement", "qa"],
      }),
    ];
    const result = aggregateCompositionStats(jobs, TODAY);
    expect(result.composedJobs).toBe(2);
    // (4 + 3) / 2 = 3.5
    expect(result.avgSkillsBefore).toBe(3.5);
    // (2 + 2) / 2 = 2
    expect(result.avgSkillsAfter).toBe(2);
    // (2 + 1) skipped * $0.50 = $1.50
    expect(result.estimatedSavingsUsd).toBe(1.5);
  });

  it("excludes non-composed jobs from averages", () => {
    const jobs = [
      makeJob({
        id: "job-1",
        composedFrom: ["prioritize", "implement", "qa"],
        skills: ["qa"],
      }),
      makeJob({ id: "job-2" }), // no composedFrom
    ];
    const result = aggregateCompositionStats(jobs, TODAY);
    expect(result.composedJobs).toBe(1);
    expect(result.avgSkillsBefore).toBe(3);
    expect(result.avgSkillsAfter).toBe(1);
  });

  it("filters to today's jobs only", () => {
    const jobs = [
      makeJob({
        id: "yesterday",
        enqueuedAt: "2026-03-28T10:00:00Z",
        composedFrom: ["prioritize", "implement", "qa"],
        skills: ["qa"],
      }),
      makeJob({
        id: "today",
        composedFrom: ["prioritize", "implement", "qa"],
        skills: ["implement", "qa"],
      }),
    ];
    const result = aggregateCompositionStats(jobs, TODAY);
    expect(result.composedJobs).toBe(1);
    expect(result.avgSkillsBefore).toBe(3);
    expect(result.avgSkillsAfter).toBe(2);
  });

  it("uses current date when todayStr not provided", () => {
    const now = new Date().toISOString().slice(0, 10);
    const jobs = [
      makeJob({
        enqueuedAt: `${now}T10:00:00Z`,
        composedFrom: ["implement", "qa"],
        skills: ["qa"],
      }),
    ];
    const result = aggregateCompositionStats(jobs);
    expect(result.composedJobs).toBe(1);
  });

  it("handles no skills reduction (same before and after)", () => {
    const jobs = [
      makeJob({
        composedFrom: ["implement", "qa"],
        skills: ["implement", "qa"],
      }),
    ];
    const result = aggregateCompositionStats(jobs, TODAY);
    expect(result.composedJobs).toBe(1);
    expect(result.avgSkillsBefore).toBe(2);
    expect(result.avgSkillsAfter).toBe(2);
    expect(result.estimatedSavingsUsd).toBe(0);
  });

  it("savings math: each skipped skill saves $0.50", () => {
    // 5 original skills → 1 final = 4 skipped = $2.00
    const jobs = [
      makeJob({
        composedFrom: ["prioritize", "office-hours", "implement", "plan-eng-review", "qa"],
        skills: ["qa"],
      }),
    ];
    const result = aggregateCompositionStats(jobs, TODAY);
    expect(result.estimatedSavingsUsd).toBe(2.0);
  });
});
