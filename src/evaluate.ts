/**
 * Evaluate skill — post-dogfood evaluation and GaryClaw improvement extraction.
 *
 * Runs after the dogfood pipeline (bootstrap → prioritize → implement → qa → evaluate),
 * reads all .garyclaw/ artifacts from the target repo, and produces a structured
 * campaign report + GaryClaw improvement candidates.
 *
 * Follows the implement.ts / prioritize.ts pattern: pure functions that build
 * a prompt string, dispatched from pipeline.ts via runSkillWithPrompt().
 */

import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";

import { estimateTokens } from "./checkpoint.js";
import { safeReadJSON, safeReadText, safeWriteJSON, safeWriteText } from "./safe-json.js";
import { extractTopicKeywords, groupDecisionsByTopic, DEFAULT_AUTO_RESEARCH_CONFIG } from "./auto-research.js";
import { normalizedLevenshtein } from "./reflection.js";
import { computeGrowthRate } from "./token-monitor.js";

import type {
  Decision,
  PipelineSkillEntry,
  PipelineState,
  GaryClawConfig,
  EvaluationReport,
  BootstrapEvaluation,
  OracleEvaluation,
  PipelineEvaluation,
  ImprovementCandidate,
  ImprovementPriority,
  ImprovementEffort,
  ImprovementCategory,
  TokenMonitorState,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────

/** Expected sections in a well-formed CLAUDE.md */
export const EXPECTED_SECTIONS = ["Architecture", "Tech Stack", "Test Strategy", "Usage"];

/** Canonical framework names → dependency package names (case-insensitive match) */
export const KNOWN_FRAMEWORKS: ReadonlyMap<string, readonly string[]> = new Map([
  ["React", ["react", "react-dom", "@types/react"]],
  ["Next.js", ["next", "@next/font", "next-auth"]],
  ["Vitest", ["vitest", "@vitest/coverage-v8"]],
  ["Jest", ["jest", "@types/jest", "ts-jest"]],
  ["Express", ["express", "@types/express"]],
  ["Supabase", ["@supabase/supabase-js", "@supabase/ssr"]],
  ["Tailwind CSS", ["tailwindcss", "@tailwindcss/forms", "@tailwindcss/typography"]],
  ["Prisma", ["prisma", "@prisma/client"]],
  ["Vue", ["vue", "@vue/compiler-sfc"]],
  ["Angular", ["@angular/core", "@angular/cli"]],
  ["Svelte", ["svelte", "@sveltejs/kit"]],
  ["Nuxt", ["nuxt", "@nuxt/kit"]],
  ["Fastify", ["fastify"]],
  ["Koa", ["koa", "@types/koa"]],
  ["Hono", ["hono"]],
  ["Drizzle", ["drizzle-orm", "drizzle-kit"]],
  ["TypeORM", ["typeorm"]],
  ["Sequelize", ["sequelize"]],
  ["Mongoose", ["mongoose"]],
  ["Stripe", ["stripe", "@stripe/stripe-js"]],
  ["Auth.js", ["next-auth", "@auth/core"]],
  ["Clerk", ["@clerk/nextjs", "@clerk/clerk-sdk-node"]],
  ["tRPC", ["@trpc/server", "@trpc/client"]],
  ["Zod", ["zod"]],
  ["Playwright", ["playwright", "@playwright/test"]],
  ["Cypress", ["cypress"]],
  ["Storybook", ["storybook", "@storybook/react"]],
  ["ESLint", ["eslint", "@typescript-eslint/parser"]],
  ["Prettier", ["prettier"]],
  ["Mocha", ["mocha", "@types/mocha"]],
  ["Socket.IO", ["socket.io", "socket.io-client"]],
  ["GraphQL", ["graphql", "@apollo/client", "apollo-server"]],
  ["Docker", ["dockerode"]],
  ["Redis", ["redis", "ioredis"]],
  ["PostgreSQL", ["pg", "@types/pg"]],
  ["SQLite", ["better-sqlite3", "sqlite3"]],
  ["MongoDB", ["mongodb"]],
  ["Vite", ["vite"]],
  ["Webpack", ["webpack", "webpack-cli"]],
  ["Turbopack", ["@vercel/turbopack"]],
  ["Tauri", ["@tauri-apps/api", "@tauri-apps/cli"]],
  ["Electron", ["electron"]],
]);

// ── Token efficiency scoring ──────────────────────────────────────

/** Score token efficiency: 10 if 2K-10K, 5 if 1K-2K or 10K-20K, 0 otherwise */
export function scoreTokenEfficiency(tokens: number): number {
  if (tokens >= 2_000 && tokens <= 10_000) return 10;
  if ((tokens >= 1_000 && tokens < 2_000) || (tokens > 10_000 && tokens <= 20_000)) return 5;
  return 0;
}

// ── Dependency extraction ────────────────────────────────────────

/**
 * Extract dependency names from package.json content.
 * Returns lowercased dependency names from all dependency fields.
 */
export function extractDependencies(packageJsonContent: string): string[] {
  try {
    const pkg = JSON.parse(packageJsonContent);
    const deps = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      if (pkg[field] && typeof pkg[field] === "object") {
        for (const name of Object.keys(pkg[field])) {
          deps.add(name.toLowerCase());
        }
      }
    }
    return Array.from(deps);
  } catch {
    return [];
  }
}

/**
 * Compute framework coverage: how many known frameworks in deps are mentioned in CLAUDE.md.
 * Returns { mentioned, total, coverage } where coverage is 0-1.
 */
export function computeFrameworkCoverage(
  deps: string[],
  claudeMdContent: string,
): { mentioned: number; total: number; coverage: number } {
  const lowerContent = claudeMdContent.toLowerCase();
  const depSet = new Set(deps.map((d) => d.toLowerCase()));

  let mentioned = 0;
  let total = 0;

  for (const [frameworkName, packageNames] of KNOWN_FRAMEWORKS) {
    // Check if any of the framework's packages are in deps
    const inDeps = packageNames.some((pkg) => depSet.has(pkg.toLowerCase()));
    if (!inDeps) continue;

    total++;
    // Check if the framework name is mentioned in CLAUDE.md (case-insensitive)
    if (lowerContent.includes(frameworkName.toLowerCase())) {
      mentioned++;
    }
  }

  return {
    mentioned,
    total,
    coverage: total > 0 ? mentioned / total : 1, // No known frameworks = full coverage
  };
}

// ── Section detection ────────────────────────────────────────────

/**
 * Detect which expected sections exist in CLAUDE.md content.
 * Matches headings (## or ###) containing the section keyword.
 */
export function detectSections(
  content: string,
  expectedSections: string[] = EXPECTED_SECTIONS,
): { found: string[]; missing: string[] } {
  const lowerContent = content.toLowerCase();
  const found: string[] = [];
  const missing: string[] = [];

  for (const section of expectedSections) {
    // Match heading lines containing the section keyword
    const pattern = new RegExp(`^#{1,4}\\s+.*${section.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
    if (pattern.test(lowerContent)) {
      found.push(section);
    } else {
      missing.push(section);
    }
  }

  return { found, missing };
}

// ── Bootstrap evaluation ─────────────────────────────────────────

/**
 * Analyze the quality of generated CLAUDE.md and TODOS.md.
 * Pure TypeScript — no Claude calls needed.
 */
export function analyzeBootstrapQuality(projectDir: string): BootstrapEvaluation {
  const claudeMdPath = join(projectDir, "CLAUDE.md");
  const todosMdPath = join(projectDir, "TODOS.md");
  const packageJsonPath = join(projectDir, "package.json");

  const result: BootstrapEvaluation = {
    claudeMdExists: false,
    claudeMdSizeTokens: 0,
    claudeMdHasSections: [],
    claudeMdMissingSections: [...EXPECTED_SECTIONS],
    todosMdExists: false,
    todosMdItemCount: 0,
    todosMdItemsAboveThreshold: 0,
    qualityScore: 0,
    qualityNotes: [],
  };

  // Check CLAUDE.md
  if (!existsSync(claudeMdPath)) {
    result.qualityNotes.push("No artifacts found — CLAUDE.md missing");
    result.qualityScore = 0;
    return result;
  }

  const claudeMdContent = safeReadText(claudeMdPath) ?? "";
  result.claudeMdExists = true;
  result.claudeMdSizeTokens = estimateTokens(claudeMdContent);

  // Detect sections
  const { found, missing } = detectSections(claudeMdContent);
  result.claudeMdHasSections = found;
  result.claudeMdMissingSections = missing;

  if (missing.length > 0) {
    result.qualityNotes.push(`Missing sections: ${missing.join(", ")}`);
  }

  // Framework coverage
  let coverageRatio = 1;
  if (existsSync(packageJsonPath)) {
    const pkgContent = safeReadText(packageJsonPath) ?? "";
    const deps = extractDependencies(pkgContent);
    const coverage = computeFrameworkCoverage(deps, claudeMdContent);
    coverageRatio = coverage.coverage;
    if (coverage.total > 0 && coverage.mentioned < coverage.total) {
      result.qualityNotes.push(
        `Tech stack coverage: ${coverage.mentioned}/${coverage.total} known frameworks mentioned`,
      );
    }
  }

  // Check TODOS.md
  if (existsSync(todosMdPath)) {
    result.todosMdExists = true;
    const todosContent = safeReadText(todosMdPath) ?? "";
    // Count items (## P{N}: headings)
    const items = todosContent.match(/^## P\d:/gm) ?? [];
    result.todosMdItemCount = items.length;
    // We can't know which scored >5.0 without priority.md, so check if it exists
    const priorityPath = join(projectDir, ".garyclaw", "priority.md");
    if (existsSync(priorityPath)) {
      const priorityContent = safeReadText(priorityPath) ?? "";
      // Count items with score >5.0 from priority output
      const scoreMatches = priorityContent.match(/Score:\s*(\d+(?:\.\d+)?)/g) ?? [];
      result.todosMdItemsAboveThreshold = scoreMatches.filter((m) => {
        const score = parseFloat(m.replace("Score:", "").trim());
        return score > 5.0;
      }).length;
    }
  } else {
    result.qualityNotes.push("No artifacts found — TODOS.md missing");
  }

  // Compute quality score (0-100)
  // Structural completeness: 40 pts (10 per expected section)
  const structuralScore = (found.length / EXPECTED_SECTIONS.length) * 40;

  // Factual accuracy: 30 pts (coverage ratio * 30)
  const accuracyScore = coverageRatio * 30;

  // TODOS.md viability: 20 pts
  let viabilityScore = 0;
  if (result.todosMdExists && result.todosMdItemCount > 0) {
    viabilityScore = (result.todosMdItemsAboveThreshold / result.todosMdItemCount) * 20;
  }

  // Token efficiency: 10 pts
  const efficiencyScore = scoreTokenEfficiency(result.claudeMdSizeTokens);

  result.qualityScore = Math.round(structuralScore + accuracyScore + viabilityScore + efficiencyScore);

  return result;
}

// ── Oracle evaluation ────────────────────────────────────────────

/**
 * Analyze Oracle decision performance from decisions.jsonl.
 */
export function analyzeOraclePerformance(projectDir: string): OracleEvaluation {
  const result: OracleEvaluation = {
    totalDecisions: 0,
    lowConfidenceCount: 0,
    escalatedCount: 0,
    averageConfidence: 0,
    topicClusters: [],
    researchTriggered: false,
  };

  // Read decisions from .garyclaw/decisions.jsonl
  const decisionsPath = join(projectDir, ".garyclaw", "decisions.jsonl");
  if (!existsSync(decisionsPath)) return result;

  const content = safeReadText(decisionsPath) ?? "";
  const lines = content.trim().split("\n").filter(Boolean);
  const decisions: Decision[] = [];

  for (const line of lines) {
    try {
      const d = JSON.parse(line) as Decision;
      if (d.question && typeof d.confidence === "number") {
        decisions.push(d);
      }
    } catch {
      // skip corrupt lines
    }
  }

  if (decisions.length === 0) return result;

  result.totalDecisions = decisions.length;
  result.lowConfidenceCount = decisions.filter((d) => d.confidence < 6).length;
  result.averageConfidence = decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length;

  // Check for escalated decisions
  const escalatedPath = join(projectDir, ".garyclaw", "escalated.jsonl");
  if (existsSync(escalatedPath)) {
    const escContent = safeReadText(escalatedPath) ?? "";
    const escLines = escContent.trim().split("\n").filter(Boolean);
    result.escalatedCount = escLines.length;
  }

  // Topic clustering using auto-research's groupDecisionsByTopic
  const groups = groupDecisionsByTopic(decisions, {
    ...DEFAULT_AUTO_RESEARCH_CONFIG,
    lowConfidenceThreshold: 6,
  });
  result.topicClusters = groups.map((g) => ({
    topic: g.topic,
    count: g.decisions.length,
    avgConfidence: g.avgConfidence,
  }));

  // Check if auto-research was triggered
  const daemonStatePath = join(projectDir, ".garyclaw", "daemon-state.json");
  if (existsSync(daemonStatePath)) {
    const state = safeReadJSON<{ jobs?: { triggeredBy?: string }[] }>(daemonStatePath);
    if (state?.jobs) {
      result.researchTriggered = state.jobs.some((j) => j.triggeredBy === "auto_research");
    }
  }

  return result;
}

// ── Pipeline evaluation ──────────────────────────────────────────

/**
 * Analyze pipeline health from pipeline.json and checkpoint files.
 */
export function analyzePipelineHealth(projectDir: string): PipelineEvaluation {
  const result: PipelineEvaluation = {
    skillsRun: [],
    skillsCompleted: [],
    skillsFailed: [],
    totalRelays: 0,
    totalCostUsd: 0,
    totalDurationSec: 0,
    contextGrowthRate: 0,
    adaptiveTurnsUsed: false,
  };

  // Read pipeline state
  const pipelinePath = join(projectDir, ".garyclaw", "pipeline.json");
  if (!existsSync(pipelinePath)) return result;

  const state = safeReadJSON<PipelineState>(pipelinePath);
  if (!state?.skills) return result;

  result.skillsRun = state.skills.map((s) => s.skillName);
  result.skillsCompleted = state.skills.filter((s) => s.status === "complete").map((s) => s.skillName);
  result.skillsFailed = state.skills.filter((s) => s.status === "failed").map((s) => s.skillName);
  result.totalCostUsd = state.totalCostUsd ?? 0;

  // Compute duration from timestamps
  if (state.startTime) {
    const start = new Date(state.startTime).getTime();
    const lastSkill = state.skills.filter((s) => s.endTime).pop();
    if (lastSkill?.endTime) {
      const end = new Date(lastSkill.endTime).getTime();
      result.totalDurationSec = Math.max(0, (end - start) / 1000);
    }
  }

  // Count relays from checkpoint files and compute growth rates
  const growthRates: number[] = [];
  const checkpointDir = join(projectDir, ".garyclaw");

  for (let i = 0; i < state.skills.length; i++) {
    const skillDir = join(checkpointDir, `skill-${i}-${state.skills[i].skillName}`);
    if (!existsSync(skillDir)) continue;

    // Read checkpoint for relay and growth data
    const cpPath = join(skillDir, "checkpoint.json");
    if (!existsSync(cpPath)) continue;

    const cp = safeReadJSON<{ tokenUsage?: { turnHistory?: { computedContextSize: number; turn: number }[]; sessionCount?: number } }>(cpPath);
    if (!cp?.tokenUsage) continue;

    // Count relays (sessionCount > 1 means relays happened)
    const sessions = cp.tokenUsage.sessionCount ?? 1;
    if (sessions > 1) {
      result.totalRelays += sessions - 1;
    }

    // Compute growth rate from turn history
    if (cp.tokenUsage.turnHistory && cp.tokenUsage.turnHistory.length >= 2) {
      const monitorState: TokenMonitorState = {
        contextWindow: 1_000_000,
        totalOutputTokens: 0,
        estimatedCostUsd: 0,
        turnHistory: cp.tokenUsage.turnHistory.map((t, idx) => ({
          turn: t.turn ?? idx + 1,
          inputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          computedContextSize: t.computedContextSize,
        })),
        turnCounter: cp.tokenUsage.turnHistory.length,
      };
      const rate = computeGrowthRate(monitorState);
      if (rate !== null) {
        growthRates.push(rate);
      }
    }
  }

  // Average growth rate across all segments
  if (growthRates.length > 0) {
    result.contextGrowthRate = growthRates.reduce((sum, r) => sum + r, 0) / growthRates.length;
  }

  // Check for adaptive turns events in daemon state
  const daemonStatePath = join(projectDir, ".garyclaw", "daemon-state.json");
  if (existsSync(daemonStatePath)) {
    const dState = safeReadJSON<{ jobs?: { adaptiveTurnsStats?: { adaptiveCount?: number } }[] }>(daemonStatePath);
    if (dState?.jobs) {
      result.adaptiveTurnsUsed = dState.jobs.some(
        (j) => j.adaptiveTurnsStats && (j.adaptiveTurnsStats.adaptiveCount ?? 0) > 0,
      );
    }
  }

  return result;
}

// ── Obvious improvements extraction ──────────────────────────────

/**
 * Extract deterministic improvement candidates from metrics thresholds.
 * Pure function — no Claude calls needed.
 */
export function extractObviousImprovements(report: EvaluationReport): ImprovementCandidate[] {
  const candidates: ImprovementCandidate[] = [];

  // Bootstrap missing sections → P2
  if (report.bootstrap.claudeMdExists && report.bootstrap.claudeMdMissingSections.length > 0) {
    candidates.push({
      title: `Bootstrap missing ${report.bootstrap.claudeMdMissingSections.join(", ")} detection`,
      priority: "P2",
      effort: "XS",
      category: "bootstrap",
      description: `Bootstrap's analyzeCodebase() doesn't generate ${report.bootstrap.claudeMdMissingSections.join(", ")} section(s). These expected sections were absent from the generated CLAUDE.md.`,
      evidence: `Target repo CLAUDE.md missing sections: ${report.bootstrap.claudeMdMissingSections.join(", ")}`,
    });
  }

  // Low-confidence Oracle clusters (3+ decisions, avg confidence < 6) → P3
  for (const cluster of report.oracle.topicClusters) {
    if (cluster.count >= 3 && cluster.avgConfidence < 6) {
      candidates.push({
        title: `Oracle domain gap — ${cluster.topic}`,
        priority: "P3",
        effort: "XS",
        category: "oracle",
        description: `Oracle made ${cluster.count} low-confidence decisions about "${cluster.topic}". Domain expertise research should be auto-triggered for this topic.`,
        evidence: `${cluster.count} decisions, avg confidence ${cluster.avgConfidence.toFixed(1)}/10`,
      });
    }
  }

  // High relay count for single skills → P3
  if (report.pipeline.totalRelays > 3) {
    candidates.push({
      title: "Excessive relays in dogfood pipeline",
      priority: "P3",
      effort: "S",
      category: "relay",
      description: `Pipeline triggered ${report.pipeline.totalRelays} relays total. Consider optimizing context usage or increasing relay threshold for dogfood runs.`,
      evidence: `${report.pipeline.totalRelays} relays across ${report.pipeline.skillsRun.length} skills`,
    });
  }

  // Failed skills → P2
  if (report.pipeline.skillsFailed.length > 0) {
    candidates.push({
      title: `Pipeline skill failures: ${report.pipeline.skillsFailed.join(", ")}`,
      priority: "P2",
      effort: "S",
      category: "pipeline",
      description: `${report.pipeline.skillsFailed.length} skill(s) failed during the dogfood pipeline. Investigate root cause and add resilience.`,
      evidence: `Failed: ${report.pipeline.skillsFailed.join(", ")}. Completed: ${report.pipeline.skillsCompleted.join(", ")}`,
    });
  }

  // Low bootstrap quality → P2
  if (report.bootstrap.claudeMdExists && report.bootstrap.qualityScore < 50) {
    candidates.push({
      title: "Bootstrap quality below threshold",
      priority: "P2",
      effort: "M",
      category: "bootstrap",
      description: `Bootstrap quality score is ${report.bootstrap.qualityScore}/100. The generated CLAUDE.md needs significant improvement in completeness and accuracy.`,
      evidence: `Quality score: ${report.bootstrap.qualityScore}/100. Notes: ${report.bootstrap.qualityNotes.join("; ")}`,
    });
  }

  return candidates;
}

// ── Claude improvements parsing ──────────────────────────────────

const VALID_PRIORITIES = new Set<ImprovementPriority>(["P2", "P3", "P4"]);
const VALID_EFFORTS = new Set<ImprovementEffort>(["XS", "S", "M"]);
const VALID_CATEGORIES = new Set<ImprovementCategory>(["bootstrap", "oracle", "pipeline", "skill", "relay"]);

/**
 * Parse improvement candidates from Claude's segment output.
 * Expects a JSON array within an <improvements> block.
 */
export function parseClaudeImprovements(output: string): ImprovementCandidate[] {
  // Extract <improvements> block
  const match = output.match(/<improvements>([\s\S]*?)<\/improvements>/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[1].trim());
    if (!Array.isArray(parsed)) return [];

    const valid: ImprovementCandidate[] = [];
    for (const item of parsed) {
      if (
        typeof item.title === "string" &&
        typeof item.description === "string" &&
        typeof item.evidence === "string" &&
        VALID_PRIORITIES.has(item.priority) &&
        VALID_EFFORTS.has(item.effort) &&
        VALID_CATEGORIES.has(item.category)
      ) {
        valid.push({
          title: item.title,
          priority: item.priority,
          effort: item.effort,
          category: item.category,
          description: item.description,
          evidence: item.evidence,
        });
      }
    }
    return valid;
  } catch {
    return [];
  }
}

// ── Dedup improvements ───────────────────────────────────────────

/**
 * Merge obvious + Claude improvements, deduplicating by normalized Levenshtein
 * distance < 0.3 on titles. When duplicates exist, keep the version with
 * longer evidence (proxy for more specific).
 */
export function deduplicateImprovements(
  obvious: ImprovementCandidate[],
  claude: ImprovementCandidate[],
): ImprovementCandidate[] {
  const all = [...obvious, ...claude];
  const result: ImprovementCandidate[] = [];

  for (const candidate of all) {
    const duplicate = result.findIndex(
      (existing) => normalizedLevenshtein(existing.title, candidate.title) < 0.3,
    );

    if (duplicate === -1) {
      result.push(candidate);
    } else {
      // Keep the one with more specific evidence
      if (candidate.evidence.length > result[duplicate].evidence.length) {
        result[duplicate] = candidate;
      }
    }
  }

  return result;
}

// ── Report formatting ────────────────────────────────────────────

/**
 * Format the evaluation report as human-readable markdown.
 */
export function formatEvaluationReport(report: EvaluationReport): string {
  const lines: string[] = [];

  lines.push("# Dogfood Evaluation Report");
  lines.push("");
  lines.push(`**Target:** ${report.targetRepo}`);
  lines.push(`**Date:** ${report.timestamp}`);
  lines.push(`**Pipeline:** ${report.pipeline.skillsRun.join(" → ")}`);
  lines.push("");

  // Bootstrap Quality
  lines.push(`## Bootstrap Quality: ${report.bootstrap.qualityScore}/100`);
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("|-------|--------|");
  lines.push(`| CLAUDE.md exists | ${report.bootstrap.claudeMdExists ? "YES" : "NO"} |`);
  lines.push(`| CLAUDE.md size | ${report.bootstrap.claudeMdSizeTokens.toLocaleString()} tokens |`);
  for (const section of EXPECTED_SECTIONS) {
    const has = report.bootstrap.claudeMdHasSections.includes(section);
    lines.push(`| ${section} section | ${has ? "YES" : "MISSING"} |`);
  }
  lines.push(`| TODOS.md exists | ${report.bootstrap.todosMdExists ? "YES" : "NO"} |`);
  lines.push(`| TODOS.md items | ${report.bootstrap.todosMdItemCount} |`);
  lines.push(`| Items above 5.0 threshold | ${report.bootstrap.todosMdItemsAboveThreshold} |`);
  lines.push("");

  if (report.bootstrap.qualityNotes.length > 0) {
    lines.push("**Notes:**");
    for (const note of report.bootstrap.qualityNotes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  // Oracle Performance
  lines.push("## Oracle Performance");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total decisions | ${report.oracle.totalDecisions} |`);
  lines.push(`| Low confidence (<6) | ${report.oracle.lowConfidenceCount} |`);
  lines.push(`| Escalated | ${report.oracle.escalatedCount} |`);
  lines.push(`| Avg confidence | ${report.oracle.averageConfidence.toFixed(1)} |`);
  lines.push(`| Auto-research triggered | ${report.oracle.researchTriggered ? "Yes" : "No"} |`);
  lines.push("");

  if (report.oracle.topicClusters.length > 0) {
    lines.push("**Low-confidence clusters:**");
    for (const cluster of report.oracle.topicClusters) {
      lines.push(`- "${cluster.topic}" (${cluster.count} decisions, avg confidence ${cluster.avgConfidence.toFixed(1)})`);
    }
    lines.push("");
  }

  // Pipeline Health
  lines.push("## Pipeline Health");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Skills run | ${report.pipeline.skillsCompleted.length}/${report.pipeline.skillsRun.length} |`);
  lines.push(`| Total relays | ${report.pipeline.totalRelays} |`);
  lines.push(`| Total cost | $${report.pipeline.totalCostUsd.toFixed(2)} |`);
  lines.push(`| Duration | ${formatDuration(report.pipeline.totalDurationSec)} |`);
  lines.push(`| Avg context growth | ${report.pipeline.contextGrowthRate.toFixed(2)}/turn |`);
  lines.push("");

  // Improvement Candidates
  if (report.improvements.length > 0) {
    lines.push("## GaryClaw Improvement Candidates");
    lines.push("");
    for (const imp of report.improvements) {
      lines.push(`### ${imp.priority}: ${imp.title}`);
      lines.push(imp.description);
      lines.push(`**Effort:** ${imp.effort} | **Category:** ${imp.category}`);
      lines.push(`**Evidence:** ${imp.evidence}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("*Generated by GaryClaw Evaluate Skill*");

  return lines.join("\n");
}

/** Format seconds into human-readable duration */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

// ── TODOS.md formatting ──────────────────────────────────────────

/**
 * Format improvement candidates as TODOS.md entries matching parseTodoItems() contract.
 */
export function formatImprovementCandidates(
  candidates: ImprovementCandidate[],
  date: string = new Date().toISOString().split("T")[0],
): string {
  const blocks: string[] = [];

  for (const c of candidates) {
    blocks.push(`## ${c.priority}: ${c.title}

**What:** ${c.description}

**Why:** ${c.evidence}

**Effort:** ${c.effort} (human: ~${humanEffortEstimate(c.effort)} / CC: ~${ccEffortEstimate(c.effort)})
**Depends on:** Nothing
**Added by:** evaluate skill on ${date}`);
  }

  return blocks.join("\n\n");
}

function humanEffortEstimate(effort: ImprovementEffort): string {
  switch (effort) {
    case "XS": return "30min";
    case "S": return "2 days";
    case "M": return "1 week";
  }
}

function ccEffortEstimate(effort: ImprovementEffort): string {
  switch (effort) {
    case "XS": return "5min";
    case "S": return "20min";
    case "M": return "1h";
  }
}

// ── Report writing ───────────────────────────────────────────────

/**
 * Write evaluation report to .garyclaw/ directory as both JSON and markdown.
 */
export function writeEvaluationReport(projectDir: string, report: EvaluationReport): void {
  const dir = join(projectDir, ".garyclaw");
  mkdirSync(dir, { recursive: true });

  safeWriteJSON(join(dir, "evaluation-report.json"), report);
  safeWriteText(join(dir, "evaluation-report.md"), formatEvaluationReport(report));

  // Also write improvement candidates for standalone mode
  if (report.improvements.length > 0) {
    safeWriteText(
      join(dir, "improvement-candidates.md"),
      formatImprovementCandidates(report.improvements, report.timestamp.split("T")[0]),
    );
  }
}

// ── Prompt builder ───────────────────────────────────────────────

/**
 * Build the evaluation prompt for Claude. Assembles all analysis data
 * and asks Claude to synthesize additional improvement candidates.
 */
export function buildEvaluatePrompt(
  config: GaryClawConfig,
  previousSkills: PipelineSkillEntry[],
  projectDir: string,
): string {
  // Run all analysis functions with error boundary — corrupt .garyclaw/ data
  // should degrade gracefully, not crash the entire evaluate skill.
  let bootstrap: ReturnType<typeof analyzeBootstrapQuality>;
  let oracle: ReturnType<typeof analyzeOraclePerformance>;
  let pipeline: ReturnType<typeof analyzePipelineHealth>;
  let obvious: ReturnType<typeof extractObviousImprovements>;

  try {
    bootstrap = analyzeBootstrapQuality(projectDir);
  } catch {
    bootstrap = { claudeMdExists: false, claudeMdSizeTokens: 0, claudeMdHasSections: [], claudeMdMissingSections: [...EXPECTED_SECTIONS], todosMdExists: false, todosMdItemCount: 0, todosMdItemsAboveThreshold: 0, qualityScore: 0, qualityNotes: ["analyzeBootstrapQuality threw an error"] };
  }

  try {
    oracle = analyzeOraclePerformance(projectDir);
  } catch {
    oracle = { totalDecisions: 0, lowConfidenceCount: 0, escalatedCount: 0, averageConfidence: 0, topicClusters: [], researchTriggered: false };
  }

  try {
    pipeline = analyzePipelineHealth(projectDir);
  } catch {
    pipeline = { skillsRun: [], skillsCompleted: [], skillsFailed: [], totalRelays: 0, totalCostUsd: 0, totalDurationSec: 0, contextGrowthRate: 0, adaptiveTurnsUsed: false };
  }

  try {
    obvious = extractObviousImprovements({
      targetRepo: projectDir,
      timestamp: new Date().toISOString(),
      bootstrap,
      oracle,
      pipeline,
      improvements: [],
    });
  } catch {
    obvious = [];
  }

  const lines: string[] = [];

  lines.push("You are a GaryClaw self-improvement analyst. You just finished running the dogfood pipeline on an external repository. Your job is to analyze the results and identify improvement opportunities for GaryClaw itself.");
  lines.push("");

  // Section 1: Analysis data
  lines.push("## Evaluation Data");
  lines.push("");
  lines.push("### Bootstrap Quality");
  lines.push(`- CLAUDE.md exists: ${bootstrap.claudeMdExists}`);
  lines.push(`- CLAUDE.md size: ${bootstrap.claudeMdSizeTokens} tokens`);
  lines.push(`- Sections found: ${bootstrap.claudeMdHasSections.join(", ") || "none"}`);
  lines.push(`- Sections missing: ${bootstrap.claudeMdMissingSections.join(", ") || "none"}`);
  lines.push(`- Quality score: ${bootstrap.qualityScore}/100`);
  lines.push(`- Notes: ${bootstrap.qualityNotes.join("; ") || "none"}`);
  lines.push("");

  lines.push("### Oracle Performance");
  lines.push(`- Total decisions: ${oracle.totalDecisions}`);
  lines.push(`- Low confidence (<6): ${oracle.lowConfidenceCount}`);
  lines.push(`- Escalated: ${oracle.escalatedCount}`);
  lines.push(`- Average confidence: ${oracle.averageConfidence.toFixed(1)}`);
  if (oracle.topicClusters.length > 0) {
    lines.push("- Topic clusters:");
    for (const c of oracle.topicClusters) {
      lines.push(`  - "${c.topic}" (${c.count} decisions, avg ${c.avgConfidence.toFixed(1)})`);
    }
  }
  lines.push("");

  lines.push("### Pipeline Health");
  lines.push(`- Skills run: ${pipeline.skillsRun.join(", ") || "none"}`);
  lines.push(`- Completed: ${pipeline.skillsCompleted.join(", ") || "none"}`);
  lines.push(`- Failed: ${pipeline.skillsFailed.join(", ") || "none"}`);
  lines.push(`- Total relays: ${pipeline.totalRelays}`);
  lines.push(`- Total cost: $${pipeline.totalCostUsd.toFixed(2)}`);
  lines.push(`- Duration: ${formatDuration(pipeline.totalDurationSec)}`);
  lines.push(`- Context growth rate: ${pipeline.contextGrowthRate.toFixed(2)} tok/turn`);
  lines.push("");

  // Section 2: Already-identified improvements
  if (obvious.length > 0) {
    lines.push("### Already Identified Improvements");
    for (const imp of obvious) {
      lines.push(`- [${imp.priority}] ${imp.title}: ${imp.description}`);
    }
    lines.push("");
  }

  // Section 3: Previous skill context
  if (previousSkills.length > 0) {
    lines.push("### Previous Skills Context");
    for (const skill of previousSkills) {
      if (skill.report) {
        lines.push(`- /${skill.skillName}: ${skill.report.issues.length} issues, ${skill.report.findings.length} findings, $${skill.report.estimatedCostUsd.toFixed(3)}`);
      }
    }
    lines.push("");
  }

  // Section 4: Instructions
  lines.push("## Instructions");
  lines.push("");
  lines.push("1. Review the evaluation data above.");
  lines.push("2. Identify additional GaryClaw improvement opportunities that the automated analysis missed.");
  lines.push("3. Focus on improvements to GaryClaw itself (not the target repo).");
  lines.push("4. Prioritize improvements that would make the next dogfood run more effective.");
  lines.push("5. Output your improvement candidates as a JSON array in an <improvements> block.");
  lines.push("");
  lines.push("Output format:");
  lines.push("```");
  lines.push("<improvements>");
  lines.push('[');
  lines.push('  { "title": "...", "priority": "P3", "effort": "S", "category": "bootstrap", "description": "...", "evidence": "..." }');
  lines.push(']');
  lines.push("</improvements>");
  lines.push("```");
  lines.push("");
  lines.push("Valid priorities: P2, P3, P4 (P1 reserved for human-escalated)");
  lines.push("Valid efforts: XS, S, M");
  lines.push("Valid categories: bootstrap, oracle, pipeline, skill, relay");
  lines.push("");
  lines.push("After outputting improvements, write the full evaluation report to:");
  lines.push(`- ${join(projectDir, ".garyclaw", "evaluation-report.json")}`);
  lines.push(`- ${join(projectDir, ".garyclaw", "evaluation-report.md")}`);
  lines.push(`- ${join(projectDir, ".garyclaw", "improvement-candidates.md")} (one ## section per improvement, used by the post-pipeline hook to append to GaryClaw's TODOS.md)`);

  return lines.join("\n");
}
