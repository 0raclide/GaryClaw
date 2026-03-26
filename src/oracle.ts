/**
 * Decision Oracle — auto-decides AskUserQuestion prompts using Claude API
 * and the 6 Decision Principles from /autoplan.
 *
 * Makes a single-turn SDK query per question. Returns structured decision
 * with confidence scoring and escalation detection.
 */

import type { Decision } from "./types.js";

// ── The 6 Decision Principles ───────────────────────────────────

export const DECISION_PRINCIPLES = `
1. **Choose completeness** — Ship the whole thing. Pick the approach that covers more edge cases.
2. **Boil lakes** — Fix everything in the blast radius. Auto-approve expansions that are in blast radius AND < 1 day CC effort.
3. **Pragmatic** — Two options fix the same thing? Pick the cleaner one. 5 seconds choosing, not 5 minutes.
4. **DRY** — Duplicates existing functionality? Reject. Reuse what exists.
5. **Explicit over clever** — 10-line obvious fix > 200-line abstraction.
6. **Bias toward action** — Merge > review cycles > stale deliberation. Flag concerns but don't block.

Conflict resolution: CEO phases → P1+P2 dominate. Eng phases → P5+P3 dominate. Design phases → P5+P1 dominate.
`.trim();

// ── Types ───────────────────────────────────────────────────────

export interface OracleInput {
  question: string;
  options: { label: string; description: string }[];
  skillName: string;
  decisionHistory: Decision[];
  projectContext?: string;
}

export interface OracleOutput {
  choice: string;
  confidence: number;
  rationale: string;
  principle: string;
  isTaste: boolean;
  escalate: boolean;
}

export interface OracleConfig {
  queryFn: (prompt: string) => Promise<string>;
  escalateThreshold: number; // Confidence below this → escalate (default: 6)
}

// ── Security/destructive keywords for escalation ────────────────

const ESCALATION_KEYWORDS = [
  "delete", "drop", "remove", "destroy", "force push", "reset --hard",
  "production", "deploy", "secret", "credential", "password", "token",
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

function buildOraclePrompt(input: OracleInput): string {
  let prompt = `You are a decision-making oracle for GaryClaw, an autonomous development tool.

## Decision Principles
${DECISION_PRINCIPLES}

## Current Context
- Skill: /${input.skillName}
${input.projectContext ? `- Project: ${input.projectContext.slice(0, 500)}` : ""}

`;

  if (input.decisionHistory.length > 0) {
    const recent = input.decisionHistory.slice(-5);
    prompt += `## Recent Decisions (last ${recent.length})\n`;
    for (const d of recent) {
      prompt += `- Q: "${d.question}" → A: "${d.chosen}" [${d.principle}]\n`;
    }
    prompt += "\n";
  }

  prompt += `## Question
${input.question}

## Options
${input.options.map((o, i) => `${i + 1}. **${o.label}**: ${o.description}`).join("\n")}

## Instructions
Choose the best option using the Decision Principles above. Consider consistency with prior decisions.

Respond with ONLY a JSON object (no markdown fences, no explanation outside the JSON):
{
  "choice": "<exact label of chosen option>",
  "confidence": <1-10>,
  "rationale": "<one sentence explaining why>",
  "principle": "<which of the 6 principles drove this decision>"
}`;

  return prompt;
}

function parseOracleResponse(
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
    const choice = resolveChoice(parsed.choice, options);
    const confidence = Math.max(1, Math.min(10, Number(parsed.confidence) || 5));
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "No rationale provided";
    const principle = typeof parsed.principle === "string" ? parsed.principle : "Bias toward action";

    return { choice, confidence, rationale, principle };
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

  return ESCALATION_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * Create an oracle query function that uses the SDK.
 * This wraps a simple 1-turn query.
 */
export function createSdkOracleQueryFn(
  env: Record<string, string>,
): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    // Dynamic import to avoid loading SDK in tests
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    let result = "";
    const gen = query({
      prompt,
      options: {
        maxTurns: 1,
        env,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        canUseTool: async (_toolName: string, _input: Record<string, unknown>, _options: { signal: AbortSignal }) => ({ behavior: "deny" as const, message: "Oracle sub-query does not allow tool use" }),
      },
    });

    for await (const msg of gen) {
      if (msg.type === "result" && (msg as any).subtype === "success") {
        result = (msg as any).result ?? "";
      }
    }

    return result;
  };
}
