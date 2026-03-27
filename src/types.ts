/**
 * GaryClaw shared types — zero imports.
 * Every other module imports from here.
 */

// ── Errors ──────────────────────────────────────────────────────

export class PerJobCostExceededError extends Error {
  constructor(cost: number, limit: number) {
    super(`Per-job cost limit exceeded: $${cost.toFixed(3)} > $${limit.toFixed(3)}`);
    this.name = "PerJobCostExceededError";
  }
}

// ── Issue tracking ──────────────────────────────────────────────

export type IssueSeverity = "critical" | "high" | "medium" | "low" | "cosmetic";
export type IssueStatus = "open" | "fixed" | "skipped" | "deferred";

export interface Issue {
  id: string;
  severity: IssueSeverity;
  description: string;
  filePath?: string;
  screenshotPath?: string;
  status: IssueStatus;
  fixCommit?: string;
}

export interface Finding {
  description: string;
  category: string;
  actionTaken?: string;
}

export interface Decision {
  timestamp: string;
  sessionIndex: number;
  question: string;
  options: { label: string; description: string }[];
  chosen: string;
  confidence: number;
  rationale: string;
  principle: string;
}

// ── Checkpoint (persisted to disk) ──────────────────────────────

export interface ImplementProgress {
  completedSteps: number[];                // 1-indexed step numbers that are done
  currentStep: number;                     // next step to work on (1-indexed). All done: totalSteps + 1
  totalSteps: number;                      // total steps in design doc
  stepCommits: Record<number, string>;     // step number → commit SHA
  designDocPath: string;                   // path to design doc (for relay prompt context)
}

export interface Checkpoint {
  version: 1;
  timestamp: string;
  runId: string;
  skillName: string;
  issues: Issue[];
  findings: Finding[];
  decisions: Decision[];
  gitBranch: string;
  gitHead: string;
  tokenUsage: TokenUsageSnapshot;
  screenshotPaths: string[];
  implementProgress?: ImplementProgress;
}

// ── Token tracking ──────────────────────────────────────────────

export interface TurnUsageRecord {
  turn: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  computedContextSize: number;
}

export interface TokenUsageSnapshot {
  lastContextSize: number;
  contextWindow: number;
  totalOutputTokens: number;
  sessionCount: number;
  estimatedCostUsd: number;
  turnHistory: TurnUsageRecord[];
}

export interface TokenMonitorState {
  contextWindow: number | null;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  turnHistory: TurnUsageRecord[];
  turnCounter: number;
}

export interface RelayDecision {
  relay: boolean;
  reason: string;
  contextSize: number;
  contextWindow: number;
}

// ── Configuration ───────────────────────────────────────────────

export interface GaryClawConfig {
  skillName: string;
  projectDir: string;
  maxTurnsPerSegment: number;
  relayThresholdRatio: number;
  checkpointDir: string;
  settingSources: string[];
  env: Record<string, string>;
  askTimeoutMs: number;
  maxRelaySessions: number;
  autonomous: boolean;
  abortSignal?: AbortSignal;
  designDoc?: string;
  noMemory?: boolean;
  /** Main repo dir for oracle memory when projectDir points to a worktree. */
  mainRepoDir?: string;
}

// ── Orchestrator events (discriminated union) ───────────────────

export type OrchestratorEvent =
  | { type: "segment_start"; sessionIndex: number; segmentIndex: number }
  | { type: "segment_end"; sessionIndex: number; segmentIndex: number; numTurns: number }
  | { type: "turn_usage"; sessionIndex: number; turn: number; contextSize: number; contextWindow: number | null }
  | { type: "relay_triggered"; sessionIndex: number; reason: string; contextSize: number }
  | { type: "relay_complete"; newSessionIndex: number }
  | { type: "ask_user"; question: string; options: { label: string; description: string }[] }
  | { type: "skill_complete"; totalSessions: number; totalTurns: number; costUsd: number }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "checkpoint_saved"; path: string }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; toolName: string; inputSummary: string }
  | { type: "tool_result"; toolName: string }
  | { type: "cost_update"; costUsd: number; sessionIndex: number }
  | { type: "issue_extracted"; issue: Issue }
  | { type: "pipeline_skill_start"; skillName: string; skillIndex: number; totalSkills: number }
  | { type: "pipeline_skill_complete"; skillName: string; skillIndex: number; totalSkills: number; costUsd: number }
  | { type: "pipeline_complete"; totalSkills: number; totalCostUsd: number };

export interface OrchestratorCallbacks {
  onEvent: (event: OrchestratorEvent) => void;
  onAskUser: (question: string, options: { label: string; description: string }[], multiSelect: boolean) => Promise<string>;
}

// ── Report (merged across sessions) ─────────────────────────────

export interface RelayPoint {
  sessionIndex: number;
  timestamp: string;
  reason: string;
  contextSize: number;
}

export interface RunReport {
  runId: string;
  skillName: string;
  startTime: string;
  endTime: string;
  totalSessions: number;
  totalTurns: number;
  estimatedCostUsd: number;
  issues: Issue[];
  findings: Finding[];
  decisions: Decision[];
  relayPoints: RelayPoint[];
}

// ── Pipeline (multi-skill chaining) ─────────────────────────────

export type PipelineSkillStatus = "pending" | "running" | "complete" | "failed";

export interface PipelineSkillEntry {
  skillName: string;
  status: PipelineSkillStatus;
  startTime?: string;
  endTime?: string;
  report?: RunReport;
}

export interface PipelineState {
  version: 1;
  pipelineId: string;
  skills: PipelineSkillEntry[];
  currentSkillIndex: number;
  startTime: string;
  totalCostUsd: number;
  autonomous: boolean;
}

export interface PipelineReport {
  pipelineId: string;
  startTime: string;
  endTime: string;
  skills: PipelineSkillEntry[];
  totalSessions: number;
  totalTurns: number;
  totalCostUsd: number;
  issues: Issue[];
  findings: Finding[];
  decisions: Decision[];
}

// ── Daemon mode ─────────────────────────────────────────────────

export interface DaemonConfig {
  version: 1;
  name?: string;
  projectDir: string;
  worktreePath?: string;    // Absolute path to git worktree (named instances only)
  triggers: TriggerConfig[];
  budget: BudgetConfig;
  notifications: {
    enabled: boolean;
    onComplete: boolean;
    onError: boolean;
    onEscalation: boolean;
  };
  orchestrator: {
    maxTurnsPerSegment: number;
    relayThresholdRatio: number;
    maxRelaySessions: number;
    askTimeoutMs: number;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    retainDays: number;
  };
  autoResearch?: AutoResearchConfig;
}

export type TriggerConfig = GitPollTrigger | CronTrigger;

export interface GitPollTrigger {
  type: "git_poll";
  intervalSeconds: number;
  skills: string[];
  branch?: string;
  debounceSeconds?: number;
}

export interface CronTrigger {
  type: "cron";
  expression: string;     // standard 5-field cron: "0 2 * * *" = 2am daily
  skills: string[];
  designDoc?: string;     // optional design doc for implement skill
}

export interface BudgetConfig {
  dailyCostLimitUsd: number;
  perJobCostLimitUsd: number;
  maxJobsPerDay: number;
}

export type JobStatus = "queued" | "running" | "complete" | "failed" | "cancelled";

export interface Job {
  id: string;
  triggeredBy: "git_poll" | "cron" | "manual" | "auto_research";
  triggerDetail: string;
  skills: string[];
  projectDir: string;
  status: JobStatus;
  enqueuedAt: string;
  startedAt?: string;
  completedAt?: string;
  costUsd: number;
  error?: string;
  reportPath?: string;
  designDoc?: string;
  researchTopic?: string;  // topic string for auto-research jobs
  failureCategory?: FailureCategory;
  retryable?: boolean;
}

export interface DaemonState {
  version: 1;
  jobs: Job[];
  dailyCost: { date: string; totalUsd: number; jobCount: number };
}

// ── IPC protocol ────────────────────────────────────────────────

export type IPCRequest =
  | { type: "status" }
  | { type: "trigger"; skills: string[]; designDoc?: string }
  | { type: "queue" }
  | { type: "instances" };

export interface IPCResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

// ── Parallel daemon instances ────────────────────────────────────

export interface GlobalBudget {
  date: string;
  totalUsd: number;
  jobCount: number;
  byInstance: Record<string, { totalUsd: number; jobCount: number }>;
}

export interface InstanceInfo {
  name: string;
  pid: number;
  alive: boolean;
  socketPath: string;
  instanceDir: string;
}

// ── Oracle memory ────────────────────────────────────────────────

export interface OracleMemoryConfig {
  globalDir: string;    // ~/.garyclaw/oracle-memory/
  projectDir: string;   // .garyclaw/oracle-memory/
  disableMemory?: boolean;  // --no-memory flag
}

export interface OracleMemoryFiles {
  taste: string | null;             // taste.md content
  domainExpertise: string | null;   // domain-expertise.md content
  decisionOutcomes: string | null;  // decision-outcomes.md content (project only)
  memoryMd: string | null;          // MEMORY.md content
}

export interface OracleMetrics {
  totalDecisions: number;
  accurateDecisions: number;      // fixed = success
  neutralDecisions: number;       // skipped/deferred
  failedDecisions: number;        // reopened = failure
  accuracyPercent: number;        // accurateDecisions / (accurate + failed) * 100
  confidenceTrend: number[];      // last 20 confidence scores
  lastReflectionTimestamp: string | null;
  circuitBreakerTripped: boolean; // accuracy < 60% → memory disabled
}

export interface DecisionOutcome {
  decisionId: string;             // timestamp-based ID
  timestamp: string;
  question: string;
  chosen: string;
  confidence: number;
  principle: string;
  outcome: "success" | "neutral" | "failure";
  outcomeDetail?: string;
  relatedFilePath?: string;
  jobId?: string;
}

/** Token budget hard caps for oracle memory files (in estimated tokens) */
export const ORACLE_MEMORY_BUDGETS = {
  taste: 4_000,
  domainExpertise: 20_000,
  decisionOutcomes: 12_000,
  memoryMd: 6_000,
} as const;

// ── Failure Taxonomy ─────────────────────────────────────────────

export type FailureCategory =
  | "garyclaw-bug"    // Bug in GaryClaw harness code
  | "skill-bug"       // Skill (gstack skill) misbehavior
  | "project-bug"     // Target project issue (test failures, lint errors)
  | "sdk-bug"         // Agent SDK issue (crashes, protocol errors)
  | "auth-issue"      // Authentication/token expiry
  | "infra-issue"     // Disk, network, OOM, timeout
  | "budget-exceeded" // Per-job or daily cost limit hit
  | "unknown";        // Unclassifiable — conservative fallback

export interface FailureRecord {
  timestamp: string;
  jobId: string;
  skills: string[];
  category: FailureCategory;
  retryable: boolean;
  errorMessage: string;
  errorName?: string;       // err.name (e.g., "PerJobCostExceededError")
  stackTrace?: string;      // First 5 lines of stack trace
  instanceName?: string;    // Daemon instance that ran this job
  suggestion?: string;      // Human-readable next step
}

// ── Auto-research trigger ────────────────────────────────────────

export interface AutoResearchConfig {
  enabled: boolean;
  lowConfidenceThreshold: number;  // default: 6
  minDecisionsToTrigger: number;   // default: 3
  maxTopicsPerJob: number;         // default: 2 (cap to prevent budget drain)
}

// ── Domain research ─────────────────────────────────────────────

export interface DomainSection {
  topic: string;
  lastResearched: string;
  searchCount: number;
  partial: boolean;
  content: string;
}

// ── Dashboard ───────────────────────────────────────────────────

export interface DashboardData {
  generatedAt: string;
  healthScore: number;           // 0-100
  topConcern: string | null;     // Most actionable insight, null if healthy
  jobs: {
    total: number;
    complete: number;
    failed: number;
    queued: number;
    running: number;
    successRate: number;         // 0-100
    totalCostUsd: number;
    avgCostPerJob: number;
    avgDurationSec: number;
    failureBreakdown: Record<string, number>;  // FailureCategory → count
  };
  oracle: {
    totalDecisions: number;
    accuracyPercent: number;
    confidenceAvg: number;       // avg of last 20
    circuitBreakerTripped: boolean;
  };
  budget: {
    dailyLimitUsd: number;
    dailySpentUsd: number;
    dailyRemaining: number;
    jobCount: number;
    maxJobsPerDay: number;
    byInstance: Record<string, { totalUsd: number; jobCount: number }>;
  };
  instances: string[];           // Active instance names
}

// ── SDK message types (loosely typed for pre-1.0 safety) ────────

export interface SdkUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface SdkModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  costUSD?: number;
}

export interface SegmentOptions {
  prompt: string;
  maxTurns: number;
  cwd: string;
  env: Record<string, string>;
  settingSources: string[];
  resume?: string;
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<CanUseToolResult>;
}

export interface CanUseToolResult {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export interface SegmentResult {
  sessionId: string;
  subtype: string;
  resultText: string;
  usage: SdkUsage | null;
  modelUsage: Record<string, SdkModelUsageEntry> | null;
  totalCostUsd: number;
  numTurns: number;
}
