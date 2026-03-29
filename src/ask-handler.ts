/**
 * Ask handler — canUseTool callback for AskUserQuestion interception.
 *
 * Two modes:
 * - Human mode (default): prompts user via onAskUser callback
 * - Autonomous mode: routes to Decision Oracle, with escalation fallback
 *
 * Oracle Decision Batching: When multiple questions arrive in a single
 * AskUserQuestion tool call in autonomous mode, they are batched into
 * a single Oracle API call via askOracleBatch() instead of N serial calls.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveWarnFn } from "./types.js";
import type { Decision, CanUseToolResult, OracleMemoryFiles, WarnFn } from "./types.js";
import type { OracleOutput, OracleConfig, OracleInput, OracleBatchInput, OracleBatchQuestion } from "./oracle.js";

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
    askOracleBatch?: (input: OracleBatchInput, config: OracleConfig, onWarn?: (msg: string) => void) => Promise<OracleOutput[]>;
    config: OracleConfig;
    skillName: string;
    projectContext?: string;
    memory?: OracleMemoryFiles;
  };
  escalatedLogPath?: string;

  // Optional warning callback (routes warnings to event system in daemon mode)
  onWarn?: (msg: string) => void;
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
  const warn = resolveWarnFn(config.onWarn);

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

      if (config.autonomous && config.oracle) {
        // Oracle mode — batch all questions into one API call when possible
        await handleOracleBatch(questions, answers, decisions, config);
      } else {
        // Human mode — serial (each question prompted individually)
        for (const q of questions) {
          const questionText = q.question;
          const options = q.options ?? [];
          const multiSelect = q.multiSelect ?? false;

          const chosenLabel = await withTimeout(
            config.onAskUser(questionText, options, multiSelect),
            config.askTimeoutMs,
          );

          const decision: Decision = {
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
          decisions.push(decision);

          if (config.decisionLogPath) {
            writeDecisionLog(config.decisionLogPath, decision, warn);
          }
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

/**
 * Handle Oracle decisions for all questions — uses batching when available
 * and multiple questions arrive, falls back to serial for single question
 * or when askOracleBatch is not provided.
 */
async function handleOracleBatch(
  questions: Array<{
    question: string;
    header?: string;
    options: { label: string; description: string }[];
    multiSelect?: boolean;
  }>,
  answers: Record<string, string>,
  decisions: Decision[],
  config: AskHandlerConfig,
): Promise<void> {
  const oracle = config.oracle!;

  // Use batching when: batch function available AND multiple questions
  if (oracle.askOracleBatch && questions.length > 1) {
    const batchQuestions: OracleBatchQuestion[] = questions.map((q, i) => ({
      id: i + 1,
      question: q.question,
      options: q.options ?? [],
    }));

    const batchInput: OracleBatchInput = {
      questions: batchQuestions,
      skillName: oracle.skillName,
      // Snapshot: all batch questions arrive simultaneously, so they all see the
      // same history frozen at this point. The serial path below passes the mutable
      // `decisions` array instead, so each question sees decisions from prior questions
      // in the same canUseTool call. Both behaviors are intentional.
      decisionHistory: [...decisions],
      projectContext: oracle.projectContext,
      memory: oracle.memory,
    };

    const batchResults = await oracle.askOracleBatch(batchInput, oracle.config, config.onWarn);

    // Process each result — guard against length mismatch from partial parse failures
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const oracleResult = batchResults[i] ?? {
        choice: q.options[0]?.label ?? "Unknown",
        confidence: 1,
        rationale: "Batch result missing for this question (length mismatch)",
        principle: "Bias toward action",
        isTaste: true,
        escalate: true,
      };
      processOracleResult(q, oracleResult, answers, decisions, config);
    }
  } else {
    // Serial fallback: single question or no batch function.
    // Unlike the batch path above, we pass the mutable `decisions` array so each
    // question accumulates context from prior questions in this same call.
    for (const q of questions) {
      const oracleResult = await oracle.askOracle(
        {
          question: q.question,
          options: q.options ?? [],
          skillName: oracle.skillName,
          decisionHistory: decisions,
          projectContext: oracle.projectContext,
          memory: oracle.memory,
        },
        oracle.config,
      );

      processOracleResult(q, oracleResult, answers, decisions, config);
    }
  }
}

/**
 * Process a single oracle result: build decision, write logs, populate answers.
 */
function processOracleResult(
  q: {
    question: string;
    options: { label: string; description: string }[];
    multiSelect?: boolean;
  },
  oracleResult: OracleOutput,
  answers: Record<string, string>,
  decisions: Decision[],
  config: AskHandlerConfig,
): void {
  const questionText = q.question;
  const options = q.options ?? [];

  // When oracle chooses "Other" with a proposal, use the proposal as
  // the free-text answer so the skill sees custom input, not just "Other".
  const answerText =
    oracleResult.choice.toLowerCase() === "other" && oracleResult.otherProposal
      ? oracleResult.otherProposal
      : oracleResult.choice;

  const decision: Decision = {
    timestamp: new Date().toISOString(),
    sessionIndex: config.sessionIndex,
    question: questionText,
    options,
    chosen: oracleResult.choice,
    confidence: oracleResult.confidence,
    rationale: oracleResult.rationale,
    principle: oracleResult.principle,
  };

  // Escalation: log to escalated.jsonl for audit trail.
  const processWarn = resolveWarnFn(config.onWarn);
  if (oracleResult.escalate) {
    writeEscalatedLog(config.escalatedLogPath, decision, oracleResult, processWarn);
  }

  answers[questionText] = answerText;
  decisions.push(decision);

  if (config.decisionLogPath) {
    writeDecisionLog(config.decisionLogPath, decision, processWarn);
  }
}

function writeDecisionLog(path: string, decision: Decision, warn: WarnFn): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(decision) + "\n", "utf-8");
  } catch (err) {
    // Non-fatal but warn — lost audit trail is worth knowing about
    warn(`[GaryClaw] Failed to write decision log: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeEscalatedLog(
  path: string | undefined,
  decision: Decision,
  oracleResult: OracleOutput,
  warn: WarnFn,
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
  } catch (err) {
    // Non-fatal but warn — lost escalation trail is worth knowing about
    warn(`[GaryClaw] Failed to write escalated log: ${err instanceof Error ? err.message : String(err)}`);
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
