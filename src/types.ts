/**
 * GaryClaw shared types — zero imports.
 * Every other module imports from here.
 */

// ── Shared warn utility ─────────────────────────────────────────

/** Warn function signature — routes to callback if provided, else console.warn. */
export type WarnFn = (msg: string) => void;

/** Resolve a warn function — routes to callback if provided, else console.warn. */
export function resolveWarnFn(onWarn?: WarnFn): WarnFn {
  return onWarn ?? console.warn;
}

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

// ── Codebase summary (carried across relay boundaries) ──────────

export interface CodebaseSummary {
  observations: string[];      // Deduplicated observation strings
  failedApproaches: string[];  // Specifically "I tried X but Y" patterns
  lastSessionIndex: number;    // Highest session index that contributed observations
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
  codebaseSummary?: CodebaseSummary;
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
  /** Disable adaptive maxTurns computation (use fixed maxTurnsPerSegment). Default: true (enabled). */
  adaptiveMaxTurns?: boolean;
  /** Topic string for auto-research jobs (passed from job-runner to orchestrator). */
  researchTopic?: string;
  /** Main repo dir for oracle memory when projectDir points to a worktree. */
  mainRepoDir?: string;
  /** TODO items claimed by other daemon instances (injected into prioritize prompt). */
  claimedTodoItems?: Array<{ title: string; instanceName: string }>;
  /** Pre-assigned TODO title for this instance (bypasses free-choice prioritize). */
  preAssignedTodoTitle?: string;
  /** Enable quality gate after bootstrap skill (default: undefined = enabled). */
  bootstrapQualityGate?: boolean;
  /** Claimed TODO title, set by job-runner for pipeline state tracking. */
  todoTitle?: string;
  /** Daemon instance name, set by job-runner for state tracking attribution. */
  instanceName?: string;
  /** Root checkpoint directory (e.g., .garyclaw/daemons/worker-1/). Set by job-runner for TODO state persistence. */
  rootCheckpointDir?: string;
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
  | { type: "pipeline_complete"; totalSkills: number; totalCostUsd: number }
  | { type: "adaptive_turns"; maxTurns: number; reason: string; sessionIndex: number; segmentIndex: number }
  | { type: "bootstrap_quality_check"; qualityScore: number; missingSections: string[]; notes: string[] }
  | { type: "bootstrap_quality_recheck"; qualityScore: number; previousScore: number }
  | { type: "oracle_session"; event: OracleSessionEvent }
  | { type: "pipeline_composed"; originalSkills: string[]; composedSkills: string[]; reason: string }
  | { type: "pipeline_oracle_adjustment"; skill: string; skipRisk: number; action: "restored" | "kept_skipped" };

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
  /** Set to true after bootstrap enrichment has been attempted (prevents infinite loops). */
  bootstrapEnriched?: boolean;
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
  merge?: {
    testCommand?: string;       // default: "npm test"
    testTimeout?: number;       // default: 120000 (2 min)
    skipValidation?: boolean;   // default: false
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
  selfCommitEmail?: string;  // Override daemon email for filtering (default: GARYCLAW_DAEMON_EMAIL)
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

export type JobStatus = "queued" | "running" | "complete" | "failed" | "cancelled" | "rate_limited";

export interface Job {
  id: string;
  triggeredBy: "git_poll" | "cron" | "manual" | "auto_research" | "continuous";
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
  retryCount?: number;           // How many times this job has been retried after crash (1 = first retry, 2 = second retry)
  priorSkillCostUsd?: number;    // Cost of already-completed skills (for dashboard "saved" reporting, not budget checks)
  adaptiveTurnsStats?: AdaptiveTurnsJobStats;  // undefined for pre-existing jobs or --no-adaptive
  claimedTodoTitle?: string;  // TODO item title claimed by this job's prioritize skill
  claimedFiles?: string[];    // Predicted files this job will modify (for conflict prevention)
  composedFrom?: string[];    // Original skills before adaptive composition (undefined if no composition happened)
  compositionMethod?: "static" | "oracle";  // How pipeline was composed: static table or oracle recommendation
}

export interface DaemonState {
  version: 1;
  jobs: Job[];
  dailyCost: { date: string; totalUsd: number; jobCount: number };
  rateLimitResetAt?: string;  // ISO timestamp — hold all jobs until this time
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

export interface PipelineProgress {
  currentSkill: string;           // e.g. "implement"
  skillIndex: number;             // 0-based
  totalSkills: number;            // total in pipeline
  claimedTodoTitle: string | null;  // from job.claimedTodoTitle
  elapsedSeconds: number;         // since job started
  commitCount: number;            // commits on worktree branch since creation
}

// ── Parallel daemon instances ────────────────────────────────────

export interface GlobalBudget {
  date: string;
  totalUsd: number;
  jobCount: number;
  byInstance: Record<string, { totalUsd: number; jobCount: number }>;
  rateLimitResetAt?: string;  // Shared rate limit hold across all instances
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

// ── Oracle Session Reuse ─────────────────────────────────────────

export interface OracleSessionEvent {
  type: "session_created" | "session_resumed" | "session_reset" | "resume_fallback";
  callCount: number;
  sessionId?: string;
}

// ── Failure Taxonomy ─────────────────────────────────────────────

export type FailureCategory =
  | "garyclaw-bug"    // Bug in GaryClaw harness code
  | "skill-bug"       // Skill (gstack skill) misbehavior
  | "project-bug"     // Target project issue (test failures, lint errors)
  | "sdk-bug"         // Agent SDK issue (crashes, protocol errors)
  | "auth-issue"      // Authentication/token expiry
  | "infra-issue"     // Disk, network, OOM, timeout
  | "budget-exceeded" // Per-job or daily cost limit hit
  | "merge-failed"    // Pre-merge test failure or rebase conflict
  | "daemon-crash"    // Job abandoned after repeated daemon restarts
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

// ── Adaptive turns stats (per-job collection) ──────────────────

export interface AdaptiveTurnsJobStats {
  segmentCount: number;           // Total segments in this job
  adaptiveCount: number;          // Segments that used growth-rate prediction
  fallbackCount: number;          // Segments that used configured default ("no growth data")
  clampedCount: number;           // Segments forced to minTurns ("already at/past target")
  heavyToolActivations: number;   // Segments where heavy tool multiplier fired
  minTurns: number | null;        // Lowest adaptive maxTurns predicted (null until first event)
  maxTurns: number;               // Highest adaptive maxTurns predicted
  totalTurns: number;             // Sum of all maxTurns (for computing avg)
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
    rateLimited: number;            // Jobs currently in rate_limited hold
    crashRecoveries: number;       // Jobs that completed after crash retry
    crashRecoverySavedUsd: number; // Cost of prior skills not re-run ($saved)
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
  adaptiveTurns: {
    totalSegments: number;          // Across all today's jobs
    adaptiveSegments: number;       // Used growth-rate prediction
    fallbackSegments: number;       // Used configured default
    clampedSegments: number;        // Forced to minTurns (context budget exhausted)
    heavyToolActivations: number;   // Heavy tool multiplier firings
    avgTurns: number;               // Average maxTurns across all segments
    minTurns: number;               // Lowest maxTurns seen today
    maxTurns: number;               // Highest maxTurns seen today
    adaptiveRate: number;           // % of segments using adaptive (0-100)
  };
  bootstrapEnrichment: {
    triggered: number;             // Number of enrichments triggered today
    avgScoreImprovement: number;   // Average quality score delta (enriched - original)
  };
  mergeHealth: {
    totalAttempts: number;
    merged: number;
    blocked: number;              // test failure or rebase conflict
    successRate: number;          // 0-100
    avgTestDurationMs: number;
    testFailures: number;         // subset of blocked where testsPassed === false
    rebaseConflicts: number;      // subset of blocked where reason contains "conflicts"
  };
  composition: {
    composedJobs: number;           // Jobs where composition changed skill list
    avgSkillsBefore: number;        // Average skill count before composition
    avgSkillsAfter: number;         // Average skill count after composition
    estimatedSavingsUsd: number;    // Estimated cost savings from fewer skills
  };
  compositionIntelligence: {
    oracleActive: boolean;            // Whether Oracle adjustments are active
    oracleAdjustedJobs: number;       // Jobs where Oracle restored skipped skills
    oracleFailureRate: number;        // Failure rate for Oracle-adjusted jobs (0-100)
    staticFailureRate: number;        // Failure rate for static-only jobs (0-100)
    skipRiskScores: Record<string, number>;  // skill name -> skip risk score (0-1)
    circuitBreaker: "ok" | "tripped";
  };
  instances: string[];           // Active instance names
}

// ── Pipeline progress (live status for IPC) ─────────────────────

export interface PipelineProgress {
  currentSkill: string;           // e.g. "implement"
  skillIndex: number;             // 0-based
  totalSkills: number;            // total in pipeline
  claimedTodoTitle: string | null;  // from job.claimedTodoTitle
  elapsedSeconds: number;         // since job started
  commitCount: number;            // commits on worktree branch since creation
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

// ── Pipeline Outcome History (Oracle-driven composition) ─────────

export interface PipelineOutcomeRecord {
  jobId: string;
  timestamp: string;
  todoTitle: string;
  effort: string | null;
  priority: number;
  skills: string[];           // skills that actually ran
  skippedSkills: string[];    // skills removed by composition
  composedFrom?: string[];    // original skill list before composition
  qaFailureCount: number;     // issues with severity critical/high from QA
  reopenedCount: number;      // reopened issues detected by reflection
  outcome: "success" | "partial" | "failure";
  // Derivation: "failure" if qaFailureCount > 0 || reopenedCount > 0,
  //             "partial" if job completed but had non-critical issues,
  //             "success" if no failures and no reopens
  oracleAdjusted: boolean;    // true if Oracle restored any skills beyond static rules
}

// ── Evaluation (dogfood campaign evaluator) ──────────────────────

export type ClaimType = "tech_stack" | "file_path" | "test_framework" | "entry_point" | "command" | "test_directory";

export interface ClaudeMdClaim {
  type: ClaimType;
  claimed: string;        // what CLAUDE.md says
  evidence: string;       // what the filesystem shows
  verified: boolean;      // does the claim hold?
}

export interface BootstrapEvaluation {
  claudeMdExists: boolean;
  claudeMdSizeTokens: number;
  claudeMdHasSections: string[];         // e.g. ["Architecture", "Tech Stack", "Test Strategy"]
  claudeMdMissingSections: string[];     // expected but absent
  todosMdExists: boolean;
  todosMdItemCount: number;
  todosMdItemsAboveThreshold: number;    // items that scored >5.0 in prioritize
  qualityScore: number;                  // 0-100
  qualityNotes: string[];
  claims?: ClaudeMdClaim[];              // per-claim verification results
  claimsVerified?: number;               // count of verified claims
  claimsTotal?: number;                  // total claims extracted
  claimVerificationScore?: number;       // 0-20 sub-score
}

export interface OracleEvaluation {
  totalDecisions: number;
  lowConfidenceCount: number;            // confidence < 6
  escalatedCount: number;
  averageConfidence: number;
  topicClusters: { topic: string; count: number; avgConfidence: number }[];
  researchTriggered: boolean;
}

export interface PipelineEvaluation {
  skillsRun: string[];
  skillsCompleted: string[];
  skillsFailed: string[];
  totalRelays: number;
  totalCostUsd: number;
  totalDurationSec: number;
  contextGrowthRate: number;             // average across segments
  adaptiveTurnsUsed: boolean;
}

export type ImprovementPriority = "P2" | "P3" | "P4";
export type ImprovementEffort = "XS" | "S" | "M";
export type ImprovementCategory = "bootstrap" | "oracle" | "pipeline" | "skill" | "relay";

export interface ImprovementCandidate {
  title: string;
  priority: ImprovementPriority;
  effort: ImprovementEffort;
  category: ImprovementCategory;
  description: string;
  evidence: string;                      // specific data from the dogfood run
}

export interface EvaluationReport {
  targetRepo: string;
  timestamp: string;
  bootstrap: BootstrapEvaluation;
  oracle: OracleEvaluation;
  pipeline: PipelineEvaluation;
  improvements: ImprovementCandidate[];
}
