/**
 * Orchestrator — two-level loop: outer=sessions, inner=segments.
 * Per-turn monitoring, deferred relay, live progress feed.
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
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  startSegment,
  extractTurnUsage,
  extractResultData,
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
import { writeCheckpoint, readCheckpoint, generateRelayPrompt } from "./checkpoint.js";
import { createAskHandler } from "./ask-handler.js";
import { askOracle, createSdkOracleQueryFn } from "./oracle.js";
import { executeRelay, finalizeRelay } from "./relay.js";
import { buildReport, formatReportMarkdown } from "./report.js";
import { PerJobCostExceededError, type Issue } from "./types.js";
import {
  defaultMemoryConfig,
  readOracleMemory,
  isCircuitBreakerTripped,
} from "./oracle-memory.js";
import { sendNotification } from "./notifier.js";
import { runReflection } from "./reflection.js";

import { IssueTracker, extractAllToolUse, parseGitLog } from "./issue-extractor.js";

import type {
  GaryClawConfig,
  OrchestratorCallbacks,
  Checkpoint,
  RelayPoint,
  SegmentResult,
} from "./types.js";

/**
 * Extract assistant text content from an SDK message for live progress.
 */
export function extractAssistantText(msg: any): string | null {
  if (!msg || msg.type !== "assistant") return null;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      texts.push(block.text);
    }
  }
  return texts.length > 0 ? texts.join("") : null;
}

/**
 * Extract tool use info from an SDK message for live progress.
 */
export function extractToolUse(msg: any): { toolName: string; inputSummary: string } | null {
  if (!msg || msg.type !== "assistant") return null;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block.type === "tool_use") {
      const toolName = block.name ?? "unknown";
      const input = block.input ?? {};
      // Summarize input: first string field, truncated
      const summary = summarizeToolInput(toolName, input);
      return { toolName, inputSummary: summary };
    }
  }
  return null;
}

export function summarizeToolInput(toolName: string, input: Record<string, any>): string {
  switch (toolName) {
    case "Read":
      return input.file_path ? truncate(input.file_path, 80) : "";
    case "Edit":
      return input.file_path ? truncate(input.file_path, 80) : "";
    case "Write":
      return input.file_path ? truncate(input.file_path, 80) : "";
    case "Bash":
      return input.command ? truncate(input.command, 80) : "";
    case "Glob":
      return input.pattern ? truncate(input.pattern, 80) : "";
    case "Grep":
      return input.pattern ? truncate(input.pattern, 80) : "";
    case "WebFetch":
      return input.url ? truncate(input.url, 80) : "";
    default: {
      const firstVal = Object.values(input)[0];
      return typeof firstVal === "string" ? truncate(firstVal, 60) : "";
    }
  }
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

/**
 * Run a skill from scratch.
 */
export async function runSkill(
  config: GaryClawConfig,
  callbacks: OrchestratorCallbacks,
): Promise<void> {
  return runSkillInternal(config, callbacks);
}

/**
 * Internal: run a skill with an optional initial prompt override.
 */
async function runSkillInternal(
  config: GaryClawConfig,
  callbacks: OrchestratorCallbacks,
  initialPromptOverride?: string,
): Promise<void> {
  const runId = `garyclaw-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const startTime = new Date().toISOString();
  const decisionLogPath = join(config.checkpointDir, "decisions.jsonl");

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
  const issueTracker = new IssueTracker(config.skillName);
  let totalTurns = 0;
  let sessionId = "";
  let estimatedCostUsd = 0;
  let currentSessionCost = 0;

  // Initial prompt — use override if provided (pipeline context handoff), else default
  let currentPrompt = initialPromptOverride
    ?? `Run the /${config.skillName} skill. Follow all SKILL.md instructions completely.`;

  // 2. Session loop
  for (
    let sessionIndex = 0;
    sessionIndex < config.maxRelaySessions;
    sessionIndex++
  ) {
    // Check abort signal at session boundary
    if (config.abortSignal?.aborted) {
      callbacks.onEvent({
        type: "error",
        message: "Aborted by signal",
        recoverable: false,
      });
      return;
    }
    const monitor = createTokenMonitorState();

    // Phase 5a: Read oracle memory for this session (once per session, not per question)
    const oracleMemory = (() => {
      if (!config.autonomous || config.noMemory) return undefined;
      try {
        const memConfig = defaultMemoryConfig(config.mainRepoDir ?? config.projectDir);
        // Check circuit breaker — if tripped, disable memory and notify
        if (isCircuitBreakerTripped(memConfig)) {
          sendNotification(
            "GaryClaw Oracle Degraded",
            "Circuit breaker tripped — Oracle memory disabled (accuracy < 60%)",
          );
          return undefined;
        }
        const memory = readOracleMemory(memConfig, config.projectDir);
        // Only return if there's at least one non-null memory file
        if (memory.taste || memory.domainExpertise || memory.decisionOutcomes || memory.memoryMd) {
          return memory;
        }
        return undefined;
      } catch {
        // Oracle memory read failed — degrade gracefully to no-memory mode
        return undefined;
      }
    })();

    const askHandler = createAskHandler({
      onAskUser: callbacks.onAskUser,
      askTimeoutMs: config.askTimeoutMs,
      sessionIndex,
      decisionLogPath,
      autonomous: config.autonomous,
      ...(config.autonomous
        ? {
            oracle: {
              askOracle,
              config: {
                queryFn: createSdkOracleQueryFn(config.env),
                escalateThreshold: 6,
              },
              skillName: config.skillName,
              memory: oracleMemory,
            },
            escalatedLogPath: join(config.checkpointDir, "escalated.jsonl"),
          }
        : {}),
    });

    currentSessionCost = 0; // Reset per session

    let relayFlag = false;
    let relayReason = "";
    let relayContextSize = 0;

    // 3. Segment loop (within a session)
    for (let segmentIndex = 0; ; segmentIndex++) {
      // Check abort signal at segment boundary
      if (config.abortSignal?.aborted) {
        callbacks.onEvent({
          type: "error",
          message: "Aborted by signal",
          recoverable: false,
        });
        return;
      }

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
      // Wrapped in try/catch to save checkpoint if PerJobCostExceededError
      // is thrown from callbacks.onEvent (per-job budget enforcement).
      try {
        for await (const msg of segment) {
          // Live progress: assistant text
          const text = extractAssistantText(msg);
          if (text) {
            callbacks.onEvent({ type: "assistant_text", text });
          }

          // Live progress: tool use
          const toolUse = extractToolUse(msg);
          if (toolUse) {
            callbacks.onEvent({
              type: "tool_use",
              toolName: toolUse.toolName,
              inputSummary: toolUse.inputSummary,
            });
          }

          // Issue extraction: feed all tool_use blocks to tracker
          const allToolUses = extractAllToolUse(msg);
          for (const tu of allToolUses) {
            issueTracker.trackToolUse(tu.toolName, tu.input);
            if (tu.toolName === "Bash" && typeof tu.input.command === "string") {
              const extracted = issueTracker.trackCommit(tu.input.command);
              if (extracted) {
                callbacks.onEvent({ type: "issue_extracted", issue: extracted });
              }
            }
          }

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

            // Update cost before relay re-check so checkpoint has accurate data.
            // result.totalCostUsd is the session's cumulative cost (not a delta).
            // Track per-session cost separately and accumulate across sessions
            // to avoid losing prior sessions' costs on relay.
            if (result.totalCostUsd > 0) {
              setCost(monitor, result.totalCostUsd);
              currentSessionCost = result.totalCostUsd;
              callbacks.onEvent({
                type: "cost_update",
                costUsd: estimatedCostUsd + currentSessionCost,
                sessionIndex,
              });
            }

            // Re-check relay now that contextWindow is known
            // (shouldRelay returns false when contextWindow is null,
            // which is the case during assistant message processing
            // before the first result message arrives)
            if (!relayFlag) {
              const decision = shouldRelay(monitor, config.relayThresholdRatio);
              if (decision.relay) {
                relayFlag = true;
                relayReason = decision.reason;
                relayContextSize = decision.contextSize;
              }
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
      } catch (err) {
        if (err instanceof PerJobCostExceededError) {
          // Save checkpoint before propagating so work can be resumed
          const checkpoint = buildCheckpoint(
            runId, config, monitor, askHandler.getDecisions(),
            sessionIndex, checkpoints, issueTracker,
          );
          writeCheckpoint(checkpoint, config.checkpointDir);
          callbacks.onEvent({
            type: "checkpoint_saved",
            path: join(config.checkpointDir, "checkpoint.json"),
          });
        }
        throw err;
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
          issueTracker,
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
        // Pass canUseTool so relayed sessions preserve AskUserQuestion handling
        const { segmentOptions, prepareResult } = executeRelay(
          checkpoint,
          config,
          askHandler.canUseTool,
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

        // Accumulate this session's cost before moving to next session
        estimatedCostUsd += currentSessionCost;

        break; // Break segment loop → new session
      }

      // Check if skill is complete
      if (segmentResult?.subtype === "success") {
        // Accumulate final session's cost
        estimatedCostUsd += currentSessionCost;

        // Save final checkpoint
        const checkpoint = buildCheckpoint(
          runId,
          config,
          monitor,
          askHandler.getDecisions(),
          sessionIndex,
          checkpoints,
          issueTracker,
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
          costUsd: estimatedCostUsd,
        });

        // Phase 5b: Post-job reflection — map decisions to outcomes and update metrics
        if (config.autonomous && !config.noMemory) {
          try {
            const allDecisions = checkpoint.decisions;
            const allIssues = checkpoint.issues;
            runReflection({
              decisions: allDecisions,
              issues: allIssues,
              jobId: runId,
              projectDir: config.projectDir,
            });
          } catch (err) {
            // Reflection failure is non-fatal — don't block completion
            console.warn(`[GaryClaw] Reflection failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

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
          issueTracker,
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
 * Run a skill with a custom initial prompt (used by pipeline for context handoff).
 * Same as runSkill but overrides the default "Run the /skill..." prompt.
 */
export async function runSkillWithInitialPrompt(
  config: GaryClawConfig,
  callbacks: OrchestratorCallbacks,
  initialPrompt: string,
): Promise<void> {
  return runSkillInternal(config, callbacks, initialPrompt);
}

/**
 * Resume a skill from a checkpoint.
 * Generates a relay prompt from the checkpoint so the new session
 * picks up where the previous one left off (issues, decisions, progress).
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

  // Generate relay prompt from checkpoint so accumulated state is carried forward.
  // Without this, resume would start from scratch and discard all prior work.
  const relayPrompt = generateRelayPrompt(checkpoint);
  return runSkillWithInitialPrompt(resumeConfig, callbacks, relayPrompt);
}

/**
 * Merge previous checkpoint issues with current tracker issues, deduplicating by ID.
 * The tracker accumulates across sessions, so prevIssues (from the last checkpoint)
 * may already contain issues the tracker also has. Deduplicate to avoid inflation.
 */
export function deduplicateIssues(prevIssues: Issue[], trackerIssues: Issue[]): Issue[] {
  const seenIds = new Set(prevIssues.map((i) => i.id));
  const newIssues = trackerIssues.filter((i) => !seenIds.has(i.id));
  return [...prevIssues, ...newIssues];
}

function buildCheckpoint(
  runId: string,
  config: GaryClawConfig,
  monitor: ReturnType<typeof createTokenMonitorState>,
  decisions: ReturnType<typeof createAskHandler>["getDecisions"] extends () => infer R ? R : never,
  sessionIndex: number,
  previousCheckpoints: Checkpoint[],
  issueTracker: IssueTracker,
): Checkpoint {
  const usageSnapshot = buildUsageSnapshot(monitor, sessionIndex + 1);

  // Use last checkpoint's accumulated data (each checkpoint already contains all
  // prior data). Using flatMap across all checkpoints would grow quadratically.
  const lastCheckpoint = previousCheckpoints.length > 0
    ? previousCheckpoints[previousCheckpoints.length - 1]
    : null;
  const prevIssues = lastCheckpoint?.issues ?? [];
  const prevFindings = lastCheckpoint?.findings ?? [];
  const prevDecisions = lastCheckpoint?.decisions ?? [];

  // Get git state
  let gitBranch = "unknown";
  let gitHead = "unknown";
  try {
    gitBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: config.projectDir,
      encoding: "utf-8",
    }).trim();
    gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: config.projectDir,
      encoding: "utf-8",
    }).trim();
  } catch {
    // Non-fatal — may not be in a git repo
  }

  // Git log verification: catch commits missed by stream parsing
  const prevHead = previousCheckpoints.length > 0
    ? previousCheckpoints[previousCheckpoints.length - 1].gitHead
    : null;
  if (prevHead && prevHead !== "unknown" && gitHead !== "unknown") {
    const gitLogIssues = parseGitLog(prevHead, gitHead, config.projectDir, config.skillName);
    issueTracker.mergeGitLogIssues(gitLogIssues);
  }

  // Deduplicate decisions by timestamp to prevent inflation when
  // multiple checkpoints are built in the same segment (e.g., error + relay).
  const prevDecisionTimestamps = new Set(prevDecisions.map((d) => d.timestamp));
  const newDecisions = decisions.filter((d) => !prevDecisionTimestamps.has(d.timestamp));

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    runId,
    skillName: config.skillName,
    issues: deduplicateIssues(prevIssues, issueTracker.getIssues()),
    findings: prevFindings,
    decisions: [...prevDecisions, ...newDecisions],
    gitBranch,
    gitHead,
    tokenUsage: usageSnapshot,
    screenshotPaths: [],
  };
}
