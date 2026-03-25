/**
 * Spike 4: Relay Prompt Size Measurement
 *
 * Measures token size of realistic relay prompts to validate the
 * tiered checkpoint strategy keeps relay prompts under 10K tokens.
 *
 * No SDK needed — pure computation.
 *
 * Run: npm run spike:4
 */

const DIVIDER = "=".repeat(60);

// ── Token estimation ────────────────────────────────────────────
// Claude tokenizer: ~1 token per 4 chars for English text.
// Slightly conservative (3.5 chars/token) to avoid underestimating.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ── Generate realistic test data ────────────────────────────────

function generateIssue(id: number, status: "open" | "fixed" | "skipped"): {
  id: string;
  severity: string;
  description: string;
  filePath: string;
  screenshotPath: string;
  status: string;
  fixCommit?: string;
} {
  const severities = ["critical", "high", "medium", "low", "cosmetic"];
  const descriptions = [
    `Navigation menu z-index causes overlap with modal dialog on mobile viewports`,
    `Form submit button is disabled after validation error even when fields are corrected`,
    `API response timeout not handled — user sees infinite loading spinner`,
    `Color contrast ratio on secondary buttons fails WCAG AA (3.8:1 vs required 4.5:1)`,
    `Hero image lazy-loading causes layout shift (CLS 0.18 > 0.1 threshold)`,
    `Authentication token refresh race condition causes double logout`,
    `Search results pagination resets to page 1 when filter is toggled`,
    `Dashboard chart tooltip clips at viewport edge on narrow screens`,
    `Missing alt text on 12 product images in the catalog grid`,
    `Footer links have inconsistent hover states across pages`,
  ];

  return {
    id: `QA-${String(id).padStart(3, "0")}`,
    severity: severities[id % severities.length],
    description: descriptions[id % descriptions.length],
    filePath: `src/components/${["Header", "Form", "API", "Button", "Hero", "Auth", "Search", "Chart", "Catalog", "Footer"][id % 10]}.tsx`,
    screenshotPath: `.garyclaw/screenshots/qa-${String(id).padStart(3, "0")}.png`,
    status,
    ...(status === "fixed"
      ? { fixCommit: `abc${String(id).padStart(4, "0")}` }
      : {}),
  };
}

function generateDecision(id: number): {
  question: string;
  chosen: string;
  confidence: number;
  rationale: string;
  principle: string;
} {
  const decisions = [
    {
      question: "Should we fix the z-index issue by restructuring the stacking context or adding a portal?",
      chosen: "Restructure stacking context",
      rationale: "Portals add complexity; restructuring the CSS is explicit and maintainable",
      principle: "Explicit over clever",
    },
    {
      question: "The form validation has 3 edge cases. Fix all or just the blocking one?",
      chosen: "Fix all 3",
      rationale: "All are in the same blast radius and each is < 10 lines",
      principle: "Boil lakes",
    },
    {
      question: "API timeout: add retry logic or just show error state?",
      chosen: "Show error state with retry button",
      rationale: "Auto-retry hides errors; user-triggered retry is explicit",
      principle: "Explicit over clever",
    },
    {
      question: "Color contrast: update the design system token or override locally?",
      chosen: "Update design system token",
      rationale: "Local override creates inconsistency; token change fixes all instances",
      principle: "Choose completeness",
    },
    {
      question: "Layout shift: use aspect-ratio or explicit width/height?",
      chosen: "aspect-ratio with width/height fallback",
      rationale: "Covers modern browsers and fallback for older ones",
      principle: "Choose completeness",
    },
  ];

  const d = decisions[id % decisions.length];
  return {
    ...d,
    confidence: 6 + (id % 4),
  };
}

// ── Build relay prompts ─────────────────────────────────────────

function buildFullRelayPrompt(
  openIssues: ReturnType<typeof generateIssue>[],
  recentFixed: ReturnType<typeof generateIssue>[],
  olderFixed: ReturnType<typeof generateIssue>[],
  recentDecisions: ReturnType<typeof generateDecision>[],
  olderDecisions: ReturnType<typeof generateDecision>[]
): string {
  let prompt = `# GaryClaw Relay — Continuing QA Run

## Session Context
You are continuing a QA run that was relayed due to context limits.
This is session #2. Previous session completed ${recentFixed.length + olderFixed.length} fixes.

## Open Issues (${openIssues.length} remaining)
`;

  for (const issue of openIssues) {
    prompt += `
### ${issue.id} [${issue.severity}] — ${issue.status}
${issue.description}
- File: ${issue.filePath}
- Screenshot: ${issue.screenshotPath}
`;
  }

  prompt += `\n## Recently Fixed Issues (last 5)\n`;
  for (const issue of recentFixed) {
    prompt += `
### ${issue.id} [${issue.severity}] — FIXED (${issue.fixCommit})
${issue.description}
- File: ${issue.filePath}
`;
  }

  prompt += `\n## Previously Fixed Issues (${olderFixed.length} total, summarized)\n`;
  for (const issue of olderFixed) {
    prompt += `- ${issue.id}: Fixed ${issue.description.slice(0, 60)}... in ${issue.filePath} (${issue.fixCommit})\n`;
  }

  prompt += `\n## Recent Decisions (last 5)\n`;
  for (const d of recentDecisions) {
    prompt += `
**Q:** ${d.question}
**A:** ${d.chosen} (confidence: ${d.confidence}/10)
**Why:** ${d.rationale} [${d.principle}]
`;
  }

  prompt += `\n## Older Decisions (${olderDecisions.length} total, summarized)\n`;
  for (const d of olderDecisions) {
    prompt += `- "${d.question.slice(0, 50)}..." → ${d.chosen} [${d.principle}]\n`;
  }

  prompt += `
## Instructions
Continue the QA fix loop. Start with the highest-severity open issue.
For each issue: read the file, understand the bug, fix it, commit, verify.
`;

  return prompt;
}

// ── Run measurements ────────────────────────────────────────────

async function runSpike() {
  console.log(DIVIDER);
  console.log("SPIKE 4: Relay Prompt Size Measurement");
  console.log(DIVIDER);

  // Scenario 1: Small relay (10 issues, 3 decisions) — typical early relay
  console.log("\n[Scenario 1] Small relay: 10 issues (5 open, 5 fixed), 3 decisions");
  const s1Open = Array.from({ length: 5 }, (_, i) => generateIssue(i, "open"));
  const s1Fixed = Array.from({ length: 5 }, (_, i) => generateIssue(i + 5, "fixed"));
  const s1Decisions = Array.from({ length: 3 }, (_, i) => generateDecision(i));
  const s1Prompt = buildFullRelayPrompt(s1Open, s1Fixed, [], s1Decisions, []);
  const s1Tokens = estimateTokens(s1Prompt);
  console.log(`  Chars: ${s1Prompt.length} | Est. tokens: ${s1Tokens}`);

  // Scenario 2: Medium relay (20 issues, 8 decisions) — mid-run relay
  console.log("\n[Scenario 2] Medium relay: 20 issues (8 open, 12 fixed), 8 decisions");
  const s2Open = Array.from({ length: 8 }, (_, i) => generateIssue(i, "open"));
  const s2RecentFixed = Array.from({ length: 5 }, (_, i) => generateIssue(i + 8, "fixed"));
  const s2OlderFixed = Array.from({ length: 7 }, (_, i) => generateIssue(i + 13, "fixed"));
  const s2RecentDec = Array.from({ length: 5 }, (_, i) => generateDecision(i));
  const s2OlderDec = Array.from({ length: 3 }, (_, i) => generateDecision(i + 5));
  const s2Prompt = buildFullRelayPrompt(s2Open, s2RecentFixed, s2OlderFixed, s2RecentDec, s2OlderDec);
  const s2Tokens = estimateTokens(s2Prompt);
  console.log(`  Chars: ${s2Prompt.length} | Est. tokens: ${s2Tokens}`);

  // Scenario 3: Large relay (30 issues, 10 decisions) — stress test
  console.log("\n[Scenario 3] Large relay: 30 issues (12 open, 18 fixed), 10 decisions");
  const s3Open = Array.from({ length: 12 }, (_, i) => generateIssue(i, "open"));
  const s3RecentFixed = Array.from({ length: 5 }, (_, i) => generateIssue(i + 12, "fixed"));
  const s3OlderFixed = Array.from({ length: 13 }, (_, i) => generateIssue(i + 17, "fixed"));
  const s3RecentDec = Array.from({ length: 5 }, (_, i) => generateDecision(i));
  const s3OlderDec = Array.from({ length: 5 }, (_, i) => generateDecision(i + 5));
  const s3Prompt = buildFullRelayPrompt(s3Open, s3RecentFixed, s3OlderFixed, s3RecentDec, s3OlderDec);
  const s3Tokens = estimateTokens(s3Prompt);
  console.log(`  Chars: ${s3Prompt.length} | Est. tokens: ${s3Tokens}`);

  // Scenario 4: Worst case (50 issues, 20 decisions)
  console.log("\n[Scenario 4] Worst case: 50 issues (20 open, 30 fixed), 20 decisions");
  const s4Open = Array.from({ length: 20 }, (_, i) => generateIssue(i, "open"));
  const s4RecentFixed = Array.from({ length: 5 }, (_, i) => generateIssue(i + 20, "fixed"));
  const s4OlderFixed = Array.from({ length: 25 }, (_, i) => generateIssue(i + 25, "fixed"));
  const s4RecentDec = Array.from({ length: 5 }, (_, i) => generateDecision(i));
  const s4OlderDec = Array.from({ length: 15 }, (_, i) => generateDecision(i + 5));
  const s4Prompt = buildFullRelayPrompt(s4Open, s4RecentFixed, s4OlderFixed, s4RecentDec, s4OlderDec);
  const s4Tokens = estimateTokens(s4Prompt);
  console.log(`  Chars: ${s4Prompt.length} | Est. tokens: ${s4Tokens}`);

  // ── Now measure a real SKILL.md if available ──────────────────
  console.log(`\n${DIVIDER}`);
  console.log("SKILL.md Size Measurement");
  console.log(DIVIDER);

  const { readFileSync, existsSync } = await import("fs");
  const { homedir } = await import("os");
  const skillPaths = [
    `${homedir()}/.claude/skills/gstack/qa/SKILL.md`,
    `${homedir()}/.claude/skills/gstack/design-review/SKILL.md`,
    `${homedir()}/.claude/skills/gstack/autoplan/SKILL.md`,
  ];

  for (const p of skillPaths) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8");
      const tokens = estimateTokens(content);
      const name = p.split("/").slice(-2).join("/");
      console.log(`\n  ${name}: ${content.length} chars, ~${tokens} tokens`);
    }
  }

  // ── Relay budget analysis ─────────────────────────────────────
  console.log(`\n${DIVIDER}`);
  console.log("RELAY BUDGET ANALYSIS");
  console.log(DIVIDER);

  const TARGET = 10_000; // 10K token budget for relay prompt

  console.log(`\n  Target: relay prompt < ${TARGET.toLocaleString()} tokens`);
  console.log(`  (SKILL.md loaded separately via settingSources, NOT counted here)\n`);

  const scenarios = [
    { name: "Small (10 issues, 3 decisions)", tokens: s1Tokens },
    { name: "Medium (20 issues, 8 decisions)", tokens: s2Tokens },
    { name: "Large (30 issues, 10 decisions)", tokens: s3Tokens },
    { name: "Worst (50 issues, 20 decisions)", tokens: s4Tokens },
  ];

  for (const s of scenarios) {
    const pct = ((s.tokens / TARGET) * 100).toFixed(0);
    const pass = s.tokens < TARGET;
    console.log(
      `  ${pass ? "✓" : "✗"} ${s.name}: ~${s.tokens.toLocaleString()} tokens (${pct}% of budget)`
    );
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log(`\n${DIVIDER}`);
  console.log("SPIKE 4 SUMMARY");
  console.log(DIVIDER);

  const allUnder = scenarios.every((s) => s.tokens < TARGET);
  const stressUnder = s3Tokens < TARGET; // 30 issues is the spec'd stress test

  console.log(`\n  All scenarios under ${TARGET.toLocaleString()} tokens: ${allUnder ? "✓" : "✗"}`);
  console.log(`  30-issue target scenario under budget: ${stressUnder ? "✓ PASS" : "✗ FAIL"}`);

  if (stressUnder) {
    console.log("\n  → Tiered relay prompt strategy is DE-RISKED. Proceed with core build.");
  } else {
    console.log("\n  → Need more aggressive summarization for fixed issues.");
  }
}

runSpike().catch((err) => {
  console.error("Spike 4 failed:", err);
  process.exit(1);
});
