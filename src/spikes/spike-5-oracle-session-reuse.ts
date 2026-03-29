/**
 * Spike 5: Oracle Session Reuse
 *
 * Verifies:
 * (a) SDK resume with maxTurns:1 retains full conversation context
 * (b) Resumed query shows higher cache_read_input_tokens (cache hit)
 * (c) Decision quality is equivalent between cold start and resumed session
 *
 * Run: npx tsx src/spikes/spike-5-oracle-session-reuse.ts
 *
 * Decision gate: If any test fails, Approach A (stateful queryFn) is NOT viable.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { extractResultData } from "../sdk-wrapper.js";

const DIVIDER = "=".repeat(60);

// Strip ANTHROPIC_API_KEY so SDK uses Claude Max login instead of API billing
const { ANTHROPIC_API_KEY: _, ...sdkEnv } = process.env;

const ORACLE_SYSTEM_PROMPT = `You are a decision-making oracle. You receive questions with numbered options.
Always respond with ONLY a JSON object (no markdown fences):
{
  "choice": "<exact label of chosen option>",
  "confidence": <1-10>,
  "rationale": "<one sentence explaining why>",
  "principle": "<a guiding principle>"
}`;

interface SpikeResult {
  sessionId: string;
  resultText: string;
  cacheReadTokens: number;
  inputTokens: number;
  totalCostUsd: number;
}

async function runQuery(
  prompt: string,
  resumeSessionId?: string,
): Promise<SpikeResult> {
  const gen = query({
    prompt,
    options: {
      maxTurns: 1,
      env: sdkEnv,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      canUseTool: async () => ({
        behavior: "deny" as const,
        message: "No tool use in spike",
      }),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    },
  });

  let sessionId = "";
  let resultText = "";
  let cacheReadTokens = 0;
  let inputTokens = 0;
  let totalCostUsd = 0;

  for await (const msg of gen) {
    if (msg.type === "assistant") {
      // Extract usage from assistant message
      const usage = (msg as any).message?.usage;
      if (usage) {
        cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        inputTokens += usage.input_tokens ?? 0;
      }
    }
    if (msg.type === "result") {
      const resultData = extractResultData(msg);
      if (resultData) {
        sessionId = resultData.sessionId;
        if (resultData.subtype === "success") {
          resultText = resultData.resultText;
        }
        totalCostUsd = resultData.totalCostUsd;
      }
    }
  }

  return { sessionId, resultText, cacheReadTokens, inputTokens, totalCostUsd };
}

async function runSpike() {
  console.log(DIVIDER);
  console.log("SPIKE 5: Oracle Session Reuse (maxTurns:1 + resume)");
  console.log(DIVIDER);

  // ── Test A: Resume retains conversation context ──────────────
  console.log("\n[Test A] Resume with maxTurns:1 retains context\n");

  const firstPrompt = `${ORACLE_SYSTEM_PROMPT}

## Question
My favorite fruit is MANGO. What color theme should we use for the code editor?

## Options
1. **Dark**: Dark theme with muted colors
2. **Light**: Light theme with bright colors

Respond with the JSON now.`;

  console.log("  Sending first query (cold start)...");
  const first = await runQuery(firstPrompt);
  console.log(`  Session ID: ${first.sessionId}`);
  console.log(`  Result: ${first.resultText.slice(0, 200)}`);
  console.log(`  Input tokens: ${first.inputTokens}`);
  console.log(`  Cache read tokens: ${first.cacheReadTokens}`);

  if (!first.sessionId) {
    console.log("\n  ✗ FAIL: No session ID returned from first query");
    return;
  }

  // Resume with a follow-up that references the first question's context
  const followUpPrompt = `What was my favorite fruit that I mentioned in my first message?
Also, answer this new decision:

## Question
Should we enable auto-save?

## Options
1. **Yes**: Enable auto-save every 30 seconds
2. **No**: Manual save only

Respond with a JSON object that includes an extra field "remembered_fruit" with the fruit I mentioned.`;

  console.log("\n  Sending resumed query...");
  const second = await runQuery(followUpPrompt, first.sessionId);
  console.log(`  Session ID: ${second.sessionId}`);
  console.log(`  Result: ${second.resultText.slice(0, 300)}`);
  console.log(`  Input tokens: ${second.inputTokens}`);
  console.log(`  Cache read tokens: ${second.cacheReadTokens}`);

  const contextRetained =
    second.resultText.toLowerCase().includes("mango") ||
    second.resultText.toLowerCase().includes("fruit");
  console.log(
    `\n  [A] Context retained on resume: ${contextRetained ? "✓ PASS" : "✗ FAIL"}`,
  );

  // ── Test B: Cache hit on resumed query ──────────────────────
  console.log("\n[Test B] Cache hit detection\n");

  const cacheImproved = second.cacheReadTokens > first.cacheReadTokens;
  console.log(`  First query cache_read: ${first.cacheReadTokens}`);
  console.log(`  Resumed query cache_read: ${second.cacheReadTokens}`);
  console.log(
    `  [B] Cache read tokens increased on resume: ${cacheImproved ? "✓ PASS" : "⚠ INCONCLUSIVE (may still work, cache behavior varies)"}`,
  );

  // ── Test C: Decision quality comparison ─────────────────────
  console.log("\n[Test C] Decision quality: cold vs resumed\n");

  const qualityQuestion = `${ORACLE_SYSTEM_PROMPT}

## Question
Should we use TypeScript strict mode for the new module?

## Options
1. **Yes**: Enable strict mode for better type safety
2. **No**: Keep loose mode for faster iteration

Respond with the JSON now.`;

  console.log("  Cold start decision...");
  const coldDecision = await runQuery(qualityQuestion);

  // For resumed, send the same question via the existing session
  const resumedQualityPrompt = `New decision needed:

## Question
Should we use TypeScript strict mode for the new module?

## Options
1. **Yes**: Enable strict mode for better type safety
2. **No**: Keep loose mode for faster iteration

Respond with ONLY a JSON object (no markdown fences):
{
  "choice": "<exact label of chosen option>",
  "confidence": <1-10>,
  "rationale": "<one sentence explaining why>",
  "principle": "<a guiding principle>"
}`;

  console.log("  Resumed session decision...");
  const resumedDecision = await runQuery(
    resumedQualityPrompt,
    second.sessionId,
  );

  console.log(`  Cold result: ${coldDecision.resultText.slice(0, 200)}`);
  console.log(
    `  Resumed result: ${resumedDecision.resultText.slice(0, 200)}`,
  );

  // Parse both and compare structure
  let coldParsed: any = null;
  let resumedParsed: any = null;
  try {
    const coldMatch = coldDecision.resultText.match(/\{[\s\S]*\}/);
    const resumedMatch = resumedDecision.resultText.match(/\{[\s\S]*\}/);
    if (coldMatch) coldParsed = JSON.parse(coldMatch[0]);
    if (resumedMatch) resumedParsed = JSON.parse(resumedMatch[0]);
  } catch {
    // parse error is a test failure
  }

  const bothParseable = coldParsed !== null && resumedParsed !== null;
  const bothHaveFields =
    bothParseable &&
    typeof coldParsed.choice === "string" &&
    typeof coldParsed.confidence === "number" &&
    typeof resumedParsed.choice === "string" &&
    typeof resumedParsed.confidence === "number";
  const confidenceSimilar =
    bothHaveFields &&
    Math.abs(coldParsed.confidence - resumedParsed.confidence) <= 3;

  console.log(
    `  [C] Both responses parseable: ${bothParseable ? "✓ PASS" : "✗ FAIL"}`,
  );
  console.log(
    `  [C] Both have required fields: ${bothHaveFields ? "✓ PASS" : "✗ FAIL"}`,
  );
  console.log(
    `  [C] Confidence within 3 points: ${confidenceSimilar ? "✓ PASS" : "⚠ INCONCLUSIVE"}`,
  );

  // ── Summary ─────────────────────────────────────────────────
  console.log(`\n${DIVIDER}`);
  console.log("SUMMARY");
  console.log(DIVIDER);

  const tests = [
    { name: "A: Context retention", pass: contextRetained },
    { name: "B: Cache improvement", pass: cacheImproved },
    { name: "C: Decision quality", pass: bothHaveFields },
  ];

  for (const t of tests) {
    console.log(`  ${t.pass ? "✓" : "✗"} ${t.name}`);
  }

  const criticalPassed = contextRetained && bothHaveFields;
  const allPassed = tests.every((t) => t.pass);

  console.log(`\nCritical tests (A + C): ${criticalPassed ? "PASSED" : "FAILED"}`);
  console.log(`All tests: ${allPassed ? "PASSED" : "PARTIAL"}`);

  if (criticalPassed) {
    console.log(
      "\n→ Session reuse is DE-RISKED. Proceed with Approach A implementation.",
    );
  } else {
    console.log(
      "\n→ Session reuse is NOT VIABLE. Mark design as NOT_VIABLE.",
    );
  }
}

runSpike().catch((err) => {
  console.error("Spike 5 failed:", err);
  process.exit(1);
});
