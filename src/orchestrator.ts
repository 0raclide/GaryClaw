/**
 * Orchestrator — two-level loop: outer=sessions, inner=segments.
 * Per-turn monitoring, deferred relay.
 *
 * Loop:
 * 1. verifyAuth()
 * 2. for sessionIndex in 0..maxRelaySessions:
 * 3.   for segmentIndex in 0..∞:
 * 4.     segment = startSegment(prompt, maxTurns, ...)
 * 5.     for msg in segment:
 * 6.       if assistant → recordTurnUsage → check shouldRelay → set flag
 * 7.       if result → setContextWindow, recordCost
 * 8.     if relay flag → writeCheckpoint → prepareRelay → break to new session
 * 9.     if success → done
 * 10.    if maxTurns → resume same session with "Continue."
 * 11. buildReport() from accumulated checkpoints
 */

import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  startSegment,
  extractTurnUsage,
  extractResultData,
  buildSdkEnv,
  verifyAuth,
} from "./sdk-wrapper.js";
import {
  createTokenMonitorState,
  recordTurnUsage,
  setContextWindow,
  setCost,
  shouldRelay,
  buildUsageSnapshot,
} from "./token-monitor.js";
import { writeCheckpoint, readCheckpoint } from "./checkpoint.js";
import { createAskHandler } from "./ask-handler.js";
import { executeRelay, finalizeRelay } from "./relay.js";
import { buildReport, formatReportMarkdown } from "./report.js";

import type {
  GaryClawConfig,
  OrchestratorCallbacks,
  Checkpoint,
  RelayPoint,
  SegmentResult,
} from "./types.js";

/**
 * Run a skill from scratch.
 */
export async function runSkill(
  config: GaryClawConfig,
  callbacks: OrchestratorCallbacks,
): Promise<void> {
  const runId = `garyclaw-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const startTime = new Date().toISOString();

  // 1. Verify auth
  callbacks.onEvent({ type: "segment_start", sessionIndex: 0, segmentIndex: 0 });
  try {
    await verifyAuth(config.env);
  } catch (err) {
    callbacks.onEvent({
      type: "error",
      message: `Auth failed: ${err instanceof Error ? err.message : String(err)}. Ensure you're logged in with \`claude login\`.`,
      recoverable: false,
    });
    return;
  }

  const checkpoints: Checkpoint[] = [];
  const relayPoints: RelayPoint[] = [];
  let totalTurns = 0;
  let sessionId = "";
  let estimatedCostUsd = 0;

  // Initial prompt — just the skill name, SKILL.md loaded via settingSources
  let currentPrompt = `Run the /${config.skillName} skill. Follow all SKILL.md instructions completely.`;

  // 2. Session loop
  for (
    let sessionIndex = 0;
    sessionIndex < config.maxRelaySessions;
    sessionIndex++
  ) {
    const monitor = createTokenMonitorState();
    const askHandler = createAskHandler({
      onAskUser: callbacks.onAskUser,
      askTimeoutMs: config.askTimeoutMs,
      sessionIndex,
    });

    let relayFlag = false;
    let relayReason = "";
    let relayContextSize = 0;

    // 3. Segment loop (within a session)
    for (let segmentIndex = 0; ; segmentIndex++) {
      callbacks.onEvent({
        type: "segment_start",
        sessionIndex,
        segmentIndex,
      });

      const segment = startSegment({
        prompt: segmentIndex === 0 ? currentPrompt : "Continue.",
        maxTurns: config.maxTurnsPerSegment,
        cwd: config.projectDir,
        env: config.env,
        settingSources: config.settingSources,
        canUseTool: askHandler.canUseTool,
        ...(segmentIndex > 0 && sessionId ? { resume: sessionId } : {}),
      });

      let segmentResult: SegmentResult | null = null;

      // 4. Process messages
      for await (const msg of segment) {
        // Per-turn monitoring
        const turnUsage = extractTurnUsage(msg);
        if (turnUsage) {
          const contextSize = recordTurnUsage(monitor, turnUsage);
          if (contextSize !== null) {
            totalTurns++;
            callbacks.onEvent({
              type: "turn_usage",
              sessionIndex,
              turn: monitor.turnCounter,
              contextSize,
              contextWindow: monitor.contextWindow,
            });

            // Check relay threshold (deferred — just set flag)
            const decision = shouldRelay(monitor, config.relayThresholdRatio);
            if (decision.relay && !relayFlag) {
              relayFlag = true;
              relayReason = decision.reason;
              relayContextSize = decision.contextSize;
            }
          }
        }

        // Result message — segment complete
        const result = extractResultData(msg);
        if (result) {
          segmentResult = result;
          sessionId = result.sessionId;

          // Set context window denominator
          setContextWindow(monitor, result.modelUsage);

          // Update cost
          if (result.totalCostUsd > 0) {
            setCost(monitor, result.totalCostUsd);
            estimatedCostUsd = result.totalCostUsd;
          }

          totalTurns = Math.max(totalTurns, result.numTurns);

          callbacks.onEvent({
            type: "segment_end",
            sessionIndex,
            segmentIndex,
            numTurns: result.numTurns,
          });
        }
      }

      // 5. Post-segment decisions
      if (relayFlag) {
        // Save checkpoint
        const checkpoint = buildCheckpoint(
          runId,
          config,
          monitor,
          askHandler.getDecisions(),
          sessionIndex,
          checkpoints,
        );
        writeCheckpoint(checkpoint, config.checkpointDir);
        checkpoints.push(checkpoint);

        callbacks.onEvent({
          type: "checkpoint_saved",
          path: join(config.checkpointDir, "checkpoint.json"),
        });

        callbacks.onEvent({
          type: "relay_triggered",
          sessionIndex,
          reason: relayReason,
          contextSize: relayContextSize,
        });

        relayPoints.push({
          sessionIndex,
          timestamp: new Date().toISOString(),
          reason: relayReason,
          contextSize: relayContextSize,
        });

        // Execute relay — git stash + build new segment
        const { segmentOptions, prepareResult } = executeRelay(
          checkpoint,
          config,
        );

        if (prepareResult.error) {
          callbacks.onEvent({
            type: "error",
            message: `Relay git stash failed: ${prepareResult.error}`,
            recoverable: true,
          });
        }

        // Update prompt for next session
        currentPrompt = segmentOptions.prompt;
        sessionId = ""; // Fresh session

        callbacks.onEvent({
          type: "relay_complete",
          newSessionIndex: sessionIndex + 1,
        });

        // Finalize relay (pop stash if needed)
        if (prepareResult.stashed) {
          const finalize = finalizeRelay(
            config.projectDir,
            prepareResult.stashRef,
          );
          if (finalize.error) {
            callbacks.onEvent({
              type: "error",
              message: `Relay stash pop failed: ${finalize.error}`,
              recoverable: true,
            });
          }
        }

        break; // Break segment loop → new session
      }

      // Check if skill is complete
      if (segmentResult?.subtype === "success") {
        // Save final checkpoint
        const checkpoint = buildCheckpoint(
          runId,
          config,
          monitor,
          askHandler.getDecisions(),
          sessionIndex,
          checkpoints,
        );
        writeCheckpoint(checkpoint, config.checkpointDir);
        checkpoints.push(checkpoint);

        // Build report
        const endTime = new Date().toISOString();
        const report = buildReport(checkpoints, {
          runId,
          skillName: config.skillName,
          startTime,
          endTime,
          totalSessions: sessionIndex + 1,
          totalTurns,
          estimatedCostUsd,
          relayPoints,
        });

        // Write report
        mkdirSync(config.checkpointDir, { recursive: true });
        const reportPath = join(config.checkpointDir, "report.md");
        writeFileSync(reportPath, formatReportMarkdown(report), "utf-8");

        callbacks.onEvent({
          type: "skill_complete",
          totalSessions: sessionIndex + 1,
          totalTurns,
        });

        return;
      }

      // If we hit maxTurns but no relay needed, continue same session
      if (segmentResult?.subtype === "max_turns") {
        continue; // Next segment in same session
      }

      // Error or unexpected subtype
      if (segmentResult?.subtype === "error") {
        callbacks.onEvent({
          type: "error",
          message: `Segment ended with error: ${segmentResult.resultText}`,
          recoverable: true,
        });

        // Save checkpoint for potential resume
        const checkpoint = buildCheckpoint(
          runId,
          config,
          monitor,
          askHandler.getDecisions(),
          sessionIndex,
          checkpoints,
        );
        writeCheckpoint(checkpoint, config.checkpointDir);
        checkpoints.push(checkpoint);

        callbacks.onEvent({
          type: "checkpoint_saved",
          path: join(config.checkpointDir, "checkpoint.json"),
        });
        return;
      }

      // If segmentResult is null or unrecognized subtype, try continuing
      if (!segmentResult) {
        callbacks.onEvent({
          type: "error",
          message: "Segment completed without result message",
          recoverable: true,
        });
        break;
      }
    }
  }

  // Hit maxRelaySessions
  callbacks.onEvent({
    type: "error",
    message: `Reached max relay sessions (${config.maxRelaySessions}). Run \`garyclaw resume\` to continue.`,
    recoverable: true,
  });
}

/**
 * Resume a skill from a checkpoint.
 */
export async function resumeSkill(
  checkpointDir: string,
  config: GaryClawConfig,
  callbacks: OrchestratorCallbacks,
): Promise<void> {
  const checkpoint = readCheckpoint(checkpointDir);
  if (!checkpoint) {
    callbacks.onEvent({
      type: "error",
      message: `No valid checkpoint found in ${checkpointDir}`,
      recoverable: false,
    });
    return;
  }

  // Override config with checkpoint data
  const resumeConfig: GaryClawConfig = {
    ...config,
    skillName: checkpoint.skillName,
  };

  // Run with the checkpoint as the starting state
  return runSkill(resumeConfig, callbacks);
}

function buildCheckpoint(
  runId: string,
  config: GaryClawConfig,
  monitor: ReturnType<typeof createTokenMonitorState>,
  decisions: ReturnType<typeof createAskHandler>["getDecisions"] extends () => infer R ? R : never,
  sessionIndex: number,
  previousCheckpoints: Checkpoint[],
): Checkpoint {
  const usageSnapshot = buildUsageSnapshot(monitor, sessionIndex + 1);

  // Merge issues/findings from previous checkpoints
  const prevIssues = previousCheckpoints.flatMap((cp) => cp.issues);
  const prevFindings = previousCheckpoints.flatMap((cp) => cp.findings);
  const prevDecisions = previousCheckpoints.flatMap((cp) => cp.decisions);

  // Get git state
  let gitBranch = "unknown";
  let gitHead = "unknown";
  try {
    gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: config.projectDir,
      encoding: "utf-8",
    }).trim();
    gitHead = execSync("git rev-parse HEAD", {
      cwd: config.projectDir,
      encoding: "utf-8",
    }).trim();
  } catch {
    // Non-fatal — may not be in a git repo
  }

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    runId,
    skillName: config.skillName,
    issues: prevIssues, // TODO: parse from skill output in Phase 2
    findings: prevFindings,
    decisions: [...prevDecisions, ...decisions],
    gitBranch,
    gitHead,
    tokenUsage: usageSnapshot,
    screenshotPaths: [],
  };
}
