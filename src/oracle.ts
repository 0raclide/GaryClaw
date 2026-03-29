/**
 * Decision Oracle — auto-decides AskUserQuestion prompts using Claude API
 * and the 7 Decision Principles from /autoplan.
 *
 * Makes a single-turn SDK query per question. Returns structured decision
 * with confidence scoring and escalation detection.
 *
 * Phase 5a: Oracle memory injection — when OracleMemory is provided, taste.md,
 * domain-expertise.md, decision-outcomes.md, and MEMORY.md are injected into
 * the prompt between principles and recent decisions. When absent, existing
 * behavior is preserved (full backward compatibility).
 *
 * Oracle Decision Batching: When multiple questions arrive in a single
 * AskUserQuestion tool call, `askOracleBatch()` sends them all in one API
 * call instead of N serial calls, reducing latency by 50-70%.
 */

import type { Decision, OracleMemoryFiles, OracleSessionEvent } from "./types.js";
import { extractResultData } from "./sdk-wrapper.js";

// ── The 7 Decision Principles ───────────────────────────────────

export const DECISION_PRINCIPLES = `
1. **Choose completeness** — Ship the whole thing. Pick the approach that covers more edge cases.
2. **Boil lakes** — Fix everything in the blast radius. Auto-approve expansions that are in blast radius AND < 1 day CC effort.
3. **Pragmatic** — Two options fix the same thing? Pick the cleaner one. 5 seconds choosing, not 5 minutes.
4. **DRY** — Duplicates existing functionality? Reject. Reuse what exists.
5. **Explicit over clever** — 10-line obvious fix > 200-line abstraction.
6. **Bias toward action** — Merge > review cycles > stale deliberation. Flag concerns but don't block.
7. **Local evidence trumps general knowledge** — If we tried X and it failed, prefer alternatives even if X is theoretically SOTA. decision-outcomes.md takes precedence over domain-expertise.md.

Conflict resolution hierarchy:
- CEO phases → P1 > P2 > P7 > P3 > P5 > P4 > P6
- Eng phases → P5 > P7 > P3 > P1 > P4 > P2 > P6
- Design phases → P5 > P1 > P7 > P3 > P2 > P4 > P6
`.trim();

// ── Types ───────────────────────────────────────────────────────

export interface OraclePromptPrefixInput {
  skillName: string;
  projectContext?: string;
  memory?: OracleMemoryFiles;
  decisionHistory: Decision[];
}

export interface OracleInput {
  question: string;
  options: { label: string; description: string }[];
  skillName: string;
  decisionHistory: Decision[];
  projectContext?: string;
  memory?: OracleMemoryFiles;
}

export interface OracleOutput {
  choice: string;
  confidence: number;
  rationale: string;
  principle: string;
  /**
   * True when `confidence < escalateThreshold` (default threshold: 6).
   * Indicates a low-confidence "taste" decision — the Oracle isn't sure
   * which option is best, as opposed to a security/destructive escalation.
   * Used to classify escalation reasons in audit logs:
   *   `true`  → "taste_decision"
   *   `false` → "security_concern"
   */
  isTaste: boolean;
  escalate: boolean;
  otherProposal?: string;
}

export interface OracleConfig {
  queryFn: (prompt: string) => Promise<string>;
  escalateThreshold: number; // Confidence below this → escalate (default: 6)
}

// ── Batch types ────────────────────────────────────────────────

export interface OracleBatchQuestion {
  id: number;                                          // 1-indexed question number
  question: string;
  options: { label: string; description: string }[];
}

export interface OracleBatchInput {
  questions: OracleBatchQuestion[];
  skillName: string;
  decisionHistory: Decision[];
  projectContext?: string;
  memory?: OracleMemoryFiles;
}

// ── Security/destructive phrases for escalation ────────────────
// Phase 4b: Narrowed from broad keywords to specific phrases to reduce
// false positives (e.g. "token tracking" or "remove unused import").

export const ESCALATION_PHRASES = [
  "delete", "drop", "destroy", "force push", "reset --hard",
  "remove database", "remove user", "remove account", "delete permanently",
  "production", "deploy", "secret", "credential", "password",
  "api token", "auth token", "secret token", "access token",
  "api key", "security", "vulnerability", "permission", "admin",
  "billing", "payment", "user data", "pii", "gdpr",
];

// ── Oracle ──────────────────────────────────────────────────────

/**
 * Ask the oracle to decide on an AskUserQuestion.
 */
export async function askOracle(
  input: OracleInput,
  config: OracleConfig,
): Promise<OracleOutput> {
  const prompt = buildOraclePrompt(input);

  let rawResponse: string;
  try {
    rawResponse = await config.queryFn(prompt);
  } catch (err) {
    // Oracle call failed — return low-confidence escalation
    return {
      choice: input.options[0]?.label ?? "Unknown",
      confidence: 1,
      rationale: `Oracle call failed: ${err instanceof Error ? err.message : String(err)}`,
      principle: "Bias toward action",
      isTaste: true,
      escalate: true,
    };
  }

  const parsed = parseOracleResponse(rawResponse, input.options);

  // Check for security/destructive escalation
  const securityEscalate = shouldEscalateForSecurity(
    input.question,
    input.options,
  );

  const escalate =
    securityEscalate || parsed.confidence < config.escalateThreshold;

  return {
    ...parsed,
    isTaste: parsed.confidence < config.escalateThreshold,
    escalate,
  };
}

/**
 * Build the shared prompt prefix used by both single and batch oracle prompts.
 * Contains: system preamble, Decision Principles, Current Context, Oracle Memory, Recent Decisions.
 */
export function buildOraclePromptPrefix(input: OraclePromptPrefixInput): string {
  let prompt = `You are a decision-making oracle for GaryClaw, an autonomous development tool.

## Decision Principles
${DECISION_PRINCIPLES}

## Current Context
- Skill: /${input.skillName}
${input.projectContext ? `- Project: ${input.projectContext.slice(0, 500)}` : ""}

`;

  // Inject oracle memory between principles and recent decisions
  if (input.memory) {
    const { taste, domainExpertise, decisionOutcomes, memoryMd } = input.memory;

    if (taste) {
      prompt += `## Taste Profile (personal preferences)\n${taste}\n\n`;
    }

    if (domainExpertise) {
      prompt += `## Domain Expertise (researched knowledge)\n${domainExpertise}\n\n`;
    }

    if (decisionOutcomes) {
      prompt += `## Decision Outcomes (what worked and what didn't — P7 applies here)\n${decisionOutcomes}\n\n`;
    }

    if (memoryMd) {
      prompt += `## Project Memory (MEMORY.md)\n${memoryMd}\n\n`;
    }
  }

  if (input.decisionHistory.length > 0) {
    const recent = input.decisionHistory.slice(-5);
    prompt += `## Recent Decisions (last ${recent.length})\n`;
    for (const d of recent) {
      prompt += `- Q: "${d.question}" → A: "${d.chosen}" [${d.principle}]\n`;
    }
    prompt += "\n";
  }

  return prompt;
}

export function buildOraclePrompt(input: OracleInput): string {
  let prompt = buildOraclePromptPrefix(input);

  const hasOtherOption = input.options.some(
    (o) => o.label.toLowerCase() === "other",
  );

  prompt += `## Question
${input.question}

## Options
${input.options.map((o, i) => `${i + 1}. **${o.label}**: ${o.description}`).join("\n")}

## Instructions
Choose the best option using the Decision Principles above. Consider consistency with prior decisions.
${input.memory?.taste ? "Also consider the Taste Profile preferences above when they are relevant." : ""}

Respond with ONLY a JSON object (no markdown fences, no explanation outside the JSON):
{
  "choice": "<exact label of chosen option>",
  "confidence": <1-10>,
  "rationale": "<one sentence explaining why>",
  "principle": "<which of the 7 principles drove this decision>"${hasOtherOption ? `,
  "otherProposal": "<if choice is 'Other', provide a detailed free-text proposal here>"` : ""}
}`;

  return prompt;
}

// ── Session reuse constants ──────────────────────────────────────

/** Shared constant — must match the heading in buildOraclePrompt(). */
export const ORACLE_QUESTION_MARKER = "## Question\n";

/** Batch prompt marker — used to detect batch calls that bypass session reuse. */
export const ORACLE_BATCH_MARKER = "## Questions";

/** Maximum number of Oracle calls before resetting the session to bound context growth. */
export const MAX_REUSE = 25;

/**
 * Build a resume prompt by stripping the prefix (principles/memory/context/history)
 * and keeping only the question + options + format instructions.
 *
 * On resume, the prefix is already in the session context from the first call.
 * This avoids duplication and keeps the resume prompt at ~700 tokens.
 */
export function buildResumePrompt(fullPrompt: string): string {
  const idx = fullPrompt.indexOf(ORACLE_QUESTION_MARKER);
  if (idx === -1) {
    // Can't find the question section — send the full prompt (safe fallback).
    // This is invisible but safe: the model just gets a redundant prefix.
    return fullPrompt;
  }
  return "New decision needed:\n\n" + fullPrompt.slice(idx);
}

// ── Session state machine ────────────────────────────────────────

/** Action returned by OracleSessionState methods to drive the caller's loop. */
export type SessionAction =
  | { action: "return"; result: string }
  | { action: "retry" }
  | { action: "throw"; error: Error };

/**
 * Pure state machine for oracle session reuse. Separated from the SDK call
 * so all state transitions (batch reset, MAX_REUSE, resume fallback, retry)
 * are testable without importing the SDK.
 *
 * Usage:
 * ```
 *   const state = new OracleSessionState(onEvent);
 *   const { effectivePrompt, isResume, resumeSessionId } = state.prepareCall(prompt);
 *   // ... SDK call ...
 *   const action = state.handleSuccess(result, newSessionId);
 *   // or: const action = state.handleError(err);
 * ```
 */
export class OracleSessionState {
  sessionId: string | null = null;
  callCount = 0;
  private retried = false;
  private currentIsResume = false;

  constructor(
    private onSessionEvent?: (event: OracleSessionEvent) => void,
  ) {}

  /**
   * Prepare for a query call. Handles batch detection, MAX_REUSE reset,
   * and decides whether to resume or cold-start.
   */
  prepareCall(prompt: string): {
    effectivePrompt: string;
    isResume: boolean;
    resumeSessionId: string | null;
  } {
    this.retried = false;

    // Batch calls bypass session reuse — different prompt structure
    if (prompt.includes(ORACLE_BATCH_MARKER) && this.sessionId !== null) {
      this.sessionId = null;
      this.callCount = 0;
      this.onSessionEvent?.({ type: "session_reset", callCount: 0, sessionId: undefined });
    }

    // Reset session periodically to bound context growth
    if (this.callCount >= MAX_REUSE) {
      this.onSessionEvent?.({ type: "session_reset", callCount: this.callCount, sessionId: this.sessionId ?? undefined });
      this.sessionId = null;
      this.callCount = 0;
    }

    const isResume = this.sessionId !== null;
    this.currentIsResume = isResume;
    const effectivePrompt = isResume ? buildResumePrompt(prompt) : prompt;

    return { effectivePrompt, isResume, resumeSessionId: isResume ? this.sessionId : null };
  }

  /**
   * Handle a successful SDK call. Returns whether to return the result or retry.
   */
  handleSuccess(result: string, newSessionId: string | null): SessionAction {
    if (result && newSessionId) {
      if (this.currentIsResume) {
        this.onSessionEvent?.({ type: "session_resumed", callCount: this.callCount + 1, sessionId: newSessionId });
      } else {
        this.onSessionEvent?.({ type: "session_created", callCount: 1, sessionId: newSessionId });
      }
      this.sessionId = newSessionId;
      this.callCount++;
      return { action: "return", result };
    }

    if (this.currentIsResume && !this.retried) {
      // Resume produced no result — reset and retry cold
      this.onSessionEvent?.({ type: "resume_fallback", callCount: this.callCount, sessionId: this.sessionId ?? undefined });
      this.sessionId = null;
      this.callCount = 0;
      this.retried = true;
      this.currentIsResume = false;
      return { action: "retry" };
    }

    // Cold start with no result — return empty
    return { action: "return", result };
  }

  /**
   * Handle an SDK error. Returns whether to retry cold or throw.
   */
  handleError(err: unknown): SessionAction {
    if (this.currentIsResume && !this.retried) {
      // Resume error — reset and retry cold
      this.onSessionEvent?.({ type: "resume_fallback", callCount: this.callCount, sessionId: this.sessionId ?? undefined });
      this.sessionId = null;
      this.callCount = 0;
      this.retried = true;
      this.currentIsResume = false;
      return { action: "retry" };
    }

    // Cold start also failed — propagate original error for diagnostics
    const error = err instanceof Error
      ? err
      : new Error(`Oracle query failed: ${String(err)}`);
    return { action: "throw", error };
  }
}

/**
 * Extract the 5 standard oracle fields from a parsed JSON entry.
 * Shared by parseOracleResponse and parseBatchOracleResponse to keep
 * field extraction logic in one place.
 */
export function extractOracleFields(
  entry: Record<string, unknown>,
  options: { label: string; description: string }[],
): Omit<OracleOutput, "isTaste" | "escalate"> {
  const choice = resolveChoice(entry.choice, options);
  const confidence = Math.max(1, Math.min(10, Number(entry.confidence) || 5));
  const rationale = typeof entry.rationale === "string" ? entry.rationale : "No rationale provided";
  const principle = typeof entry.principle === "string" ? entry.principle : "Bias toward action";

  const otherProposal =
    choice.toLowerCase() === "other" && typeof entry.otherProposal === "string"
      ? entry.otherProposal
      : undefined;

  return { choice, confidence, rationale, principle, otherProposal };
}

export function parseOracleResponse(
  raw: string,
  options: { label: string; description: string }[],
): Omit<OracleOutput, "isTaste" | "escalate"> {
  // Try to extract JSON from the response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return fallbackChoice(options, "Could not parse oracle response as JSON");
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return extractOracleFields(parsed, options);
  } catch {
    return fallbackChoice(options, "JSON parse error in oracle response");
  }
}

/**
 * Match the oracle's choice to an actual option label.
 * Handles exact match, case-insensitive match, and fuzzy partial match.
 */
function resolveChoice(
  choice: unknown,
  options: { label: string; description: string }[],
): string {
  if (typeof choice !== "string" || !choice) {
    return options[0]?.label ?? "Unknown";
  }

  // Exact match
  const exact = options.find((o) => o.label === choice);
  if (exact) return exact.label;

  // Case-insensitive match
  const lower = choice.toLowerCase();
  const caseMatch = options.find((o) => o.label.toLowerCase() === lower);
  if (caseMatch) return caseMatch.label;

  // Partial match (oracle said something like "Standard (Recommended)")
  const partial = options.find(
    (o) => lower.includes(o.label.toLowerCase()) || o.label.toLowerCase().includes(lower),
  );
  if (partial) return partial.label;

  // No match — return first option
  return options[0]?.label ?? choice;
}

function fallbackChoice(
  options: { label: string; description: string }[],
  reason: string,
): Omit<OracleOutput, "isTaste" | "escalate"> {
  // Pick the option marked "(Recommended)" if any, otherwise first
  const recommended = options.find((o) =>
    o.label.includes("(Recommended)") || o.description.includes("(Recommended)"),
  );
  return {
    choice: recommended?.label ?? options[0]?.label ?? "Unknown",
    confidence: 3,
    rationale: reason,
    principle: "Bias toward action",
  };
}

/**
 * Build word-boundary regex for an escalation phrase.
 * Uses \b for word chars; for phrases containing special regex chars
 * like "--", escapes them and uses lookaround-free boundary matching.
 */
function phraseToRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

function shouldEscalateForSecurity(
  question: string,
  options: { label: string; description: string }[],
): boolean {
  const text = [
    question,
    ...options.map((o) => `${o.label} ${o.description}`),
  ]
    .join(" ")
    .toLowerCase();

  return ESCALATION_PHRASES.some((phrase) => phraseToRegex(phrase).test(text));
}

// ── Batch Oracle ────────────────────────────────────────────────

/**
 * Ask the oracle to decide on multiple questions in a single API call.
 * Falls back to serial `askOracle()` if batch parsing fails.
 *
 * For a single question, delegates directly to `askOracle()` (no batch overhead).
 */
export async function askOracleBatch(
  input: OracleBatchInput,
  config: OracleConfig,
  onWarn?: (msg: string) => void,
): Promise<OracleOutput[]> {
  // Single question: no batching overhead, delegate to askOracle
  if (input.questions.length === 0) return [];
  if (input.questions.length === 1) {
    const q = input.questions[0];
    const result = await askOracle(
      {
        question: q.question,
        options: q.options,
        skillName: input.skillName,
        decisionHistory: input.decisionHistory,
        projectContext: input.projectContext,
        memory: input.memory,
      },
      config,
    );
    return [result];
  }

  // Multiple questions: batch into one API call
  const prompt = buildBatchOraclePrompt(input);

  let rawResponse: string;
  try {
    rawResponse = await config.queryFn(prompt);
  } catch (err) {
    // Batch call failed — return low-confidence escalation for all questions
    return input.questions.map((q) => ({
      choice: q.options[0]?.label ?? "Unknown",
      confidence: 1,
      rationale: `Oracle batch call failed: ${err instanceof Error ? err.message : String(err)}`,
      principle: "Bias toward action",
      isTaste: true,
      escalate: true,
    }));
  }

  const parsedAnswers = parseBatchOracleResponse(rawResponse, input.questions, onWarn);

  // Apply escalation logic per question (same as single askOracle)
  return parsedAnswers.map((parsed, i) => {
    const q = input.questions[i];
    const securityEscalate = shouldEscalateForSecurity(q.question, q.options);
    const escalate = securityEscalate || parsed.confidence < config.escalateThreshold;

    return {
      ...parsed,
      isTaste: parsed.confidence < config.escalateThreshold,
      escalate,
    };
  });
}

export function buildBatchOraclePrompt(input: OracleBatchInput): string {
  let prompt = buildOraclePromptPrefix(input);

  // List all questions
  prompt += `## Questions (answer ALL ${input.questions.length} questions)\n\n`;

  for (const q of input.questions) {
    const hasOtherOption = q.options.some(
      (o) => o.label.toLowerCase() === "other",
    );

    prompt += `### Question ${q.id}\n${q.question}\n\nOptions:\n`;
    prompt += q.options.map((o, i) => `${i + 1}. **${o.label}**: ${o.description}`).join("\n");
    prompt += "\n";
    if (hasOtherOption) {
      prompt += `(If choosing "Other" for Q${q.id}, include an "otherProposal" field)\n`;
    }
    prompt += "\n";
  }

  const hasTaste = input.memory?.taste;

  prompt += `## Instructions
Answer ALL ${input.questions.length} questions using the Decision Principles above. Consider consistency across answers.
${hasTaste ? "Also consider the Taste Profile preferences above when they are relevant." : ""}

Respond with ONLY a JSON array (no markdown fences, no explanation outside the JSON).
Each element corresponds to one question, in order:
[
  {
    "questionId": 1,
    "choice": "<exact label of chosen option>",
    "confidence": <1-10>,
    "rationale": "<one sentence explaining why>",
    "principle": "<which of the 7 principles drove this decision>"
  },
  ...
]`;

  return prompt;
}

/**
 * Parse a batch oracle response — expects a JSON array of answers.
 * Falls back to individual `parseOracleResponse()` attempts if the
 * array doesn't match, and ultimately to fallback choices.
 */
export function parseBatchOracleResponse(
  raw: string,
  questions: OracleBatchQuestion[],
  onWarn?: (msg: string) => void,
): Array<Omit<OracleOutput, "isTaste" | "escalate">> {
  const warn = onWarn ?? console.warn;

  // Try to extract a JSON array
  const arrayMatch = raw.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed) && parsed.length >= questions.length) {
        return questions.map((q, i) => {
          const entry = parsed[i];
          return extractOracleFields(entry ?? {}, q.options);
        });
      }
      // Array parsed but wrong length
      warn(
        `[oracle-batch] JSON array parsed but length mismatch: expected ${questions.length}, got ${Array.isArray(parsed) ? parsed.length : "non-array"}. Falling back to individual JSON extraction.`,
      );
    } catch {
      warn(
        `[oracle-batch] JSON array parse failed. Falling back to individual JSON extraction.`,
      );
    }
  }

  // Fallback: try to find individual JSON objects in the response
  const jsonObjects = raw.match(/\{[^{}]*\}/g);
  if (jsonObjects && jsonObjects.length >= questions.length) {
    warn(
      `[oracle-batch] Using individual JSON object fallback: found ${jsonObjects.length} objects for ${questions.length} questions.`,
    );
    return questions.map((q, i) => {
      return parseOracleResponse(jsonObjects[i], q.options);
    });
  }

  // Complete fallback: return fallback choices for all questions
  warn(
    `[oracle-batch] Complete fallback: no parseable JSON for ${questions.length} questions. Returning default choices.`,
  );
  return questions.map((q) => fallbackChoice(q.options, "Could not parse batch oracle response"));
}

/**
 * Create an oracle query function that uses the SDK.
 *
 * **Session reuse:** The first call creates a fresh SDK session with the full
 * oracle prompt (~43K tokens). Subsequent calls resume the same session with
 * only the question portion (~700 tokens), cutting input token cost by ~95%
 * for decisions 2-N. The session is reset after MAX_REUSE calls to bound
 * context growth, or when resume fails (graceful fallback to cold start).
 *
 * Batch calls (containing ORACLE_BATCH_MARKER) bypass session reuse and
 * always start fresh, since batch prompts have a structurally different
 * format that would confuse a resumed single-question session.
 *
 * @param env - Environment variables for SDK (ANTHROPIC_API_KEY stripped)
 * @param onSessionEvent - Optional callback for observability (session lifecycle events)
 */
export function createSdkOracleQueryFn(
  env: Record<string, string>,
  onSessionEvent?: (event: OracleSessionEvent) => void,
): (prompt: string) => Promise<string> {
  const state = new OracleSessionState(onSessionEvent);

  return async (prompt: string): Promise<string> => {
    // Dynamic import to avoid loading SDK in tests
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // prepareCall handles batch detection, MAX_REUSE reset, resume decision
    let { effectivePrompt, isResume, resumeSessionId } = state.prepareCall(prompt);

    while (true) {
      let result = "";
      let newSessionId: string | null = null;

      try {
        const gen = query({
          prompt: effectivePrompt,
          options: {
            maxTurns: 1,
            env,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            canUseTool: async (_toolName: string, _input: Record<string, unknown>, _options: { signal: AbortSignal }) => ({ behavior: "deny" as const, message: "Oracle sub-query does not allow tool use" }),
            ...(isResume && resumeSessionId ? { resume: resumeSessionId } : {}),
          },
        });

        for await (const msg of gen) {
          if (msg.type === "result") {
            const resultData = extractResultData(msg);
            if (resultData) {
              newSessionId = resultData.sessionId || null;
              if (resultData.subtype === "success") {
                result = resultData.resultText;
              }
            }
          }
        }

        const action = state.handleSuccess(result, newSessionId);
        if (action.action === "return") return action.result;
        // Retry cold: session was reset by handleSuccess, use full prompt
        effectivePrompt = prompt;
        isResume = false;
        resumeSessionId = null;
        continue;
      } catch (err) {
        const action = state.handleError(err);
        if (action.action === "retry") {
          // Retry cold: session was reset by handleError, use full prompt
          effectivePrompt = prompt;
          isResume = false;
          resumeSessionId = null;
          continue;
        }
        if (action.action === "throw") throw action.error;
        // "return" should not happen in catch path, but satisfy TS narrowing
        throw err;
      }
    }
  };
}
