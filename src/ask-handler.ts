/**
 * Ask handler — canUseTool callback for AskUserQuestion interception.
 *
 * Phase 1a: Passthrough to human via onAskUser callback.
 * Phase 2 (future): Route to Decision Oracle.
 */

import type { Decision, CanUseToolResult } from "./types.js";

export interface AskHandlerConfig {
  onAskUser: (
    question: string,
    options: { label: string; description: string }[],
  ) => Promise<string>;
  askTimeoutMs: number;
  sessionIndex: number;
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

    // Extract question and options from AskUserQuestion input
    const questions = input.questions as
      | Array<{
          question: string;
          options: { label: string; description: string }[];
          multiSelect?: boolean;
        }>
      | undefined;

    if (!questions || questions.length === 0) {
      return { behavior: "allow" };
    }

    const q = questions[0];
    const questionText = q.question;
    const options = q.options ?? [];

    try {
      // Call the human/oracle with timeout
      const chosenLabel = await withTimeout(
        config.onAskUser(questionText, options),
        config.askTimeoutMs,
      );

      // Record the decision
      decisions.push({
        timestamp: new Date().toISOString(),
        sessionIndex: config.sessionIndex,
        question: questionText,
        options,
        chosen: chosenLabel,
        confidence: 10, // Human decision = max confidence
        rationale: "Human decision",
        principle: "Human override",
      });

      // Build updatedInput with pre-filled answer
      const updatedInput = {
        ...input,
        answers: {
          [questionText]: chosenLabel,
        },
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
