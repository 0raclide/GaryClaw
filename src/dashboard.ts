/**
 * Dogfood Dashboard — aggregation, health scoring, and markdown formatting.
 *
 * Pure functions take data as input — no file I/O in the core logic.
 * Only `generateDashboard()` touches the filesystem.
 */

import { join } from "node:path";
import { safeReadJSON, safeWriteText } from "./safe-json.js";
import { readMetrics, defaultMemoryConfig } from "./oracle-memory.js";
import type {
  DashboardData,
  DaemonState,
  DaemonConfig,
  Job,
  OracleMetrics,
  GlobalBudget,
  BudgetConfig,
  AdaptiveTurnsJobStats,
} from "./types.js";

// ── Pure aggregation functions ──────────────────────────────────

/**
 * Aggregate job statistics from today's jobs.
 * Filters to jobs where enqueuedAt starts with today's UTC date (YYYY-MM-DD).
 */
export function aggregateJobStats(jobs: Job[], todayStr?: string): DashboardData["jobs"] {
  const today = todayStr ?? new Date().toISOString().slice(0, 10);
  const todayJobs = jobs.filter((j) => j.enqueuedAt.startsWith(today));

  const total = todayJobs.length;
  const complete = todayJobs.filter((j) => j.status === "complete").length;
  const failed = todayJobs.filter((j) => j.status === "failed").length;
  const queued = todayJobs.filter((j) => j.status === "queued").length;
  const running = todayJobs.filter((j) => j.status === "running").length;

  const successRate = total > 0 ? (complete / total) * 100 : 100;
  const totalCostUsd = todayJobs.reduce((sum, j) => sum + j.costUsd, 0);
  const avgCostPerJob = total > 0 ? totalCostUsd / total : 0;

  // Average duration for completed/failed jobs with both timestamps
  const finishedJobs = todayJobs.filter(
    (j) => j.startedAt && j.completedAt && (j.status === "complete" || j.status === "failed"),
  );
  const totalDurationSec = finishedJobs.reduce((sum, j) => {
    const start = new Date(j.startedAt!).getTime();
    const end = new Date(j.completedAt!).getTime();
    return sum + (end - start) / 1000;
  }, 0);
  const avgDurationSec = finishedJobs.length > 0 ? totalDurationSec / finishedJobs.length : 0;

  // Failure breakdown by category
  const failureBreakdown: Record<string, number> = {};
  for (const j of todayJobs.filter((j) => j.status === "failed" && j.failureCategory)) {
    failureBreakdown[j.failureCategory!] = (failureBreakdown[j.failureCategory!] ?? 0) + 1;
  }

  return {
    total,
    complete,
    failed,
    queued,
    running,
    successRate,
    totalCostUsd,
    avgCostPerJob,
    avgDurationSec,
    failureBreakdown,
  };
}

/**
 * Aggregate oracle statistics from metrics.
 */
export function aggregateOracleStats(metrics: OracleMetrics): DashboardData["oracle"] {
  const confidenceAvg =
    metrics.confidenceTrend.length > 0
      ? metrics.confidenceTrend.reduce((a, b) => a + b, 0) / metrics.confidenceTrend.length
      : 0;

  return {
    totalDecisions: metrics.totalDecisions,
    accuracyPercent: metrics.accuracyPercent,
    confidenceAvg,
    circuitBreakerTripped: metrics.circuitBreakerTripped,
  };
}

/**
 * Aggregate budget statistics from global budget and config.
 */
export function aggregateBudgetStats(
  globalBudget: GlobalBudget,
  config: BudgetConfig,
): DashboardData["budget"] {
  const dailyRemaining = Math.max(0, config.dailyCostLimitUsd - globalBudget.totalUsd);

  return {
    dailyLimitUsd: config.dailyCostLimitUsd,
    dailySpentUsd: globalBudget.totalUsd,
    dailyRemaining,
    jobCount: globalBudget.jobCount,
    maxJobsPerDay: config.maxJobsPerDay,
    byInstance: globalBudget.byInstance ?? {},
  };
}

/**
 * Aggregate adaptive turns statistics from today's jobs.
 * Jobs without adaptiveTurnsStats (pre-existing or --no-adaptive) are silently excluded.
 */
export function aggregateAdaptiveTurnsStats(
  jobs: Job[],
  todayStr?: string,
): DashboardData["adaptiveTurns"] {
  const today = todayStr ?? new Date().toISOString().slice(0, 10);
  const todayJobs = jobs.filter((j) => j.enqueuedAt.startsWith(today));
  const withStats = todayJobs.filter((j) => j.adaptiveTurnsStats);

  if (withStats.length === 0) {
    return {
      totalSegments: 0,
      adaptiveSegments: 0,
      fallbackSegments: 0,
      clampedSegments: 0,
      heavyToolActivations: 0,
      avgTurns: 0,
      minTurns: 0,
      maxTurns: 0,
      adaptiveRate: 0,
    };
  }

  let totalSegments = 0;
  let adaptiveSegments = 0;
  let fallbackSegments = 0;
  let clampedSegments = 0;
  let heavyToolActivations = 0;
  let totalTurns = 0;
  let globalMin: number | null = null;
  let globalMax = 0;

  for (const job of withStats) {
    const s = job.adaptiveTurnsStats!;
    totalSegments += s.segmentCount;
    adaptiveSegments += s.adaptiveCount;
    fallbackSegments += s.fallbackCount;
    clampedSegments += s.clampedCount;
    heavyToolActivations += s.heavyToolActivations;
    totalTurns += s.totalTurns;
    // null-safe min: skip jobs where minTurns was never set
    if (s.minTurns !== null) {
      globalMin = globalMin === null ? s.minTurns : Math.min(globalMin, s.minTurns);
    }
    if (s.maxTurns > globalMax) globalMax = s.maxTurns;
  }

  return {
    totalSegments,
    adaptiveSegments,
    fallbackSegments,
    clampedSegments,
    heavyToolActivations,
    avgTurns: totalSegments > 0 ? totalTurns / totalSegments : 0,
    minTurns: globalMin ?? 0,
    maxTurns: globalMax,
    adaptiveRate: totalSegments > 0 ? (adaptiveSegments / totalSegments) * 100 : 0,
  };
}

/**
 * Compute health score (0-100) and top concern.
 *
 * Weights:
 * - Job success rate: 40%
 * - Oracle accuracy: 25% (100 if no decisions)
 * - Budget headroom: 20%
 * - No circuit breaker: 15%
 */
export function computeHealthScore(
  data: Omit<DashboardData, "healthScore" | "topConcern" | "generatedAt">,
): { score: number; topConcern: string | null } {
  const jobScore = data.jobs.successRate;
  const oracleScore = data.oracle.totalDecisions === 0 ? 100 : data.oracle.accuracyPercent;
  const budgetHeadroom =
    data.budget.dailyLimitUsd > 0
      ? Math.min(100, (data.budget.dailyRemaining / data.budget.dailyLimitUsd) * 100)
      : 100;
  const circuitBreakerScore = data.oracle.circuitBreakerTripped ? 0 : 100;

  const score = Math.round(
    jobScore * 0.4 + oracleScore * 0.25 + budgetHeadroom * 0.2 + circuitBreakerScore * 0.15,
  );

  // Top concern selection (first matching rule wins)
  let topConcern: string | null = null;

  if (data.oracle.circuitBreakerTripped) {
    topConcern = "Oracle memory disabled — accuracy below 60%";
  } else if (data.jobs.successRate < 50) {
    topConcern = "More jobs failing than succeeding — check failure breakdown";
  } else if (
    data.budget.dailyLimitUsd > 0 &&
    data.budget.dailyRemaining / data.budget.dailyLimitUsd < 0.1
  ) {
    topConcern = `Daily budget nearly exhausted ($${data.budget.dailyRemaining.toFixed(2)} remaining)`;
  } else if ((data.jobs.failureBreakdown["garyclaw-bug"] ?? 0) > 0) {
    const n = data.jobs.failureBreakdown["garyclaw-bug"];
    topConcern = `GaryClaw bug detected in ${n} job(s) — check logs`;
  } else if (data.jobs.successRate < 80) {
    const n = data.jobs.failed;
    topConcern = `${n} job(s) failed today — review failure categories`;
  }

  return { score, topConcern };
}

/**
 * Format dashboard data as markdown.
 */
export function formatDashboard(data: DashboardData): string {
  const statusLabel =
    data.healthScore >= 80 ? "HEALTHY" : data.healthScore >= 50 ? "DEGRADED" : "UNHEALTHY";

  const lines: string[] = [
    "# GaryClaw Dogfood Dashboard",
    "",
    `**Generated:** ${data.generatedAt}`,
    `**Health Score:** ${data.healthScore}/100`,
    `**Status:** ${statusLabel}`,
    "",
    "## Top Concern",
    data.topConcern ?? "None — all systems nominal.",
    "",
    "## Jobs Today",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Total | ${data.jobs.total} |`,
    `| Complete | ${data.jobs.complete} |`,
    `| Failed | ${data.jobs.failed} |`,
    `| Success Rate | ${data.jobs.successRate.toFixed(1)}% |`,
    `| Total Cost | $${data.jobs.totalCostUsd.toFixed(2)} |`,
    `| Avg Cost/Job | $${data.jobs.avgCostPerJob.toFixed(2)} |`,
    `| Avg Duration | ${formatDuration(data.jobs.avgDurationSec)} |`,
  ];

  // Failure breakdown (only if there are failures)
  const failureEntries = Object.entries(data.jobs.failureBreakdown);
  if (failureEntries.length > 0) {
    lines.push(
      "",
      "### Failure Breakdown",
      "| Category | Count |",
      "|----------|-------|",
    );
    for (const [category, count] of failureEntries.sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${category} | ${count} |`);
    }
  }

  // Oracle section
  lines.push(
    "",
    "## Oracle",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Decisions | ${data.oracle.totalDecisions} |`,
    `| Accuracy | ${data.oracle.accuracyPercent.toFixed(0)}% |`,
    `| Avg Confidence | ${data.oracle.confidenceAvg.toFixed(1)}/10 |`,
    `| Circuit Breaker | ${data.oracle.circuitBreakerTripped ? "TRIPPED" : "OK"} |`,
  );

  // Adaptive Turns section (only when data exists)
  if (data.adaptiveTurns.totalSegments > 0) {
    lines.push(
      "",
      "## Adaptive Turns",
      "",
      "| Metric | Value |",
      "|--------|-------|",
      `| Total Segments | ${data.adaptiveTurns.totalSegments} |`,
      `| Adaptive | ${data.adaptiveTurns.adaptiveSegments} (${data.adaptiveTurns.adaptiveRate.toFixed(1)}%) |`,
      `| Fallback | ${data.adaptiveTurns.fallbackSegments} |`,
      `| Clamped | ${data.adaptiveTurns.clampedSegments} |`,
      `| Heavy Tool Activations | ${data.adaptiveTurns.heavyToolActivations} |`,
      `| Avg Turns/Segment | ${data.adaptiveTurns.avgTurns.toFixed(1)} |`,
      `| Min Turns | ${data.adaptiveTurns.minTurns} |`,
      `| Max Turns | ${data.adaptiveTurns.maxTurns} |`,
    );
  }

  // Budget section
  const remainingPct =
    data.budget.dailyLimitUsd > 0
      ? ((data.budget.dailyRemaining / data.budget.dailyLimitUsd) * 100).toFixed(1)
      : "100.0";
  lines.push(
    "",
    "## Budget",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Daily Limit | $${data.budget.dailyLimitUsd.toFixed(2)} |`,
    `| Spent Today | $${data.budget.dailySpentUsd.toFixed(2)} |`,
    `| Remaining | $${data.budget.dailyRemaining.toFixed(2)} (${remainingPct}%) |`,
    `| Jobs Today | ${data.budget.jobCount} / ${data.budget.maxJobsPerDay} max |`,
  );

  // By-instance breakdown (only if there are instances)
  const instanceEntries = Object.entries(data.budget.byInstance);
  if (instanceEntries.length > 0) {
    lines.push(
      "",
      "### By Instance",
      "| Instance | Cost | Jobs |",
      "|----------|------|------|",
    );
    for (const [name, info] of instanceEntries.sort((a, b) => b[1].totalUsd - a[1].totalUsd)) {
      lines.push(`| ${name} | $${info.totalUsd.toFixed(2)} | ${info.jobCount} |`);
    }
  }

  lines.push("", "---", "*Generated by GaryClaw Daemon*", "");

  return lines.join("\n");
}

/**
 * Build complete dashboard data from raw sources.
 */
export function buildDashboard(
  state: DaemonState,
  metrics: OracleMetrics,
  globalBudget: GlobalBudget,
  config: DaemonConfig,
  todayStr?: string,
): DashboardData {
  const jobs = aggregateJobStats(state.jobs, todayStr);
  const oracle = aggregateOracleStats(metrics);
  const budget = aggregateBudgetStats(globalBudget, config.budget);
  const adaptiveTurns = aggregateAdaptiveTurnsStats(state.jobs, todayStr);
  const instances = Object.keys(globalBudget.byInstance ?? {});

  const { score, topConcern } = computeHealthScore({ jobs, oracle, budget, adaptiveTurns, instances });

  return {
    generatedAt: new Date().toISOString(),
    healthScore: score,
    topConcern,
    jobs,
    oracle,
    budget,
    adaptiveTurns,
    instances,
  };
}

// ── File I/O wrapper ────────────────────────────────────────────

const DASHBOARD_FILE = "dogfood-report.md";

/**
 * Generate the dogfood dashboard and write it to disk.
 *
 * Reads daemon-state.json from instanceDir, metrics from oracle-memory,
 * and global-budget.json from parentDir. Writes dogfood-report.md to
 * the parent .garyclaw/ dir (or instanceDir if no parent).
 */
export function generateDashboard(
  instanceDir: string,
  parentDir: string | undefined,
  config: DaemonConfig,
): void {
  // Read daemon state
  const state = safeReadJSON<DaemonState>(
    join(instanceDir, "daemon-state.json"),
    (d): d is DaemonState =>
      typeof d === "object" && d !== null && (d as DaemonState).version === 1 && Array.isArray((d as DaemonState).jobs),
  ) ?? { version: 1 as const, jobs: [], dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 } };

  // Read oracle metrics
  const memConfig = defaultMemoryConfig(config.projectDir);
  const metrics = readMetrics(memConfig);

  // Read global budget
  const globalBudget: GlobalBudget = parentDir
    ? (safeReadJSON<GlobalBudget>(join(parentDir, "global-budget.json")) ?? defaultGlobalBudget())
    : defaultGlobalBudget();

  const data = buildDashboard(state, metrics, globalBudget, config);
  const markdown = formatDashboard(data);

  // Write to parent dir (unified dashboard) or instance dir
  const outputDir = parentDir ?? instanceDir;
  safeWriteText(join(outputDir, DASHBOARD_FILE), markdown);
}

// ── Helpers ─────────────────────────────────────────────────────

function defaultGlobalBudget(): GlobalBudget {
  return {
    date: new Date().toISOString().slice(0, 10),
    totalUsd: 0,
    jobCount: 0,
    byInstance: {},
  };
}

/**
 * Format seconds into a human-readable duration string.
 */
export function formatDuration(seconds: number): string {
  if (seconds <= 0 || !Number.isFinite(seconds)) return "0s";
  // Use Math.round on total seconds first, then decompose — avoids
  // the case where Math.round(seconds % 60) === 60 (e.g., 59.6s → "60s").
  const totalSec = Math.round(seconds);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}
