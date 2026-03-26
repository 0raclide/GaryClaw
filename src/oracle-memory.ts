/**
 * Oracle Memory — read/write oracle memory files with two-layer resolution.
 *
 * Two layers:
 * - Global: ~/.garyclaw/oracle-memory/ (taste.md, domain-expertise.md)
 * - Per-project: .garyclaw/oracle-memory/ (taste.md, domain-expertise.md, decision-outcomes.md)
 *
 * Scoping rules:
 * - decision-outcomes.md is per-project ONLY (project failures shouldn't poison others)
 * - taste.md and domain-expertise.md exist in both layers; project overrides global on conflict
 * - MEMORY.md is read from project root (auto-memory file)
 *
 * Memory file integrity: On parse error or malformed content, rename to .bak,
 * treat as empty, log warning.
 *
 * Budget enforcement: Each file has a hard cap in estimated tokens.
 * Truncation strategies vary by file type.
 */

import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { safeReadJSON, safeWriteJSON, safeReadText, safeWriteText } from "./safe-json.js";
import { estimateTokens } from "./checkpoint.js";
import type {
  OracleMemoryConfig,
  OracleMemoryFiles,
  OracleMetrics,
  DecisionOutcome,
} from "./types.js";
import { ORACLE_MEMORY_BUDGETS as BUDGETS } from "./types.js";

// ── File names ──────────────────────────────────────────────────

const TASTE_FILE = "taste.md";
const DOMAIN_FILE = "domain-expertise.md";
const OUTCOMES_FILE = "decision-outcomes.md";
const METRICS_FILE = "metrics.json";
const MEMORY_MD = "MEMORY.md";

// ── Prompt injection sanitization ────────────────────────────────

/**
 * Known prompt injection patterns to strip from memory file content
 * before injecting into Oracle prompt.
 */
const INJECTION_PATTERNS = [
  /^<\/?system[^>]*>/gim,
  /^<\/?instructions[^>]*>/gim,
  /^IGNORE ALL PREVIOUS INSTRUCTIONS/gim,
  /^YOU ARE NOW/gim,
  /^FORGET EVERYTHING/gim,
  /^NEW INSTRUCTIONS:/gim,
  /^OVERRIDE:/gim,
  /^SYSTEM:/gim,
];

/**
 * Strip known prompt injection patterns from memory content.
 */
export function sanitizeMemoryContent(content: string): string {
  let sanitized = content;
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}

// ── Default config ──────────────────────────────────────────────

/**
 * Build default oracle memory config from a project directory.
 */
export function defaultMemoryConfig(projectDir: string): OracleMemoryConfig {
  return {
    globalDir: join(homedir(), ".garyclaw", "oracle-memory"),
    projectDir: join(projectDir, ".garyclaw", "oracle-memory"),
  };
}

// ── Init ────────────────────────────────────────────────────────

/**
 * Initialize oracle memory directories and template files.
 * Creates both global and per-project directories.
 * Only creates template files if they don't already exist.
 */
export function initOracleMemory(config: OracleMemoryConfig): void {
  mkdirSync(config.globalDir, { recursive: true });
  mkdirSync(config.projectDir, { recursive: true });

  // Global templates
  const globalTaste = join(config.globalDir, TASTE_FILE);
  if (!existsSync(globalTaste)) {
    safeWriteText(globalTaste, TASTE_TEMPLATE);
  }

  const globalDomain = join(config.globalDir, DOMAIN_FILE);
  if (!existsSync(globalDomain)) {
    safeWriteText(globalDomain, DOMAIN_TEMPLATE);
  }

  // Project templates
  const projectTaste = join(config.projectDir, TASTE_FILE);
  if (!existsSync(projectTaste)) {
    safeWriteText(projectTaste, TASTE_TEMPLATE);
  }

  const projectDomain = join(config.projectDir, DOMAIN_FILE);
  if (!existsSync(projectDomain)) {
    safeWriteText(projectDomain, DOMAIN_TEMPLATE);
  }

  const projectOutcomes = join(config.projectDir, OUTCOMES_FILE);
  if (!existsSync(projectOutcomes)) {
    safeWriteText(projectOutcomes, OUTCOMES_TEMPLATE);
  }

  // Initialize metrics
  const metricsPath = join(config.projectDir, METRICS_FILE);
  if (!existsSync(metricsPath)) {
    safeWriteJSON(metricsPath, defaultMetrics());
  }
}

// ── Read ────────────────────────────────────────────────────────

/**
 * Read all oracle memory files with two-layer resolution.
 *
 * Resolution order per file:
 * 1. Per-project version (if exists and non-empty)
 * 2. Global version (fallback)
 * 3. null (file not found in either layer)
 *
 * Exception: decision-outcomes.md is per-project ONLY.
 *
 * All content is sanitized and truncated to budget before return.
 */
export function readOracleMemory(
  config: OracleMemoryConfig,
  projectRootDir?: string,
): OracleMemoryFiles {
  if (config.disableMemory) {
    return { taste: null, domainExpertise: null, decisionOutcomes: null, memoryMd: null };
  }

  const taste = resolveLayered(config, TASTE_FILE);
  const domainExpertise = resolveLayered(config, DOMAIN_FILE);

  // decision-outcomes.md is per-project ONLY
  const decisionOutcomes = readAndSanitize(
    join(config.projectDir, OUTCOMES_FILE),
    BUDGETS.decisionOutcomes,
  );

  // MEMORY.md from project root
  const memoryMdPath = projectRootDir
    ? join(projectRootDir, MEMORY_MD)
    : null;
  const memoryMd = memoryMdPath
    ? readAndSanitize(memoryMdPath, BUDGETS.memoryMd)
    : null;

  // resolveLayered() already sanitizes and truncates via readAndSanitize(),
  // so no additional truncation needed here.
  return {
    taste,
    domainExpertise,
    decisionOutcomes,
    memoryMd,
  };
}

/**
 * Resolve a file from the two-layer system.
 * Per-project overrides global. Returns sanitized content or null.
 */
function resolveLayered(config: OracleMemoryConfig, fileName: string): string | null {
  // Try per-project first
  const projectContent = readAndSanitize(
    join(config.projectDir, fileName),
    getBudgetForFile(fileName),
  );
  if (projectContent && projectContent.trim().length > 0) {
    return projectContent;
  }

  // Fall back to global
  return readAndSanitize(
    join(config.globalDir, fileName),
    getBudgetForFile(fileName),
  );
}

/**
 * Read a file, sanitize content, and truncate to budget.
 * Returns null if file doesn't exist or is empty.
 */
function readAndSanitize(filePath: string, budget: number): string | null {
  const content = safeReadText(filePath);
  if (content === null || content.trim().length === 0) return null;

  const sanitized = sanitizeMemoryContent(content);
  return truncateToTokenBudget(sanitized, budget);
}

function getBudgetForFile(fileName: string): number {
  switch (fileName) {
    case TASTE_FILE: return BUDGETS.taste;
    case DOMAIN_FILE: return BUDGETS.domainExpertise;
    case OUTCOMES_FILE: return BUDGETS.decisionOutcomes;
    default: return BUDGETS.memoryMd;
  }
}

// ── Write ───────────────────────────────────────────────────────

/**
 * Write taste.md to the specified layer.
 */
export function writeTaste(
  config: OracleMemoryConfig,
  content: string,
  layer: "global" | "project" = "project",
): void {
  const dir = layer === "global" ? config.globalDir : config.projectDir;
  const truncated = truncateToTokenBudget(content, BUDGETS.taste);
  safeWriteText(join(dir, TASTE_FILE), truncated);
}

/**
 * Write domain-expertise.md to the specified layer.
 */
export function writeDomainExpertise(
  config: OracleMemoryConfig,
  content: string,
  layer: "global" | "project" = "project",
): void {
  const dir = layer === "global" ? config.globalDir : config.projectDir;
  const truncated = truncateToTokenBudget(content, BUDGETS.domainExpertise);
  safeWriteText(join(dir, DOMAIN_FILE), truncated);
}

/**
 * Write decision-outcomes.md (per-project only).
 */
export function writeDecisionOutcomes(
  config: OracleMemoryConfig,
  content: string,
): void {
  const truncated = truncateToTokenBudget(content, BUDGETS.decisionOutcomes);
  safeWriteText(join(config.projectDir, OUTCOMES_FILE), truncated);
}

// ── Metrics ─────────────────────────────────────────────────────

/**
 * Read oracle metrics. Returns default metrics if file is missing or corrupt.
 */
export function readMetrics(config: OracleMemoryConfig): OracleMetrics {
  const path = join(config.projectDir, METRICS_FILE);
  const data = safeReadJSON<OracleMetrics>(path, validateMetrics);
  return data ?? defaultMetrics();
}

/**
 * Write oracle metrics.
 */
export function writeMetrics(config: OracleMemoryConfig, metrics: OracleMetrics): void {
  safeWriteJSON(join(config.projectDir, METRICS_FILE), metrics);
}

/**
 * Update metrics with a new decision outcome.
 */
export function updateMetricsWithOutcome(
  metrics: OracleMetrics,
  outcome: DecisionOutcome,
): OracleMetrics {
  const updated = { ...metrics };
  updated.totalDecisions++;

  switch (outcome.outcome) {
    case "success":
      updated.accurateDecisions++;
      break;
    case "neutral":
      updated.neutralDecisions++;
      break;
    case "failure":
      updated.failedDecisions++;
      break;
  }

  // Recalculate accuracy (only counts success + failure, not neutral)
  const denominator = updated.accurateDecisions + updated.failedDecisions;
  updated.accuracyPercent = denominator > 0
    ? (updated.accurateDecisions / denominator) * 100
    : 100;

  // Update confidence trend (rolling window of 20)
  updated.confidenceTrend = [
    ...updated.confidenceTrend.slice(-19),
    outcome.confidence,
  ];

  // Check circuit breaker: accuracy < 60% with at least 10 measured decisions
  updated.circuitBreakerTripped = denominator >= 10 && updated.accuracyPercent < 60;

  return updated;
}

/**
 * Check if the circuit breaker is tripped (accuracy < 60%).
 * When tripped, memory injection should be disabled.
 */
export function isCircuitBreakerTripped(config: OracleMemoryConfig): boolean {
  const metrics = readMetrics(config);
  return metrics.circuitBreakerTripped;
}

// ── Decision outcomes (rolling window) ──────────────────────────

/**
 * Read decision outcomes from the per-project outcomes file.
 * Returns parsed outcomes or empty array.
 */
export function readDecisionOutcomes(config: OracleMemoryConfig): DecisionOutcome[] {
  const path = join(config.projectDir, OUTCOMES_FILE);
  const content = safeReadText(path);
  if (!content) return [];

  return parseDecisionOutcomes(content);
}

/**
 * Write decision outcomes, maintaining a rolling window of ~50 entries.
 * Older entries beyond 50 are summarized into a patterns section.
 */
export function writeDecisionOutcomesRolling(
  config: OracleMemoryConfig,
  outcomes: DecisionOutcome[],
): void {
  const MAX_ENTRIES = 50;

  if (outcomes.length <= MAX_ENTRIES) {
    writeDecisionOutcomes(config, formatDecisionOutcomes(outcomes));
    return;
  }

  // Keep last 50, summarize older into patterns
  const recent = outcomes.slice(-MAX_ENTRIES);
  const older = outcomes.slice(0, -MAX_ENTRIES);
  const patterns = summarizeOutcomePatterns(older);

  const content = `# Decision Outcomes\n\n## Patterns (from ${older.length} older decisions)\n${patterns}\n\n## Recent Outcomes (${recent.length})\n${formatOutcomeEntries(recent)}`;
  writeDecisionOutcomes(config, content);
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Truncate text to fit within a token budget.
 * Uses a direct proportional cut (O(1)) instead of line-by-line removal (O(n²)).
 * estimateTokens uses chars/4 heuristic, so we can compute target chars directly.
 */
export function truncateToTokenBudget(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) return content;

  const maxChars = maxTokens * 4;

  // Slice from the end (keep newest content, drop oldest)
  const sliced = content.slice(-maxChars);

  // Snap to the next newline to avoid cutting mid-line
  const firstNewline = sliced.indexOf("\n");
  if (firstNewline >= 0 && firstNewline < sliced.length - 1) {
    return sliced.slice(firstNewline + 1);
  }

  return sliced;
}

function defaultMetrics(): OracleMetrics {
  return {
    totalDecisions: 0,
    accurateDecisions: 0,
    neutralDecisions: 0,
    failedDecisions: 0,
    accuracyPercent: 100,
    confidenceTrend: [],
    lastReflectionTimestamp: null,
    circuitBreakerTripped: false,
  };
}

function validateMetrics(data: unknown): data is OracleMetrics {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.totalDecisions === "number" &&
    typeof d.accurateDecisions === "number" &&
    typeof d.accuracyPercent === "number" &&
    Array.isArray(d.confidenceTrend)
  );
}

/**
 * Parse decision outcomes from the outcomes markdown file.
 * Format per entry:
 * ### <decisionId>
 * - **Question:** ...
 * - **Chosen:** ...
 * - **Outcome:** success|neutral|failure
 */
export function parseDecisionOutcomes(content: string): DecisionOutcome[] {
  const outcomes: DecisionOutcome[] = [];
  const entryRegex = /### ([\w-]+)\n([\s\S]*?)(?=\n### |\n## |$)/g;

  let match;
  while ((match = entryRegex.exec(content)) !== null) {
    const id = match[1];
    const body = match[2];

    const question = extractField(body, "Question");
    const chosen = extractField(body, "Chosen");
    const confidence = parseInt(extractField(body, "Confidence") || "5", 10);
    const principle = extractField(body, "Principle") || "Unknown";
    const outcome = extractField(body, "Outcome") as DecisionOutcome["outcome"] || "neutral";
    const outcomeDetail = extractField(body, "Detail");
    const relatedFilePath = extractField(body, "File");
    const timestamp = extractField(body, "Timestamp") || "";
    const jobId = extractField(body, "Job");

    if (question && chosen) {
      outcomes.push({
        decisionId: id,
        timestamp,
        question,
        chosen,
        confidence,
        principle,
        outcome: ["success", "neutral", "failure"].includes(outcome) ? outcome : "neutral",
        outcomeDetail: outcomeDetail || undefined,
        relatedFilePath: relatedFilePath || undefined,
        jobId: jobId || undefined,
      });
    }
  }

  return outcomes;
}

function extractField(body: string, fieldName: string): string | null {
  const regex = new RegExp(`\\*\\*${fieldName}:\\*\\*\\s*(.+)`, "i");
  const match = body.match(regex);
  return match ? match[1].trim() : null;
}

function formatDecisionOutcomes(outcomes: DecisionOutcome[]): string {
  return `# Decision Outcomes\n\n## Recent Outcomes (${outcomes.length})\n${formatOutcomeEntries(outcomes)}`;
}

function formatOutcomeEntries(outcomes: DecisionOutcome[]): string {
  return outcomes.map((o) => {
    const lines = [
      `### ${o.decisionId}`,
      `- **Timestamp:** ${o.timestamp}`,
      `- **Question:** ${o.question}`,
      `- **Chosen:** ${o.chosen}`,
      `- **Confidence:** ${o.confidence}`,
      `- **Principle:** ${o.principle}`,
      `- **Outcome:** ${o.outcome}`,
    ];
    if (o.outcomeDetail) lines.push(`- **Detail:** ${o.outcomeDetail}`);
    if (o.relatedFilePath) lines.push(`- **File:** ${o.relatedFilePath}`);
    if (o.jobId) lines.push(`- **Job:** ${o.jobId}`);
    return lines.join("\n");
  }).join("\n\n");
}

function summarizeOutcomePatterns(outcomes: DecisionOutcome[]): string {
  const success = outcomes.filter((o) => o.outcome === "success").length;
  const failure = outcomes.filter((o) => o.outcome === "failure").length;
  const neutral = outcomes.filter((o) => o.outcome === "neutral").length;

  // Group failures by principle for pattern detection
  const failuresByPrinciple = new Map<string, number>();
  for (const o of outcomes.filter((o) => o.outcome === "failure")) {
    failuresByPrinciple.set(o.principle, (failuresByPrinciple.get(o.principle) ?? 0) + 1);
  }

  const lines = [
    `- Total: ${outcomes.length} decisions (${success} success, ${failure} failure, ${neutral} neutral)`,
  ];

  if (failuresByPrinciple.size > 0) {
    lines.push("- Failure patterns by principle:");
    for (const [principle, count] of failuresByPrinciple) {
      lines.push(`  - ${principle}: ${count} failures`);
    }
  }

  return lines.join("\n");
}

// ── Templates ───────────────────────────────────────────────────

const TASTE_TEMPLATE = `# Taste Profile

## Instructions
Add your preferences below. These guide the Oracle's autonomous decisions.
Each preference should be a clear, actionable statement.

## Preferences
<!-- Example entries:
- Prefer explicit code over clever abstractions
- Always clean up stale test artifacts
- Be cautious with database schema changes
- Prefer dark mode and minimal UI
- Use functional patterns over class-based where possible
-->
`;

const DOMAIN_TEMPLATE = `# Domain Expertise

## Instructions
Domain knowledge is added here by /research or manually.
Each section covers a topic relevant to this project.

<!-- Content will be auto-populated by garyclaw research <topic> -->
`;

const OUTCOMES_TEMPLATE = `# Decision Outcomes

## Recent Outcomes (0)
<!-- Decision outcomes will be tracked here after reflection -->
`;

export { TASTE_TEMPLATE, DOMAIN_TEMPLATE, OUTCOMES_TEMPLATE };
