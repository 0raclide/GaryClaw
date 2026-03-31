/**
 * Dashboard Server — HTTP server with SSE for the live evolution dashboard.
 *
 * Serves static web assets from `src/dashboard-web/`, REST endpoints for
 * dashboard data, and an SSE stream for real-time updates via fs.watch.
 *
 * All data is read-only from `.garyclaw/` files — the server never modifies
 * daemon state. Works with or without a running daemon (historical data mode).
 *
 * Zero external dependencies — uses only node:http, node:fs, node:path, node:child_process.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { join, extname, resolve, dirname } from "node:path";
import { existsSync, readFileSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { safeReadJSON, safeReadText, safeWriteJSON } from "./safe-json.js";
import { buildDashboard, readAllMergeAuditEntries } from "./dashboard.js";
import { readMetrics, defaultMemoryConfig, parseDecisionOutcomes } from "./oracle-memory.js";
import { readPipelineOutcomes } from "./pipeline-history.js";
import { readMergeReverts } from "./worktree.js";
import { slugify, readTodoState } from "./todo-state.js";
import { GARYCLAW_DAEMON_EMAIL } from "./sdk-wrapper.js";
import type {
  DashboardData,
  DaemonState,
  DaemonConfig,
  GlobalBudget,
  DecisionOutcome,
  PipelineOutcomeRecord,
} from "./types.js";
import type { TodoState } from "./todo-state.js";

// ── Types ────────────────────────────────────────────────────────

export interface DecisionEntry {
  id: string;
  timestamp: string;
  question: string;
  chosen: string;
  confidence: number;
  principle: string;
  outcome: "success" | "neutral" | "failure";
  jobId?: string;
}

export interface GrowthSnapshot {
  date: string;
  modules: number;
  tests: number;
  commits: number;
  humanCommits: number;
  daemonCommits: number;
}

export interface MutationCycle {
  todoTitle: string;
  todoSlug: string;
  startedAt: string;
  completedAt?: string;
  outcome: "shipped" | "in-progress" | "failed" | "not-started";
  skills: Array<{ name: string; status: "complete" | "failed" | "skipped" }>;
  commits: number;
  costUsd: number;
  oracleDecisions: number;
}

export interface DashboardServerOptions {
  projectDir: string;
  port?: number;
  /** Override for web assets directory (testing) */
  webAssetsDir?: string;
  /** Override for checkpoint dir (testing) */
  checkpointDir?: string;
}

export interface DashboardServerHandle {
  server: Server;
  port: number;
  close: () => void;
}

// ── Constants ────────────────────────────────────────────────────

export const DEFAULT_PORT = 3333;
export const MAX_PORT_ATTEMPTS = 10;
const DEBOUNCE_MS = 500;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// ── Decision Parsing ─────────────────────────────────────────────

/**
 * Convert DecisionOutcome (from oracle-memory.ts) to DecisionEntry (API format).
 */
export function toDecisionEntry(d: DecisionOutcome): DecisionEntry {
  return {
    id: d.decisionId,
    timestamp: d.timestamp,
    question: d.question.length > 200 ? d.question.slice(0, 200) + "..." : d.question,
    chosen: d.chosen,
    confidence: d.confidence,
    principle: d.principle,
    outcome: d.outcome,
    jobId: d.jobId,
  };
}

/**
 * Parse decision-outcomes.md into DecisionEntry[] for API response.
 * Reuses parseDecisionOutcomes from oracle-memory.ts, then maps to API format.
 */
export function parseDecisionEntries(content: string): DecisionEntry[] {
  const outcomes = parseDecisionOutcomes(content);
  return outcomes.map(toDecisionEntry);
}

// ── Mutation Timeline ────────────────────────────────────────────

/**
 * Build mutation timeline by correlating pipeline outcomes, todo state, and daemon jobs.
 *
 * Join key: todoTitle normalized via slugify() for fuzzy matching.
 * Groups all pipeline outcomes + jobs + todo-state for the same TODO slug.
 */
export function buildMutationTimeline(
  pipelineOutcomes: PipelineOutcomeRecord[],
  todoStates: Map<string, TodoState>,
  jobs: Array<{ skills: string[]; claimedTodoTitle?: string; status: string; costUsd: number; startedAt?: string; completedAt?: string }>,
): MutationCycle[] {
  // Index by slug
  const cycleMap = new Map<string, {
    todoTitle: string;
    todoSlug: string;
    startedAt: string;
    completedAt?: string;
    todoState?: TodoState;
    pipelineOutcomes: PipelineOutcomeRecord[];
    jobs: typeof jobs;
    skills: Set<string>;
    totalCost: number;
    oracleDecisions: number;
  }>();

  const getOrCreate = (title: string) => {
    const slug = slugify(title);
    if (!cycleMap.has(slug)) {
      cycleMap.set(slug, {
        todoTitle: title,
        todoSlug: slug,
        startedAt: "",
        pipelineOutcomes: [],
        jobs: [],
        skills: new Set(),
        totalCost: 0,
        oracleDecisions: 0,
      });
    }
    return cycleMap.get(slug)!;
  };

  // 1. Pipeline outcomes
  for (const po of pipelineOutcomes) {
    if (!po.todoTitle) continue;
    const cycle = getOrCreate(po.todoTitle);
    cycle.pipelineOutcomes.push(po);
    for (const s of po.skills) cycle.skills.add(s);
    for (const s of po.skippedSkills) cycle.skills.add(s);
    if (!cycle.startedAt || po.timestamp < cycle.startedAt) {
      cycle.startedAt = po.timestamp;
    }
  }

  // 2. Todo states
  for (const [slug, ts] of todoStates) {
    if (!cycleMap.has(slug)) {
      cycleMap.set(slug, {
        todoTitle: ts.title,
        todoSlug: slug,
        startedAt: ts.updatedAt,
        pipelineOutcomes: [],
        jobs: [],
        skills: new Set(),
        totalCost: 0,
        oracleDecisions: 0,
      });
    }
    cycleMap.get(slug)!.todoState = ts;
  }

  // 3. Jobs
  for (const job of jobs) {
    if (!job.claimedTodoTitle) continue;
    const cycle = getOrCreate(job.claimedTodoTitle);
    cycle.jobs.push(job);
    for (const s of job.skills) cycle.skills.add(s);
    cycle.totalCost += job.costUsd;
    if (job.startedAt && (!cycle.startedAt || job.startedAt < cycle.startedAt)) {
      cycle.startedAt = job.startedAt;
    }
    if (job.completedAt) {
      if (!cycle.completedAt || job.completedAt > cycle.completedAt) {
        cycle.completedAt = job.completedAt;
      }
    }
  }

  // Build MutationCycle[]
  const cycles: MutationCycle[] = [];
  for (const entry of cycleMap.values()) {
    // Determine outcome
    let outcome: MutationCycle["outcome"] = "not-started";
    const ts = entry.todoState;
    if (ts) {
      if (ts.state === "merged" || ts.state === "complete") {
        outcome = "shipped";
      } else if (["implementing", "implemented", "reviewed", "qa-complete", "pr-created", "designed"].includes(ts.state)) {
        outcome = "in-progress";
      }
    }
    // Check job statuses for failure
    const hasFailedJob = entry.jobs.some(j => j.status === "failed");
    const hasPipelineFailure = entry.pipelineOutcomes.some(po => po.outcome === "failure");
    if ((hasFailedJob || hasPipelineFailure) && outcome !== "shipped") {
      outcome = "failed";
    }
    // If we have jobs/pipeline outcomes but no todo state failure, it's in-progress
    if (outcome === "not-started" && (entry.jobs.length > 0 || entry.pipelineOutcomes.length > 0)) {
      outcome = "in-progress";
    }

    // Build skills list
    const skillStatuses: MutationCycle["skills"] = [];
    for (const skillName of entry.skills) {
      const poWithSkill = entry.pipelineOutcomes.find(po => po.skills.includes(skillName));
      const skipped = entry.pipelineOutcomes.some(po => po.skippedSkills.includes(skillName));
      if (skipped) {
        skillStatuses.push({ name: skillName, status: "skipped" });
      } else if (poWithSkill && poWithSkill.outcome === "failure") {
        skillStatuses.push({ name: skillName, status: "failed" });
      } else {
        skillStatuses.push({ name: skillName, status: "complete" });
      }
    }

    // Count commits from pipeline outcomes
    const commits = entry.pipelineOutcomes.reduce((sum, po) => {
      // Pipeline outcomes don't track commit count directly, so estimate from jobs
      return sum;
    }, 0);

    cycles.push({
      todoTitle: entry.todoTitle,
      todoSlug: entry.todoSlug,
      startedAt: entry.startedAt || new Date().toISOString(),
      completedAt: entry.completedAt,
      outcome,
      skills: skillStatuses,
      commits,
      costUsd: entry.totalCost,
      oracleDecisions: entry.oracleDecisions,
    });
  }

  // Sort by startedAt descending
  cycles.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return cycles;
}

// ── Data Loading ─────────────────────────────────────────────────

/**
 * Load all todo state files from .garyclaw/todo-state/ directory.
 */
export function loadAllTodoStates(checkpointDir: string): Map<string, TodoState> {
  const states = new Map<string, TodoState>();
  const stateDir = join(checkpointDir, "todo-state");
  if (!existsSync(stateDir)) return states;

  try {
    const files = readdirSync(stateDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const slug = file.replace(/\.json$/, "");
      const state = readTodoState(checkpointDir, slug);
      if (state) states.set(slug, state);
    }
  } catch {
    // Best-effort
  }
  return states;
}

function defaultDaemonState(): DaemonState {
  return {
    version: 1,
    jobs: [],
    dailyCost: { date: new Date().toISOString().slice(0, 10), totalUsd: 0, jobCount: 0 },
  };
}

function defaultGlobalBudget(): GlobalBudget {
  return {
    date: new Date().toISOString().slice(0, 10),
    totalUsd: 0,
    jobCount: 0,
    byInstance: {},
  };
}

function defaultDaemonConfig(projectDir: string): DaemonConfig {
  return {
    version: 1,
    projectDir,
    triggers: [],
    budget: {
      dailyCostLimitUsd: 1000,
      perJobCostLimitUsd: 10,
      maxJobsPerDay: 100,
    },
    notifications: {
      enabled: false,
      onComplete: false,
      onError: false,
      onEscalation: false,
    },
    orchestrator: {
      maxTurnsPerSegment: 15,
      relayThresholdRatio: 0.85,
      maxRelaySessions: 10,
      askTimeoutMs: 30000,
    },
    logging: {
      level: "info",
      retainDays: 7,
    },
  };
}

/**
 * Load full DashboardData from .garyclaw/ files.
 * Fail-open: returns valid defaults if any file is missing.
 */
export function loadDashboardData(projectDir: string, checkpointDir: string): DashboardData {
  // Read daemon state — try default instance first, then scan daemons/
  const state = safeReadJSON<DaemonState>(
    join(checkpointDir, "daemon-state.json"),
    (d): d is DaemonState =>
      typeof d === "object" && d !== null && (d as DaemonState).version === 1 && Array.isArray((d as DaemonState).jobs),
  ) ?? defaultDaemonState();

  // Also aggregate jobs from named instances
  const daemonsDir = join(checkpointDir, "daemons");
  if (existsSync(daemonsDir)) {
    try {
      const dirs = readdirSync(daemonsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const name of dirs) {
        const instanceState = safeReadJSON<DaemonState>(
          join(daemonsDir, name, "daemon-state.json"),
          (d): d is DaemonState =>
            typeof d === "object" && d !== null && (d as DaemonState).version === 1 && Array.isArray((d as DaemonState).jobs),
        );
        if (instanceState) {
          state.jobs.push(...instanceState.jobs);
        }
      }
    } catch {
      // Best-effort
    }
  }

  const memConfig = defaultMemoryConfig(projectDir);
  const metrics = readMetrics(memConfig);
  const globalBudget = safeReadJSON<GlobalBudget>(join(checkpointDir, "global-budget.json")) ?? defaultGlobalBudget();
  const config = defaultDaemonConfig(projectDir);
  const mergeAuditEntries = readAllMergeAuditEntries(checkpointDir);
  const outcomesPath = join(checkpointDir, "pipeline-outcomes.jsonl");
  const pipelineOutcomes = readPipelineOutcomes(outcomesPath);
  const mergeRevertEntries = readMergeReverts(projectDir);

  return buildDashboard(state, metrics, globalBudget, config, undefined, mergeAuditEntries, pipelineOutcomes, mergeRevertEntries);
}

/** Max characters for taste/expertise content in API response. */
export const ORACLE_MIND_CONTENT_CAP = 10_000;

/**
 * Load taste profile and domain expertise content for the Mind tab.
 * Taste: prefer global (user-wide style) over project-specific.
 * Expertise: prefer project (domain-specific) over global.
 * Fail-open: missing files return empty strings.
 */
export function loadOracleMindContent(projectDir: string): { tasteProfile: string; domainExpertise: string } {
  const memConfig = defaultMemoryConfig(projectDir);

  // Taste: prefer global (user-wide preferences) over project-specific
  const tasteProfile = (
    safeReadText(join(memConfig.globalDir, "taste.md"))
    ?? safeReadText(join(memConfig.projectDir, "taste.md"))
    ?? ""
  ).slice(0, ORACLE_MIND_CONTENT_CAP);

  // Expertise: prefer project (domain knowledge specific to this codebase) over global
  const domainExpertise = (
    safeReadText(join(memConfig.projectDir, "domain-expertise.md"))
    ?? safeReadText(join(memConfig.globalDir, "domain-expertise.md"))
    ?? ""
  ).slice(0, ORACLE_MIND_CONTENT_CAP);

  return { tasteProfile, domainExpertise };
}

/**
 * Load paginated oracle decisions from decision-outcomes.md.
 */
export function loadDecisions(
  projectDir: string,
  limit: number = 50,
  offset: number = 0,
): { decisions: DecisionEntry[]; total: number; offset: number; limit: number } {
  const memConfig = defaultMemoryConfig(projectDir);
  const outcomesPath = join(memConfig.projectDir, "decision-outcomes.md");
  const content = safeReadText(outcomesPath);
  if (!content) {
    return { decisions: [], total: 0, offset, limit };
  }

  const all = parseDecisionEntries(content);
  // Most recent first
  all.reverse();
  const total = all.length;
  const decisions = all.slice(offset, offset + limit);

  return { decisions, total, offset, limit };
}

/**
 * Load mutation timeline data.
 */
export function loadMutations(
  projectDir: string,
  checkpointDir: string,
  limit: number = 20,
): { cycles: MutationCycle[]; total: number } {
  const outcomesPath = join(checkpointDir, "pipeline-outcomes.jsonl");
  const pipelineOutcomes = readPipelineOutcomes(outcomesPath);
  const todoStates = loadAllTodoStates(checkpointDir);

  // Load jobs from all instances
  const jobs: Array<{ skills: string[]; claimedTodoTitle?: string; status: string; costUsd: number; startedAt?: string; completedAt?: string }> = [];
  const state = safeReadJSON<DaemonState>(join(checkpointDir, "daemon-state.json")) as DaemonState | null;
  if (state?.jobs) {
    jobs.push(...state.jobs);
  }
  const daemonsDir = join(checkpointDir, "daemons");
  if (existsSync(daemonsDir)) {
    try {
      const dirs = readdirSync(daemonsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const name of dirs) {
        const instanceState = safeReadJSON<DaemonState>(join(daemonsDir, name, "daemon-state.json")) as DaemonState | null;
        if (instanceState?.jobs) {
          jobs.push(...instanceState.jobs);
        }
      }
    } catch {
      // Best-effort
    }
  }

  const allCycles = buildMutationTimeline(pipelineOutcomes, todoStates, jobs);
  return { cycles: allCycles.slice(0, limit), total: allCycles.length };
}

// ── Static File Serving ──────────────────────────────────────────

/**
 * Resolve the default web assets directory.
 */
export function defaultWebAssetsDir(): string {
  return join(__dirname, "dashboard-web");
}

/**
 * Serve a static file from the web assets directory.
 * Returns true if the file was served, false if not found.
 */
export function serveStaticFile(
  webAssetsDir: string,
  urlPath: string,
  res: ServerResponse,
): boolean {
  // Normalize path — prevent directory traversal
  const safePath = urlPath.replace(/\.\./g, "").replace(/\/+/g, "/");
  const filePath = safePath === "/" || safePath === ""
    ? join(webAssetsDir, "index.html")
    : join(webAssetsDir, safePath.startsWith("/") ? safePath.slice(1) : safePath);

  // Ensure resolved path stays within webAssetsDir
  const resolved = resolve(filePath);
  if (!resolved.startsWith(resolve(webAssetsDir))) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  if (!existsSync(resolved)) {
    return false;
  }

  const ext = extname(resolved);
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

  try {
    const content = readFileSync(resolved);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
    return true;
  } catch {
    res.writeHead(500);
    res.end("Internal Server Error");
    return true;
  }
}

// ── SSE ──────────────────────────────────────────────────────────

/** Map of watched filenames to SSE event types. */
export const FILE_EVENT_MAP: Record<string, string> = {
  "daemon-state.json": "job_update",
  "global-budget.json": "budget",
  "decision-outcomes.md": "decision",
  "metrics.json": "decision",
  "taste.md": "taste_update",
  "domain-expertise.md": "expertise_update",
  "priority.md": "job_update",
  "pipeline-outcomes.jsonl": "mutation",
};

/**
 * Map a changed filename (from fs.watch) to an SSE event type.
 * Returns null for files we don't care about.
 */
export function mapFileToEventType(filename: string): string | null {
  // filename could be a path like "oracle-memory/decision-outcomes.md"
  // or "todo-state/some-slug.json"
  const base = filename.replace(/\\/g, "/");
  const parts = base.split("/");
  const leaf = parts[parts.length - 1];

  // Direct match on leaf filename
  if (FILE_EVENT_MAP[leaf]) return FILE_EVENT_MAP[leaf];

  // todo-state/*.json → mutation
  if (parts.some(p => p === "todo-state") && leaf.endsWith(".json")) return "mutation";

  return null;
}

export type SSEClient = ServerResponse;

/**
 * Send an SSE event to a single client.
 */
export function sendSSEEvent(client: SSEClient, eventType: string, data: unknown): void {
  try {
    client.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Client may have disconnected
  }
}

/**
 * Broadcast an SSE event to all connected clients.
 */
export function broadcastSSE(clients: Set<SSEClient>, eventType: string, data: unknown): void {
  for (const client of clients) {
    sendSSEEvent(client, eventType, data);
  }
}

// ── HTTP Request Handler ─────────────────────────────────────────

export interface RequestHandlerDeps {
  projectDir: string;
  checkpointDir: string;
  webAssetsDir: string;
  sseClients: Set<SSEClient>;
  loadDashboardDataFn?: typeof loadDashboardData;
  loadDecisionsFn?: typeof loadDecisions;
  loadMutationsFn?: typeof loadMutations;
  loadGrowthDataFn?: () => { snapshots: GrowthSnapshot[]; moduleAttribution: Record<string, string> };
}

/**
 * Create the HTTP request handler.
 */
export function createRequestHandler(deps: RequestHandlerDeps) {
  const {
    projectDir,
    checkpointDir,
    webAssetsDir,
    sseClients,
    loadDashboardDataFn = loadDashboardData,
    loadDecisionsFn = loadDecisions,
    loadMutationsFn = loadMutations,
    loadGrowthDataFn,
  } = deps;

  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // ── REST API ──
    if (pathname === "/api/state") {
      try {
        const data = loadDashboardDataFn(projectDir, checkpointDir);
        const mindContent = loadOracleMindContent(projectDir);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...data, ...mindContent }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to load dashboard data" }));
      }
      return;
    }

    if (pathname === "/api/decisions") {
      try {
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);
        const data = loadDecisionsFn(projectDir, Math.min(limit, 200), Math.max(offset, 0));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to load decisions" }));
      }
      return;
    }

    if (pathname === "/api/growth") {
      try {
        const data = loadGrowthDataFn
          ? loadGrowthDataFn()
          : { snapshots: [], moduleAttribution: {} };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ snapshots: [], moduleAttribution: {} }));
      }
      return;
    }

    if (pathname === "/api/mutations") {
      try {
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);
        const data = loadMutationsFn(projectDir, checkpointDir, Math.min(limit, 100));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to load mutations" }));
      }
      return;
    }

    if (pathname === "/api/events") {
      // SSE endpoint
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      // Send init event with current state
      try {
        const data = loadDashboardDataFn(projectDir, checkpointDir);
        sendSSEEvent(res, "init", data);
      } catch {
        sendSSEEvent(res, "init", {});
      }

      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    // ── Static files ──
    if (pathname.startsWith("/assets/")) {
      const served = serveStaticFile(webAssetsDir, pathname.slice(1), res);
      if (!served) {
        res.writeHead(404);
        res.end("Not Found");
      }
      return;
    }

    // Root or index
    if (pathname === "/" || pathname === "/index.html") {
      const served = serveStaticFile(webAssetsDir, "/", res);
      if (!served) {
        res.writeHead(404);
        res.end("Dashboard web assets not found");
      }
      return;
    }

    // Try serving any other path as static file
    const served = serveStaticFile(webAssetsDir, pathname, res);
    if (!served) {
      res.writeHead(404);
      res.end("Not Found");
    }
  };
}

// ── File Watcher ─────────────────────────────────────────────────

export interface FileWatcherHandle {
  watcher: FSWatcher;
  close: () => void;
}

/**
 * Create a debounced file watcher on .garyclaw/ that broadcasts SSE events.
 */
export function createFileWatcher(
  checkpointDir: string,
  projectDir: string,
  sseClients: Set<SSEClient>,
  loadDashboardDataFn: typeof loadDashboardData = loadDashboardData,
): FileWatcherHandle | null {
  if (!existsSync(checkpointDir)) return null;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const changedFiles = new Set<string>();

  const watcher = watch(checkpointDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;

    const eventType = mapFileToEventType(filename);
    if (!eventType) return; // Ignore files we don't track

    changedFiles.add(filename);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // Process batched changes
      const filesToProcess = new Set(changedFiles);
      changedFiles.clear();

      const eventTypes = new Set<string>();
      for (const f of filesToProcess) {
        const et = mapFileToEventType(f);
        if (et) eventTypes.add(et);
      }

      // For each unique event type, load fresh data and broadcast
      for (const et of eventTypes) {
        try {
          if (et === "job_update" || et === "budget") {
            const data = loadDashboardDataFn(projectDir, checkpointDir);
            broadcastSSE(sseClients, et, {
              healthScore: data.healthScore,
              jobs: data.jobs,
              budget: data.budget,
            });
          } else if (et === "decision") {
            const memConfig = defaultMemoryConfig(projectDir);
            const content = safeReadText(join(memConfig.projectDir, "decision-outcomes.md"));
            if (content) {
              const entries = parseDecisionEntries(content);
              const latest = entries.length > 0 ? entries[entries.length - 1] : null;
              if (latest) broadcastSSE(sseClients, et, latest);
            }
          } else if (et === "mutation") {
            // Reload mutations
            const outcomesPath = join(checkpointDir, "pipeline-outcomes.jsonl");
            const outcomes = readPipelineOutcomes(outcomesPath);
            if (outcomes.length > 0) {
              const latest = outcomes[outcomes.length - 1];
              broadcastSSE(sseClients, et, {
                todoTitle: latest.todoTitle,
                outcome: latest.outcome,
                skills: latest.skills,
              });
            }
          } else {
            // taste_update, expertise_update — send simple notification
            broadcastSSE(sseClients, et, { updated: true });
          }
        } catch {
          // Best-effort — don't crash the watcher
        }
      }
    }, DEBOUNCE_MS);
  });

  return {
    watcher,
    close: () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
    },
  };
}

// ── Growth Data Extraction ────────────────────────────────────────

export interface GrowthCache {
  headSha: string;
  builtAt: string;
  snapshots: GrowthSnapshot[];
  moduleAttribution: Record<string, string>;
}

/** Max commits to process when building growth cache from scratch. */
export const MAX_GROWTH_COMMITS = 200;

/** Timeout per git command in milliseconds. */
export const GIT_COMMAND_TIMEOUT_MS = 5000;

/**
 * Run a git command and return stdout. Returns null on error or timeout.
 */
export function gitExec(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: GIT_COMMAND_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Extract module count and test count from CLAUDE.md content.
 * Returns null if neither can be parsed.
 */
export function extractCounts(content: string): { modules: number; tests: number } | null {
  // Primary: "43 source modules, 216 test files, 3501 tests"
  const combined = content.match(/(\d+)\s+source\s+modules.*?(\d+)\s+tests/s);
  if (combined) {
    return { modules: parseInt(combined[1], 10), tests: parseInt(combined[2], 10) };
  }

  // Fallback: separate patterns
  const modMatch = content.match(/(\d+)\s+source\s+modules/);
  const testMatch = content.match(/(\d+)\s+tests/);
  if (modMatch || testMatch) {
    return {
      modules: modMatch ? parseInt(modMatch[1], 10) : 0,
      tests: testMatch ? parseInt(testMatch[1], 10) : 0,
    };
  }

  return null;
}

/**
 * Get the current HEAD SHA.
 */
export function getHeadSha(projectDir: string): string | null {
  return gitExec(["rev-parse", "HEAD"], projectDir);
}

/**
 * Build growth snapshots from git history of CLAUDE.md.
 * Returns per-commit snapshots with module/test counts and commit authorship.
 */
export function buildGrowthSnapshots(projectDir: string): GrowthSnapshot[] {
  // Get commits that touched CLAUDE.md, capped at MAX_GROWTH_COMMITS
  const logOutput = gitExec(
    ["log", `--max-count=${MAX_GROWTH_COMMITS}`, "--format=%H %aI %ae", "--", "CLAUDE.md"],
    projectDir,
  );
  if (!logOutput) return [];

  const lines = logOutput.split("\n").filter(Boolean);
  const snapshots: GrowthSnapshot[] = [];

  // Track cumulative commit counts
  const commitCountOutput = gitExec(
    ["log", "--format=%aI %ae", "--reverse"],
    projectDir,
  );
  const commitsByDate = new Map<string, { total: number; human: number; daemon: number }>();
  if (commitCountOutput) {
    let total = 0;
    let human = 0;
    let daemon = 0;
    for (const line of commitCountOutput.split("\n").filter(Boolean)) {
      const parts = line.split(" ");
      const date = parts[0]?.slice(0, 10) ?? "";
      const email = parts[1] ?? "";
      total++;
      if (email === GARYCLAW_DAEMON_EMAIL) daemon++;
      else human++;
      if (date) {
        commitsByDate.set(date, { total, human, daemon });
      }
    }
  }

  for (const line of lines) {
    const parts = line.split(" ");
    const sha = parts[0];
    const dateStr = parts[1]?.slice(0, 10) ?? "";
    if (!sha || !dateStr) continue;

    // Get CLAUDE.md content at this commit
    const content = gitExec(["show", `${sha}:CLAUDE.md`], projectDir);
    if (!content) continue;

    const counts = extractCounts(content);
    if (!counts) continue;

    const commitInfo = commitsByDate.get(dateStr) ?? { total: 0, human: 0, daemon: 0 };

    snapshots.push({
      date: dateStr,
      modules: counts.modules,
      tests: counts.tests,
      commits: commitInfo.total,
      humanCommits: commitInfo.human,
      daemonCommits: commitInfo.daemon,
    });
  }

  // Reverse to chronological order (git log gives newest first)
  snapshots.reverse();

  // Deduplicate by date (keep last entry per date — most recent CLAUDE.md update)
  const byDate = new Map<string, GrowthSnapshot>();
  for (const s of snapshots) {
    byDate.set(s.date, s);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Build module attribution: for each source module, who created it (human or daemon).
 */
export function buildModuleAttribution(projectDir: string): Record<string, string> {
  const attribution: Record<string, string> = {};

  // Get list of current source modules
  const lsOutput = gitExec(["ls-files", "src/*.ts"], projectDir);
  if (!lsOutput) return attribution;

  const modules = lsOutput.split("\n").filter(f => f.endsWith(".ts") && !f.includes("/spikes/"));

  for (const mod of modules) {
    // Find the creating commit's author email
    const email = gitExec(
      ["log", "--format=%ae", "--diff-filter=A", "--", mod],
      projectDir,
    );
    if (!email) continue;
    // Take the last line (oldest commit = the one that added the file)
    const lines = email.split("\n").filter(Boolean);
    const creatorEmail = lines[lines.length - 1];
    attribution[mod.replace(/^src\//, "").replace(/\.ts$/, "")] =
      creatorEmail === GARYCLAW_DAEMON_EMAIL ? "daemon" : "human";
  }

  return attribution;
}

/**
 * Load or build growth cache. Incremental update if HEAD has moved.
 */
export function loadOrBuildGrowthCache(
  projectDir: string,
  checkpointDir: string,
): { snapshots: GrowthSnapshot[]; moduleAttribution: Record<string, string> } {
  const cachePath = join(checkpointDir, "growth-cache.json");
  const currentHead = getHeadSha(projectDir);

  // Try to load existing cache
  const cached = safeReadJSON<GrowthCache>(cachePath);
  if (cached && cached.headSha === currentHead && cached.snapshots?.length > 0) {
    return { snapshots: cached.snapshots, moduleAttribution: cached.moduleAttribution ?? {} };
  }

  // Build fresh or incremental
  const snapshots = buildGrowthSnapshots(projectDir);
  const moduleAttribution = buildModuleAttribution(projectDir);

  // Save cache
  if (currentHead) {
    const cache: GrowthCache = {
      headSha: currentHead,
      builtAt: new Date().toISOString(),
      snapshots,
      moduleAttribution,
    };
    try {
      safeWriteJSON(cachePath, cache);
    } catch {
      // Best-effort caching
    }
  }

  return { snapshots, moduleAttribution };
}

// ── Server Startup ───────────────────────────────────────────────

/**
 * Start the dashboard HTTP server.
 *
 * Tries ports from `port` to `port + MAX_PORT_ATTEMPTS - 1`.
 * Returns a handle with the bound port and close function.
 */
export function startDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServerHandle> {
  const {
    projectDir,
    port: startPort = DEFAULT_PORT,
    webAssetsDir = defaultWebAssetsDir(),
    checkpointDir = join(projectDir, ".garyclaw"),
  } = options;

  const sseClients = new Set<SSEClient>();

  const handler = createRequestHandler({
    projectDir,
    checkpointDir,
    webAssetsDir,
    sseClients,
    loadGrowthDataFn: () => loadOrBuildGrowthCache(projectDir, checkpointDir),
  });

  const server = createServer(handler);

  // Set up file watcher
  const watcherHandle = createFileWatcher(checkpointDir, projectDir, sseClients);

  return new Promise<DashboardServerHandle>((resolve, reject) => {
    let attempts = 0;
    let currentPort = startPort;

    const tryListen = () => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempts < MAX_PORT_ATTEMPTS - 1) {
          attempts++;
          currentPort++;
          tryListen();
        } else {
          reject(err);
        }
      });

      server.listen(currentPort, "127.0.0.1", () => {
        const addr = server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : currentPort;
        resolve({
          server,
          port: boundPort,
          close: () => {
            // End all SSE connections
            for (const client of sseClients) {
              try { client.end(); } catch { /* ignore */ }
            }
            sseClients.clear();
            // Close file watcher
            if (watcherHandle) watcherHandle.close();
            // Close server
            server.close();
          },
        });
      });
    };

    tryListen();
  });
}
