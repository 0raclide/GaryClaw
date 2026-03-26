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
  projectDir: string;
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
}

export type TriggerConfig = GitPollTrigger;

export interface GitPollTrigger {
  type: "git_poll";
  intervalSeconds: number;
  skills: string[];
  branch?: string;
  debounceSeconds?: number;
}

export interface BudgetConfig {
  dailyCostLimitUsd: number;
  perJobCostLimitUsd: number;
  maxJobsPerDay: number;
}

export type JobStatus = "queued" | "running" | "complete" | "failed" | "cancelled";

export interface Job {
  id: string;
  triggeredBy: "git_poll" | "manual";
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
}

export interface DaemonState {
  version: 1;
  jobs: Job[];
  dailyCost: { date: string; totalUsd: number; jobCount: number };
}

// ── IPC protocol ────────────────────────────────────────────────

export type IPCRequest =
  | { type: "status" }
  | { type: "trigger"; skills: string[] }
  | { type: "queue" };

export interface IPCResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
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
