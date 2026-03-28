/**
 * Regression: ISSUE-003 — buildDashboard date-sensitive test failure
 * Found by /qa on 2026-03-28
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md
 *
 * aggregateJobStats filters by today's date. buildDashboard didn't pass
 * todayStr through, so tests with hardcoded timestamps failed on any
 * day other than the one the tests were written on.
 */

import { describe, it, expect } from "vitest";
import { buildDashboard } from "../src/dashboard.js";
import type {
  Job,
  OracleMetrics,
  GlobalBudget,
  DaemonState,
  DaemonConfig,
  BudgetConfig,
} from "../src/types.js";

function makeJob(date: string, overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    triggeredBy: "manual",
    triggerDetail: "CLI",
    skills: ["qa"],
    projectDir: "/tmp/project",
    status: "complete",
    enqueuedAt: `${date}T10:00:00Z`,
    startedAt: `${date}T10:00:00Z`,
    completedAt: `${date}T10:08:32Z`,
    costUsd: 2.0,
    ...overrides,
  };
}

function makeMetrics(): OracleMetrics {
  return {
    totalDecisions: 10,
    accurateDecisions: 8,
    neutralDecisions: 1,
    failedDecisions: 1,
    accuracyPercent: 80,
    confidenceTrend: [7, 8],
    lastReflectionTimestamp: null,
    circuitBreakerTripped: false,
  };
}

function makeBudgetConfig(): BudgetConfig {
  return { dailyCostLimitUsd: 25, perJobCostLimitUsd: 10, maxJobsPerDay: 20 };
}

function makeDaemonConfig(date: string): DaemonConfig {
  return {
    projectDir: "/tmp/project",
    skills: ["qa"],
    triggers: [],
    budget: makeBudgetConfig(),
    autonomous: true,
    autoResearch: { enabled: false },
  };
}

describe("buildDashboard date handling", () => {
  it("counts jobs when todayStr matches job timestamps", () => {
    const date = "2099-12-31";
    const state: DaemonState = {
      version: 1,
      jobs: [
        makeJob(date, { id: "j1" }),
        makeJob(date, { id: "j2" }),
      ],
      dailyCost: { date, totalUsd: 4.0, jobCount: 2 },
    };
    const budget: GlobalBudget = { date, totalUsd: 4.0, jobCount: 2, byInstance: {} };

    const data = buildDashboard(state, makeMetrics(), budget, makeDaemonConfig(date), date);
    expect(data.jobs.total).toBe(2);
  });

  it("returns zero jobs when todayStr does not match job timestamps", () => {
    const jobDate = "2099-12-30";
    const today = "2099-12-31";
    const state: DaemonState = {
      version: 1,
      jobs: [makeJob(jobDate, { id: "j1" })],
      dailyCost: { date: today, totalUsd: 0, jobCount: 0 },
    };
    const budget: GlobalBudget = { date: today, totalUsd: 0, jobCount: 0, byInstance: {} };

    const data = buildDashboard(state, makeMetrics(), budget, makeDaemonConfig(today), today);
    expect(data.jobs.total).toBe(0);
  });

  it("without todayStr uses current date (jobs from far future are excluded)", () => {
    const futureDate = "2099-12-31";
    const state: DaemonState = {
      version: 1,
      jobs: [makeJob(futureDate, { id: "j1" })],
      dailyCost: { date: futureDate, totalUsd: 2.0, jobCount: 1 },
    };
    const budget: GlobalBudget = { date: futureDate, totalUsd: 2.0, jobCount: 1, byInstance: {} };

    // Without todayStr, aggregateJobStats uses new Date() which won't be 2099-12-31
    const data = buildDashboard(state, makeMetrics(), budget, makeDaemonConfig(futureDate));
    expect(data.jobs.total).toBe(0);
  });
});
