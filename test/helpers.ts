/**
 * Test factory functions for GaryClaw unit tests.
 */

import type {
  Issue,
  Finding,
  Decision,
  Checkpoint,
  TokenUsageSnapshot,
  TurnUsageRecord,
  SdkUsage,
  SdkModelUsageEntry,
} from "../src/types.js";

let issueCounter = 0;
let findingCounter = 0;
let decisionCounter = 0;

export function resetCounters(): void {
  issueCounter = 0;
  findingCounter = 0;
  decisionCounter = 0;
}

export function createMockIssue(overrides: Partial<Issue> = {}): Issue {
  issueCounter++;
  return {
    id: `QA-${String(issueCounter).padStart(3, "0")}`,
    severity: "medium",
    description: `Test issue ${issueCounter}`,
    filePath: `src/components/Component${issueCounter}.tsx`,
    status: "open",
    ...overrides,
  };
}

export function createMockFinding(overrides: Partial<Finding> = {}): Finding {
  findingCounter++;
  return {
    description: `Test finding ${findingCounter}`,
    category: "design",
    ...overrides,
  };
}

export function createMockDecision(overrides: Partial<Decision> = {}): Decision {
  decisionCounter++;
  return {
    timestamp: new Date().toISOString(),
    sessionIndex: 0,
    question: `Should we fix issue ${decisionCounter}?`,
    options: [
      { label: "Yes", description: "Fix it" },
      { label: "No", description: "Skip it" },
    ],
    chosen: "Yes",
    confidence: 8,
    rationale: "It's a clear fix",
    principle: "Bias toward action",
    ...overrides,
  };
}

export function createMockTurnUsage(overrides: Partial<TurnUsageRecord> = {}): TurnUsageRecord {
  return {
    turn: 1,
    inputTokens: 3,
    cacheReadInputTokens: 7525,
    cacheCreationInputTokens: 3069,
    computedContextSize: 10597,
    ...overrides,
  };
}

export function createMockSdkUsage(overrides: Partial<SdkUsage> = {}): SdkUsage {
  return {
    input_tokens: 3,
    output_tokens: 500,
    cache_read_input_tokens: 7525,
    cache_creation_input_tokens: 3069,
    ...overrides,
  };
}

export function createMockModelUsage(
  contextWindow: number = 1_000_000,
): Record<string, SdkModelUsageEntry> {
  return {
    "claude-opus-4-6": {
      inputTokens: 3,
      outputTokens: 500,
      cacheReadInputTokens: 7525,
      cacheCreationInputTokens: 3069,
      contextWindow,
      maxOutputTokens: 64000,
      costUSD: 0.015,
    },
  };
}

export function createMockTokenUsageSnapshot(
  overrides: Partial<TokenUsageSnapshot> = {},
): TokenUsageSnapshot {
  return {
    lastContextSize: 10597,
    contextWindow: 1_000_000,
    totalOutputTokens: 500,
    sessionCount: 1,
    estimatedCostUsd: 0.015,
    turnHistory: [createMockTurnUsage()],
    ...overrides,
  };
}

export function createMockCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    runId: "test-run-001",
    skillName: "qa",
    issues: [],
    findings: [],
    decisions: [],
    gitBranch: "main",
    gitHead: "abc1234",
    tokenUsage: createMockTokenUsageSnapshot(),
    screenshotPaths: [],
    ...overrides,
  };
}
