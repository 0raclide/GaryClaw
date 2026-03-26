/**
 * Relay — git stash, build relay segment, finalize relay.
 *
 * Fresh sessions for relay (not resume). Resume carries compressed history
 * that still consumes context. Fresh session + checkpoint prompt starts at
 * ~17K tokens (relay prompt + SKILL.md via settingSources).
 */

import { execFileSync } from "node:child_process";
import { generateRelayPrompt } from "./checkpoint.js";
import type { Checkpoint, SegmentOptions, GaryClawConfig } from "./types.js";

export interface PrepareRelayResult {
  stashed: boolean;
  stashRef?: string;
  error?: string;
}

export interface FinalizeRelayResult {
  error?: string;
}

/**
 * Prepare for relay by stashing any dirty working tree state.
 */
export function prepareRelay(projectDir: string): PrepareRelayResult {
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    if (!status) {
      return { stashed: false };
    }

    const stashRef = `garyclaw-relay-${Date.now()}`;
    execFileSync("git", ["stash", "push", "--include-untracked", "-m", stashRef], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 30_000,
    });

    return { stashed: true, stashRef };
  } catch (err) {
    return {
      stashed: false,
      error: `git stash failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Build segment options for a relay (fresh session with checkpoint prompt).
 * Accepts canUseTool so relayed sessions preserve AskUserQuestion handling.
 */
export function buildRelaySegment(
  checkpoint: Checkpoint,
  config: GaryClawConfig,
  canUseTool?: SegmentOptions["canUseTool"],
): SegmentOptions {
  const relayPrompt = generateRelayPrompt(checkpoint);

  return {
    prompt: relayPrompt,
    maxTurns: config.maxTurnsPerSegment,
    cwd: config.projectDir,
    env: config.env,
    settingSources: config.settingSources,
    // No resume — fresh session for clean context
    canUseTool: canUseTool ?? (async () => ({ behavior: "allow" as const })),
  };
}

/**
 * Finalize relay by popping stashed changes.
 */
export function finalizeRelay(
  projectDir: string,
  stashRef?: string,
): FinalizeRelayResult {
  if (!stashRef) return {};

  try {
    execFileSync("git", ["stash", "pop"], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 30_000,
    });
    return {};
  } catch (err) {
    return {
      error: `git stash pop failed (possible merge conflict): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Full relay flow: prepare → build segment options → return.
 * Orchestrator starts the actual segment.
 */
export function executeRelay(
  checkpoint: Checkpoint,
  config: GaryClawConfig,
  canUseTool?: SegmentOptions["canUseTool"],
): {
  segmentOptions: SegmentOptions;
  prepareResult: PrepareRelayResult;
} {
  const prepareResult = prepareRelay(config.projectDir);
  const segmentOptions = buildRelaySegment(checkpoint, config, canUseTool);
  return { segmentOptions, prepareResult };
}
