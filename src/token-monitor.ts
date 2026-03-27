/**
 * Token monitor — pure functions for tracking context usage and relay decisions.
 *
 * Context size formula (spike-proven):
 *   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *
 * Per-turn input_tokens is near-zero (~3); actual context carried in cache fields.
 */

import type {
  TokenMonitorState,
  TurnUsageRecord,
  SdkUsage,
  SdkModelUsageEntry,
  RelayDecision,
} from "./types.js";

/**
 * Tools that produce large context growth per turn (30-150K tokens).
 * When one of these fires in a segment, the next segment's maxTurns
 * should account for the higher growth rate.
 */
export const HEAVY_TOOLS: ReadonlySet<string> = new Set([
  "WebFetch",
  "WebSearch",
  "Screenshot",
]);

/**
 * Multiplier applied to growth rate when a heavy tool was seen
 * in the current segment. Conservative: assume 2.5x the measured rate.
 */
export const HEAVY_TOOL_GROWTH_MULTIPLIER = 2.5;

export function createTokenMonitorState(): TokenMonitorState {
  return {
    contextWindow: null,
    totalOutputTokens: 0,
    estimatedCostUsd: 0,
    turnHistory: [],
    turnCounter: 0,
  };
}

/**
 * Record usage from an AssistantMessage's per-turn usage.
 * Returns the computed context size, or null if usage fields are missing.
 */
export function recordTurnUsage(
  state: TokenMonitorState,
  usage: SdkUsage | null | undefined,
): number | null {
  if (!usage) return null;

  const inputTokens = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;

  // All three zero means usage was empty/undefined — don't record
  if (inputTokens === 0 && cacheRead === 0 && cacheCreation === 0) {
    return null;
  }

  const computedContextSize = inputTokens + cacheRead + cacheCreation;
  state.turnCounter++;

  const record: TurnUsageRecord = {
    turn: state.turnCounter,
    inputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    computedContextSize,
  };

  state.turnHistory.push(record);
  state.totalOutputTokens += usage.output_tokens ?? 0;

  return computedContextSize;
}

/**
 * Set the context window denominator from modelUsage on a ResultMessage.
 */
export function setContextWindow(
  state: TokenMonitorState,
  modelUsage: Record<string, SdkModelUsageEntry> | null | undefined,
): void {
  if (!modelUsage) return;
  const models = Object.values(modelUsage);
  for (const m of models) {
    if (m.contextWindow && m.contextWindow > 0) {
      state.contextWindow = m.contextWindow;
      break;
    }
  }
}

/**
 * Set estimated cost from ResultMessage aggregate.
 */
export function setCost(state: TokenMonitorState, costUsd: number): void {
  state.estimatedCostUsd = costUsd;
}

/**
 * Should we relay? Returns a decision with reason.
 * Returns relay=false if we don't have enough data.
 */
export function shouldRelay(
  state: TokenMonitorState,
  thresholdRatio: number,
): RelayDecision {
  if (state.contextWindow === null || state.contextWindow <= 0) {
    return {
      relay: false,
      reason: "no context window denominator yet",
      contextSize: 0,
      contextWindow: 0,
    };
  }

  if (state.turnHistory.length === 0) {
    return {
      relay: false,
      reason: "no turns recorded yet",
      contextSize: 0,
      contextWindow: state.contextWindow,
    };
  }

  const latest = state.turnHistory[state.turnHistory.length - 1];
  const ratio = latest.computedContextSize / state.contextWindow;

  if (ratio >= thresholdRatio) {
    return {
      relay: true,
      reason: `context at ${(ratio * 100).toFixed(1)}% (threshold: ${(thresholdRatio * 100).toFixed(1)}%)`,
      contextSize: latest.computedContextSize,
      contextWindow: state.contextWindow,
    };
  }

  return {
    relay: false,
    reason: `context at ${(ratio * 100).toFixed(1)}% (threshold: ${(thresholdRatio * 100).toFixed(1)}%)`,
    contextSize: latest.computedContextSize,
    contextWindow: state.contextWindow,
  };
}

/**
 * Compute average context growth rate over the last N turns (tokens/turn).
 * Returns null if insufficient data.
 */
export function computeGrowthRate(
  state: TokenMonitorState,
  windowSize: number = 5,
): number | null {
  const history = state.turnHistory;
  if (history.length < 2) return null;

  const window = history.slice(-windowSize);
  if (window.length < 2) return null;

  const first = window[0];
  const last = window[window.length - 1];
  const delta = last.computedContextSize - first.computedContextSize;
  const turns = window.length - 1;

  return delta / turns;
}

/**
 * Compute adaptive maxTurns for the next segment based on growth rate.
 *
 * Predicts how many turns fit in the remaining context budget before
 * hitting the relay threshold (with a safety margin). Clamps between
 * a floor (default 3) and the configured max (user's --max-turns).
 *
 * Returns the configured default when there's insufficient data
 * (first segment of a session, or growth rate is zero/negative).
 */
export function computeAdaptiveMaxTurns(
  state: TokenMonitorState,
  relayThresholdRatio: number,
  configuredMaxTurns: number,
  options?: {
    headroomFactor?: number;        // Target this fraction of relay threshold (default: 0.85)
    minTurns?: number;              // Floor (default: 3)
    growthWindowSize?: number;      // Turns for growth rate calc (default: 5)
    lastHeavyToolSeen?: boolean;    // Was a heavy tool used in the previous segment?
  },
): { maxTurns: number; reason: string } {
  const headroomFactor = options?.headroomFactor ?? 0.85;
  const minTurns = options?.minTurns ?? 3;
  const growthWindowSize = options?.growthWindowSize ?? 5;
  const heavyToolSeen = options?.lastHeavyToolSeen ?? false;

  // No data yet — use configured default
  const growthRate = computeGrowthRate(state, growthWindowSize);
  if (growthRate === null || growthRate <= 0 || state.contextWindow === null) {
    return {
      maxTurns: configuredMaxTurns,
      reason: "no growth data yet, using configured default",
    };
  }

  const currentSize = state.turnHistory.length > 0
    ? state.turnHistory[state.turnHistory.length - 1].computedContextSize
    : 0;

  // Target: land at headroomFactor * relayThreshold * contextWindow
  // With defaults (0.85 * 0.85 = 0.7225), we target ~72% of the context window,
  // leaving ~13% headroom before the relay threshold fires.
  const targetSize = state.contextWindow * relayThresholdRatio * headroomFactor;
  const remainingBudget = targetSize - currentSize;

  if (remainingBudget <= 0) {
    return {
      maxTurns: minTurns,
      reason: `already at/past target (${currentSize} >= ${Math.round(targetSize)})`,
    };
  }

  // Apply heavy tool multiplier: if a heavy tool was seen, assume
  // the effective growth rate is higher than the trailing average.
  const effectiveRate = heavyToolSeen
    ? growthRate * HEAVY_TOOL_GROWTH_MULTIPLIER
    : growthRate;

  const predicted = Math.floor(remainingBudget / effectiveRate);
  const clamped = Math.max(minTurns, Math.min(predicted, configuredMaxTurns));

  return {
    maxTurns: clamped,
    reason: `growth ${Math.round(growthRate)} tok/turn` +
            (heavyToolSeen ? ` (heavy tool: x${HEAVY_TOOL_GROWTH_MULTIPLIER})` : "") +
            `, budget ${Math.round(remainingBudget)} tok` +
            `, predicted ${predicted}, clamped to ${clamped}`,
  };
}

/**
 * Build a TokenUsageSnapshot for checkpointing.
 */
export function buildUsageSnapshot(
  state: TokenMonitorState,
  sessionCount: number,
): {
  lastContextSize: number;
  contextWindow: number;
  totalOutputTokens: number;
  sessionCount: number;
  estimatedCostUsd: number;
  turnHistory: TurnUsageRecord[];
} {
  const lastContext =
    state.turnHistory.length > 0
      ? state.turnHistory[state.turnHistory.length - 1].computedContextSize
      : 0;

  return {
    lastContextSize: lastContext,
    contextWindow: state.contextWindow ?? 0,
    totalOutputTokens: state.totalOutputTokens,
    sessionCount,
    estimatedCostUsd: state.estimatedCostUsd,
    turnHistory: state.turnHistory,
  };
}
