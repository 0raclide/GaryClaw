/**
 * Ask handler — canUseTool callback for AskUserQuestion interception.
 *
 * Phase 1a: Single-question passthrough to human via callback.
 * Phase 1b: Multi-question, multi-select, "Other" free text, decision logging.
 * Phase 2 (future): Route to Decision Oracle.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Decision, CanUseToolResult } from "./types.js";

export interface AskQuestion {
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface AskHandlerConfig {
  onAskUser: (
    question: string,
    options: { label: string; description: string }[],
    multiSelect: boolean,
  ) => Promise<string>;
  askTimeoutMs: number;
  sessionIndex: number;
  decisionLogPath?: string;
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
    // Pass through non-AskUserQuestion tools
    if (toolName !== "AskUserQuestion") {
      return { behavior: "allow" };
    }

    // Extract questions array
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
      // Answer all questions in the array
      const answers: Record<string, string> = {};

      for (const q of questions) {
        const questionText = q.question;
        const options = q.options ?? [];
        const multiSelect = q.multiSelect ?? false;

        const chosenLabel = await withTimeout(
          config.onAskUser(questionText, options, multiSelect),
          config.askTimeoutMs,
        );

        answers[questionText] = chosenLabel;

        // Record the decision
        const decision: Decision = {
          timestamp: new Date().toISOString(),
          sessionIndex: config.sessionIndex,
          question: questionText,
          options,
          chosen: chosenLabel,
          confidence: 10, // Human decision = max confidence
          rationale: "Human decision",
          principle: "Human override",
        };
        decisions.push(decision);

        // Write to audit log if configured
        if (config.decisionLogPath) {
          writeDecisionLog(config.decisionLogPath, decision);
        }
      }

      // Build updatedInput with pre-filled answers
      const updatedInput = {
        ...input,
        answers,
      };

      return { behavior: "allow", updatedInput };
    } catch (err) {
      // Timeout or error → deny the tool call
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
    // Non-fatal — don't crash on log write failure
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
