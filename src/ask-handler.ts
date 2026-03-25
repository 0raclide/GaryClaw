/**
 * Ask handler — canUseTool callback for AskUserQuestion interception.
 *
 * Two modes:
 * - Human mode (default): prompts user via onAskUser callback
 * - Autonomous mode: routes to Decision Oracle, with escalation fallback
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision, CanUseToolResult } from "./types.js";
import type { OracleOutput, OracleConfig, OracleInput } from "./oracle.js";

export interface AskHandlerConfig {
  onAskUser: (
    question: string,
    options: { label: string; description: string }[],
    multiSelect: boolean,
  ) => Promise<string>;
  askTimeoutMs: number;
  sessionIndex: number;
  decisionLogPath?: string;

  // Autonomous mode
  autonomous?: boolean;
  oracle?: {
    askOracle: (input: OracleInput, config: OracleConfig) => Promise<OracleOutput>;
    config: OracleConfig;
    skillName: string;
    projectContext?: string;
  };
  escalatedLogPath?: string;
}

export interface AskHandler {
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<CanUseToolResult>;
  getDecisions: () => Decision[];
}

export function createAskHandler(config: AskHandlerConfig): AskHandler {
  const decisions: Decision[] = [];

  async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<CanUseToolResult> {
    if (toolName !== "AskUserQuestion") {
      return { behavior: "allow" };
    }

    const questions = input.questions as
      | Array<{
          question: string;
          header?: string;
          options: { label: string; description: string }[];
          multiSelect?: boolean;
        }>
      | undefined;

    if (!questions || questions.length === 0) {
      return { behavior: "allow" };
    }

    try {
      const answers: Record<string, string> = {};

      for (const q of questions) {
        const questionText = q.question;
        const options = q.options ?? [];
        const multiSelect = q.multiSelect ?? false;

        let decision: Decision;

        if (config.autonomous && config.oracle) {
          // Oracle mode
          const oracleResult = await config.oracle.askOracle(
            {
              question: questionText,
              options,
              skillName: config.oracle.skillName,
              decisionHistory: decisions,
              projectContext: config.oracle.projectContext,
            },
            config.oracle.config,
          );

          decision = {
            timestamp: new Date().toISOString(),
            sessionIndex: config.sessionIndex,
            question: questionText,
            options,
            chosen: oracleResult.choice,
            confidence: oracleResult.confidence,
            rationale: oracleResult.rationale,
            principle: oracleResult.principle,
          };

          // Escalation: fall back to human if configured
          if (oracleResult.escalate) {
            writeEscalatedLog(config.escalatedLogPath, decision, oracleResult);

            // If human callback available and not in fully autonomous mode,
            // ask the human instead
            if (!config.autonomous && config.onAskUser) {
              try {
                const humanChoice = await withTimeout(
                  config.onAskUser(
                    `[ESCALATED - confidence: ${oracleResult.confidence}/10] ${questionText}`,
                    options,
                    multiSelect,
                  ),
                  config.askTimeoutMs,
                );
                decision.chosen = humanChoice;
                decision.confidence = 10;
                decision.rationale = `Escalated to human (oracle: ${oracleResult.rationale})`;
                decision.principle = "Human override";
              } catch {
                // Human not available — use oracle's choice anyway
              }
            }
          }

          answers[questionText] = decision.chosen;
        } else {
          // Human mode
          const chosenLabel = await withTimeout(
            config.onAskUser(questionText, options, multiSelect),
            config.askTimeoutMs,
          );

          decision = {
            timestamp: new Date().toISOString(),
            sessionIndex: config.sessionIndex,
            question: questionText,
            options,
            chosen: chosenLabel,
            confidence: 10,
            rationale: "Human decision",
            principle: "Human override",
          };

          answers[questionText] = chosenLabel;
        }

        decisions.push(decision);

        if (config.decisionLogPath) {
          writeDecisionLog(config.decisionLogPath, decision);
        }
      }

      return {
        behavior: "allow",
        updatedInput: { ...input, answers },
      };
    } catch (err) {
      const message =
        err instanceof TimeoutError
          ? `AskUserQuestion timed out after ${config.askTimeoutMs}ms`
          : `AskUserQuestion handler error: ${err}`;

      return { behavior: "deny", message };
    }
  }

  function getDecisions(): Decision[] {
    return [...decisions];
  }

  return { canUseTool, getDecisions };
}

function writeDecisionLog(path: string, decision: Decision): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(decision) + "\n", "utf-8");
  } catch {
    // Non-fatal
  }
}

function writeEscalatedLog(
  path: string | undefined,
  decision: Decision,
  oracleResult: OracleOutput,
): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const record = {
      ...decision,
      oracleChoice: oracleResult.choice,
      oracleConfidence: oracleResult.confidence,
      oracleRationale: oracleResult.rationale,
      escalateReason: oracleResult.isTaste ? "taste_decision" : "security_concern",
    };
    appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // Non-fatal
  }
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
