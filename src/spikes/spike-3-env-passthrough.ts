/**
 * Spike 3: Env Var Passthrough
 *
 * Verifies:
 * (a) SDK query() env option passes custom env vars to the spawned session
 * (b) Specifically tests $B (browse binary path) and a custom test var
 * (c) Tests settingSources discovers ~/.claude/skills/
 *
 * Run: npm run spike:3
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

const DIVIDER = "=".repeat(60);

// Strip ANTHROPIC_API_KEY so SDK uses Claude Max login instead of API billing
const { ANTHROPIC_API_KEY: _, ...sdkEnv } = process.env;

async function runSpike() {
  console.log(DIVIDER);
  console.log("SPIKE 3: Env Var Passthrough");
  console.log(DIVIDER);

  // ── Test A: Custom env vars ───────────────────────────────────
  console.log("\n[Test A] Custom env var passthrough\n");

  const TEST_VAR = "GARYCLAW_SPIKE_TEST_" + Date.now();
  const TEST_VALUE = "spike3_works_" + Math.random().toString(36).slice(2, 8);

  // Find browse binary if it exists (for Test B)
  const browsePath = process.env.B || "/usr/local/bin/browse";

  console.log(`  Setting env vars:`);
  console.log(`    GARYCLAW_TEST_VAR=${TEST_VALUE}`);
  console.log(`    B=${browsePath}`);

  const q = query({
    prompt: `Run these two bash commands and report the EXACT output of each:
1. echo "GARYCLAW_TEST_VAR=$GARYCLAW_TEST_VAR"
2. echo "B=$B"

Report the exact values. Then say DONE.`,
    options: {
      maxTurns: 4,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      env: {
        ...sdkEnv,
        GARYCLAW_TEST_VAR: TEST_VALUE,
        B: browsePath,
      },
      canUseTool: async () => ({ behavior: "allow" as const }),
    },
  });

  let resultText = "";

  for await (const msg of q) {
    if (msg.type === "result" && msg.subtype === "success") {
      resultText = msg.result;
    }
  }

  console.log(`\n  Result: ${resultText.slice(0, 400)}`);

  const testVarPassed = resultText.includes(TEST_VALUE);
  const bVarPassed = resultText.includes(browsePath);

  console.log(`\n  GARYCLAW_TEST_VAR passed through: ${testVarPassed ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`  B (browse binary) passed through:  ${bVarPassed ? "✓ PASS" : "✗ FAIL"}`);

  // ── Test B: settingSources discovery ──────────────────────────
  console.log(`\n${DIVIDER}`);
  console.log("[Test B] settingSources skill discovery");
  console.log(DIVIDER);

  // Check if ~/.claude/skills/ exists
  const { existsSync } = await import("fs");
  const { homedir } = await import("os");
  const skillsDir = `${homedir()}/.claude/skills`;
  const skillsExist = existsSync(skillsDir);

  console.log(`\n  ~/.claude/skills/ exists: ${skillsExist}`);

  if (skillsExist) {
    // Run a query with settingSources to see if skills are loaded
    const q2 = query({
      prompt: `List any skill-related instructions or SKILL.md content you can see in your system prompt. If you see gstack skills, say "SKILLS_FOUND: <list skill names>". If not, say "NO_SKILLS_FOUND". Then say DONE.`,
      options: {
        maxTurns: 2,
        env: sdkEnv,
        settingSources: ["user", "project"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        canUseTool: async () => ({ behavior: "allow" as const }),
      },
    });

    let skillResult = "";
    for await (const msg of q2) {
      if (msg.type === "result" && msg.subtype === "success") {
        skillResult = msg.result;
      }
    }

    console.log(`  Result: ${skillResult.slice(0, 400)}`);
    const skillsFound = skillResult.includes("SKILLS_FOUND");
    console.log(`  Skills discovered: ${skillsFound ? "✓ PASS" : "✗ FAIL / NO_SKILLS"}`);
  } else {
    console.log("  Skipped — no skills directory. Install gstack skills first.");
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log(`\n${DIVIDER}`);
  console.log("SPIKE 3 SUMMARY");
  console.log(DIVIDER);

  const score = [testVarPassed, bVarPassed].filter(Boolean).length;
  console.log(`  [A] Custom env var:    ${testVarPassed ? "✓" : "✗"}`);
  console.log(`  [A] Browse binary $B:  ${bVarPassed ? "✓" : "✗"}`);
  console.log(`  [B] settingSources:    ${skillsExist ? "tested" : "skipped"}`);
  console.log(`\n  Score: ${score}/2 core tests`);
  if (score === 2) {
    console.log("  → Env passthrough is DE-RISKED. Proceed with core build.");
  }
}

runSpike().catch((err) => {
  console.error("Spike 3 failed:", err);
  process.exit(1);
});
