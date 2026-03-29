/**
 * Regression: ISSUE-001+002+003 — double-counting, no-claims fallback, P1-P5 mismatch
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  extractClaudeMdClaims,
  generateReverseCoverageClaims,
  analyzeBootstrapQuality,
} from "../src/evaluate.js";

const TEST_DIR = join(process.cwd(), ".test-claims-regression-1-tmp");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ISSUE-001: reverse claims excluded from claim average", () => {
  it("claimsTotal only counts forward claims, not reverse", () => {
    // React is in deps but NOT mentioned in CLAUDE.md → generates reverse claim
    // Express IS mentioned in CLAUDE.md and IS in deps → forward claim, verified
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({
        dependencies: { react: "^18.0.0", "react-dom": "^18.0.0", express: "^4.0.0" },
      }),
    );
    writeFileSync(
      join(TEST_DIR, "CLAUDE.md"),
      `# Project\n## Architecture\nUses Express.\n## Tech Stack\nExpress server.\n## Test Strategy\nManual.\n## Usage\nnpm start\n`,
    );

    const result = analyzeBootstrapQuality(TEST_DIR);

    // Forward claims should include Express (verified) but NOT React (that's reverse)
    const forwardClaims = extractClaudeMdClaims(
      readFileSync(join(TEST_DIR, "CLAUDE.md"), "utf-8"),
    );
    const reverseClaims = generateReverseCoverageClaims(
      ["react", "react-dom", "express"],
      readFileSync(join(TEST_DIR, "CLAUDE.md"), "utf-8"),
    );

    // React should appear as a reverse claim (in deps, not in doc)
    expect(reverseClaims.some((c) => c.claimed === "React")).toBe(true);

    // claimsTotal should equal forward claims count, NOT forward + reverse
    expect(result.claimsTotal).toBe(forwardClaims.length);
  });

  it("repo with 3 unmentioned frameworks is not double-penalized", () => {
    // Three frameworks in deps, none mentioned in CLAUDE.md
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({
        dependencies: {
          react: "^18.0.0",
          "react-dom": "^18.0.0",
          express: "^4.0.0",
          prisma: "^5.0.0",
        },
      }),
    );
    writeFileSync(
      join(TEST_DIR, "CLAUDE.md"),
      `# Project\n## Architecture\nA web app.\n## Tech Stack\nNode.js.\n## Test Strategy\nManual.\n## Usage\nnpm start\n`,
    );

    const result = analyzeBootstrapQuality(TEST_DIR);

    // The claim score should be based on forward claims only.
    // Forward claims from the vague CLAUDE.md should be minimal.
    // The framework coverage sub-score already penalizes the omission.
    // Score should NOT be near zero (which would happen with double counting).
    expect(result.qualityScore).toBeGreaterThan(15);
  });
});

describe("ISSUE-002: no-claims fallback is neutral, not full marks", () => {
  it("gives 10/20 (neutral) when zero forward claims are extracted", () => {
    writeFileSync(
      join(TEST_DIR, "CLAUDE.md"),
      "# Project\n\nA simple project with no specific tech names or file paths.\n",
    );

    const result = analyzeBootstrapQuality(TEST_DIR);

    // Zero claims → neutral 10, not rewarding 20
    expect(result.claimVerificationScore).toBe(10);
  });

  it("does not give full marks for vague CLAUDE.md", () => {
    writeFileSync(
      join(TEST_DIR, "CLAUDE.md"),
      `# Project\n## Architecture\nThis is a web project with a database.\n## Tech Stack\nStandard tools.\n## Test Strategy\nWe test things.\n## Usage\nRun the app.\n`,
    );

    const result = analyzeBootstrapQuality(TEST_DIR);

    // All 4 sections present = 30 pts structural
    // No claims = 10 pts (neutral)
    // No package.json = 20 pts coverage
    // No TODOS = 0 pts viability
    // Efficiency varies by token count
    // Key assertion: claim score is neutral, not max
    expect(result.claimVerificationScore).toBe(10);
    // Total should be noticeably less than if claims were 20
    expect(result.qualityScore).toBeLessThanOrEqual(70);
  });
});

describe("ISSUE-003: P1-P4 in enriched bootstrap prompt", () => {
  it("enriched prompt references P1-P4, not P1-P5", async () => {
    const { buildEnrichedBootstrapPrompt } = await import("../src/bootstrap.js");

    // Create minimal project structure
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\n\nBasic.\n");
    mkdirSync(join(TEST_DIR, ".garyclaw"), { recursive: true });

    const prompt = await buildEnrichedBootstrapPrompt(
      { projectDir: TEST_DIR, checkpointDir: join(TEST_DIR, ".garyclaw") } as any,
      join(TEST_DIR, ".garyclaw", "nonexistent-qa"),
      TEST_DIR,
    );

    expect(prompt).toContain("P1-P4");
    expect(prompt).not.toContain("P1-P5");
  });
});
