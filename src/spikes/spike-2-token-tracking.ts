/**
 * Spike 2: Token Tracking + Resume
 *
 * Verifies:
 * (a) Token usage fields on AssistantMessage and ResultMessage
 * (b) Per-turn monitoring via AssistantMessage.message.usage
 * (c) modelUsage.contextWindow gives the denominator
 * (d) Resume with settingSources — do project settings survive?
 *
 * Run: npm run spike:2
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const DIVIDER = "=".repeat(60);

// Strip ANTHROPIC_API_KEY so SDK uses Claude Max login instead of API billing
const { ANTHROPIC_API_KEY: _, ...sdkEnv } = process.env;

// Collect per-turn usage from AssistantMessages
interface TurnUsage {
  turn: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadInputTokens: number | undefined;
  cacheCreationInputTokens: number | undefined;
  computedContextSize: number | undefined;
}

async function runSpike() {
  console.log(DIVIDER);
  console.log("SPIKE 2: Token Tracking + Resume");
  console.log(DIVIDER);

  // ── Test A+B: Token usage fields ──────────────────────────────
  console.log("\n[Test A+B] Token usage on AssistantMessage + ResultMessage\n");

  const turnUsages: TurnUsage[] = [];
  let turnCount = 0;
  let sessionId: string | undefined;

  // Use a prompt that triggers a few tool calls to generate multiple turns
  const prompt = `Do these three things in order:
1. Read the file /etc/hostname (or if it doesn't exist, just say "no hostname file")
2. List files in the current directory
3. Say "DONE" and nothing else.`;

  const q = query({
    prompt,
    options: {
      maxTurns: 6,
      cwd: process.cwd(),
      env: sdkEnv,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      canUseTool: async () => ({ behavior: "allow" as const }),
    },
  });

  let resultMsg: any = null;

  for await (const msg of q) {
    if (msg.type === "assistant") {
      turnCount++;
      sessionId = msg.session_id;
      const usage = (msg.message as any)?.usage;

      const turn: TurnUsage = {
        turn: turnCount,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        cacheReadInputTokens: usage?.cache_read_input_tokens,
        cacheCreationInputTokens: usage?.cache_creation_input_tokens,
        computedContextSize: undefined,
      };

      if (
        turn.inputTokens !== undefined &&
        turn.cacheReadInputTokens !== undefined &&
        turn.cacheCreationInputTokens !== undefined
      ) {
        turn.computedContextSize =
          turn.inputTokens +
          turn.cacheReadInputTokens +
          turn.cacheCreationInputTokens;
      }

      turnUsages.push(turn);

      console.log(`  Turn ${turnCount}:`);
      console.log(`    input_tokens:                ${turn.inputTokens}`);
      console.log(`    output_tokens:               ${turn.outputTokens}`);
      console.log(`    cache_read_input_tokens:      ${turn.cacheReadInputTokens}`);
      console.log(`    cache_creation_input_tokens:  ${turn.cacheCreationInputTokens}`);
      console.log(`    computed context size:        ${turn.computedContextSize}`);
    }

    if (msg.type === "result") {
      resultMsg = msg;
      sessionId = msg.session_id;
    }
  }

  // ── Analyze ResultMessage ─────────────────────────────────────
  console.log(`\n${DIVIDER}`);
  console.log("ResultMessage Analysis");
  console.log(DIVIDER);

  if (resultMsg) {
    console.log(`\n  subtype:        ${resultMsg.subtype}`);
    console.log(`  num_turns:      ${resultMsg.num_turns}`);
    console.log(`  total_cost_usd: ${resultMsg.total_cost_usd}`);
    console.log(`  duration_ms:    ${resultMsg.duration_ms}`);

    // Top-level usage (NonNullableUsage — snake_case from Anthropic API)
    const u = resultMsg.usage;
    if (u) {
      console.log(`\n  ResultMessage.usage (aggregate):`);
      console.log(`    input_tokens:                ${u.input_tokens}`);
      console.log(`    output_tokens:               ${u.output_tokens}`);
      console.log(`    cache_read_input_tokens:      ${u.cache_read_input_tokens}`);
      console.log(`    cache_creation_input_tokens:  ${u.cache_creation_input_tokens}`);
    } else {
      console.log(`\n  ✗ ResultMessage.usage is missing!`);
    }

    // Per-model usage (camelCase)
    const mu = resultMsg.modelUsage;
    if (mu) {
      console.log(`\n  ResultMessage.modelUsage:`);
      for (const [model, usage] of Object.entries(mu)) {
        const m = usage as any;
        console.log(`    Model: ${model}`);
        console.log(`      inputTokens:              ${m.inputTokens}`);
        console.log(`      outputTokens:             ${m.outputTokens}`);
        console.log(`      cacheReadInputTokens:     ${m.cacheReadInputTokens}`);
        console.log(`      cacheCreationInputTokens: ${m.cacheCreationInputTokens}`);
        console.log(`      contextWindow:            ${m.contextWindow}`);
        console.log(`      maxOutputTokens:          ${m.maxOutputTokens}`);
        console.log(`      costUSD:                  ${m.costUSD}`);
      }
    } else {
      console.log(`\n  ✗ ResultMessage.modelUsage is missing!`);
    }
  } else {
    console.log("  ✗ No ResultMessage received!");
  }

  // ── Test C: Context window denominator ────────────────────────
  console.log(`\n${DIVIDER}`);
  console.log("[Test C] Context window denominator from modelUsage");
  console.log(DIVIDER);

  let contextWindow: number | undefined;
  if (resultMsg?.modelUsage) {
    const models = Object.values(resultMsg.modelUsage) as any[];
    contextWindow = models[0]?.contextWindow;
    console.log(`\n  contextWindow: ${contextWindow}`);
    if (contextWindow && contextWindow > 0) {
      console.log(`  ✓ PASS — denominator available`);
    } else {
      console.log(`  ✗ FAIL — contextWindow missing or zero`);
    }
  }

  // ── Test D: Resume ────────────────────────────────────────────
  console.log(`\n${DIVIDER}`);
  console.log("[Test D] Resume with settingSources");
  console.log(DIVIDER);

  if (!sessionId) {
    console.log("  ✗ Cannot test resume — no session ID from first run");
  } else {
    console.log(`\n  Resuming session: ${sessionId}`);
    console.log(`  With settingSources: ['project']`);

    const q2 = query({
      prompt: "What is your session ID? Also, can you see any CLAUDE.md instructions? Say YES or NO. Then say RESUME_OK.",
      options: {
        resume: sessionId,
        maxTurns: 2,
        env: sdkEnv,
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        canUseTool: async () => ({ behavior: "allow" as const }),
      },
    });

    let resumeResult = "";
    let resumeSessionId: string | undefined;

    for await (const msg of q2) {
      if (msg.type === "result" && msg.subtype === "success") {
        resumeResult = msg.result;
        resumeSessionId = msg.session_id;
      }
    }

    console.log(`\n  Resume session ID: ${resumeSessionId}`);
    console.log(`  Same session? ${resumeSessionId === sessionId ? "YES" : "NO (forked)"}`);
    console.log(`  Result: ${resumeResult.slice(0, 300)}`);
    console.log(`  CLAUDE.md visible: ${resumeResult.includes("YES") ? "✓ PASS" : "? CHECK MANUALLY"}`);
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log(`\n${DIVIDER}`);
  console.log("SPIKE 2 SUMMARY");
  console.log(DIVIDER);

  const hasPerTurn = turnUsages.some((t) => t.inputTokens !== undefined);
  const hasResult = resultMsg?.usage != null;
  const hasDenom = contextWindow != null && contextWindow > 0;

  console.log(`  [A] ResultMessage.usage present:       ${hasResult ? "✓" : "✗"}`);
  console.log(`  [B] Per-turn usage on AssistantMessage: ${hasPerTurn ? "✓" : "✗"}`);
  console.log(`  [C] contextWindow denominator:          ${hasDenom ? "✓" : "✗"}`);
  console.log(`  [D] Resume tested:                     ${sessionId ? "✓" : "✗"}`);

  const score = [hasPerTurn, hasResult, hasDenom].filter(Boolean).length;
  console.log(`\n  Score: ${score}/3 core tests (+ resume manual check)`);
  if (score === 3) {
    console.log("  → Token tracking is DE-RISKED. Proceed with core build.");
  }
}

runSpike().catch((err) => {
  console.error("Spike 2 failed:", err);
  process.exit(1);
});
