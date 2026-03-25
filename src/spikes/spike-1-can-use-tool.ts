/**
 * Spike 1: canUseTool + Skill Invocation
 *
 * Verifies:
 * (a) canUseTool fires for AskUserQuestion via SDK query()
 * (b) updatedInput with pre-filled answers works
 * (c) Skill invocation methods (prompt string, Skill tool, manual injection)
 * (d) settingSources discovers skills at ~/.claude/skills/
 *
 * Run: npm run spike:1
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

const DIVIDER = "=".repeat(60);

// Strip ANTHROPIC_API_KEY so SDK uses Claude Max login instead of API billing
const { ANTHROPIC_API_KEY: _, ...sdkEnv } = process.env;

// Track all canUseTool invocations
const toolCalls: Array<{
  toolName: string;
  inputKeys: string[];
  timestamp: number;
}> = [];

// Track AskUserQuestion specifically
const askCalls: Array<{
  input: Record<string, unknown>;
  answered: boolean;
}> = [];

async function runSpike() {
  console.log(DIVIDER);
  console.log("SPIKE 1: canUseTool + Skill Invocation");
  console.log(DIVIDER);

  // ── Test A: canUseTool fires for AskUserQuestion ──────────────
  console.log("\n[Test A] canUseTool interception for AskUserQuestion\n");

  // We prompt Claude to call AskUserQuestion so we can intercept it
  const prompt = `You MUST call the AskUserQuestion tool with exactly this:
- question: "Which color theme?"
- header: "Theme"
- options: [{"label": "Dark", "description": "Dark theme"}, {"label": "Light", "description": "Light theme"}]
- multiSelect: false

Call AskUserQuestion now. Do NOT skip it. After the answer comes back, say "ANSWER RECEIVED: <the answer>".`;

  const q = query({
    prompt,
    options: {
      maxTurns: 4,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env: sdkEnv,
      // Do NOT use settingSources here — we want an isolated test
      canUseTool: async (toolName, input, opts) => {
        const call = {
          toolName,
          inputKeys: Object.keys(input),
          timestamp: Date.now(),
        };
        toolCalls.push(call);

        console.log(`  canUseTool fired: tool=${toolName}`);
        console.log(`    input keys: ${JSON.stringify(call.inputKeys)}`);

        if (toolName === "AskUserQuestion") {
          console.log(`    ✓ AskUserQuestion intercepted!`);
          console.log(`    input: ${JSON.stringify(input, null, 2)}`);

          // Test B: Pre-fill the answer via updatedInput
          const questions = input.questions as Array<{
            question: string;
          }>;
          const questionText = questions?.[0]?.question ?? "";

          const updatedInput = {
            ...input,
            answers: {
              [questionText]: "Dark",
            },
          };

          askCalls.push({ input, answered: true });

          console.log(`\n[Test B] Injecting updatedInput with answer "Dark"`);
          console.log(`    updatedInput.answers: ${JSON.stringify(updatedInput.answers)}`);

          return {
            behavior: "allow" as const,
            updatedInput,
          };
        }

        // Allow all other tools
        return { behavior: "allow" as const };
      },
    },
  });

  let sessionId: string | undefined;
  let resultText = "";

  for await (const msg of q) {
    if (msg.type === "assistant") {
      sessionId = msg.session_id;
      // Extract text content
      for (const block of (msg.message as any).content ?? []) {
        if (block.type === "text") {
          resultText += block.text;
        }
      }
    }
    if (msg.type === "result") {
      sessionId = msg.session_id;
      if (msg.subtype === "success") {
        resultText = msg.result;
      }
    }
  }

  // ── Results ────────────────────────────────────────────────────
  console.log(`\n${DIVIDER}`);
  console.log("RESULTS");
  console.log(DIVIDER);

  console.log(`\nTotal canUseTool calls: ${toolCalls.length}`);
  for (const call of toolCalls) {
    console.log(`  - ${call.toolName} (keys: ${call.inputKeys.join(", ")})`);
  }

  const askFired = askCalls.length > 0;
  console.log(`\n[A] canUseTool fires for AskUserQuestion: ${askFired ? "✓ PASS" : "✗ FAIL"}`);

  const answerInjected = resultText.includes("Dark") || resultText.includes("ANSWER RECEIVED");
  console.log(`[B] updatedInput pre-fill accepted: ${answerInjected ? "✓ PASS" : "✗ FAIL (check result text)"}`);
  console.log(`    Result text: ${resultText.slice(0, 200)}`);

  console.log(`\nSession ID: ${sessionId}`);

  // ── Test C & D logged but not run in this invocation ──────────
  console.log(`\n${DIVIDER}`);
  console.log("DEFERRED TESTS (run separately if A+B pass):");
  console.log(`[C] Skill invocation methods — requires gstack skills installed`);
  console.log(`[D] settingSources discovers ~/.claude/skills/ — test with settingSources: ['user', 'project']`);
  console.log(DIVIDER);

  // ── Summary ────────────────────────────────────────────────────
  const passed = [askFired, answerInjected].filter(Boolean).length;
  console.log(`\nSPIKE 1 SCORE: ${passed}/2 core tests passed`);
  if (passed === 2) {
    console.log("→ canUseTool interception is DE-RISKED. Proceed with core build.");
  } else {
    console.log("→ Investigate failures before proceeding.");
  }
}

runSpike().catch((err) => {
  console.error("Spike 1 failed:", err);
  process.exit(1);
});
