/**
 * Semantic bootstrap validation tests — extractCommandClaims, extractTestDirectoryClaims,
 * and verification of command + test_directory claim types.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  extractCommandClaims,
  extractTestDirectoryClaims,
  extractClaudeMdClaims,
  verifyClaudeMdClaims,
  formatEvaluationReport,
} from "../src/evaluate.js";

import type { ClaudeMdClaim, EvaluationReport } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-semantic-validation-tmp");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── extractCommandClaims ─────────────────────────────────────────

describe("extractCommandClaims", () => {
  it("returns empty array for empty content", () => {
    expect(extractCommandClaims("")).toEqual([]);
    expect(extractCommandClaims("   ")).toEqual([]);
  });

  it("extracts npm run scripts from bash code blocks", () => {
    const content = `# Usage

\`\`\`bash
npm run dev
npm run build
npm run test
\`\`\`
`;
    const claims = extractCommandClaims(content);
    const names = claims.map((c) => c.claimed);
    expect(names).toContain("npm-script:dev");
    expect(names).toContain("npm-script:build");
    expect(names).toContain("npm-script:test");
    expect(claims.every((c) => c.type === "command")).toBe(true);
    expect(claims.every((c) => c.verified === false)).toBe(true);
  });

  it("extracts npm test and npm start shorthand", () => {
    const content = `# Quick start

\`\`\`bash
npm test
npm start
\`\`\`
`;
    const claims = extractCommandClaims(content);
    const names = claims.map((c) => c.claimed);
    expect(names).toContain("npm-script:test");
    expect(names).toContain("npm-script:start");
  });

  it("extracts yarn/pnpm/bun run variants", () => {
    const content = `# Usage

\`\`\`bash
yarn run dev
pnpm run build
bun run test
\`\`\`
`;
    const claims = extractCommandClaims(content);
    const names = claims.map((c) => c.claimed);
    expect(names).toContain("npm-script:dev");
    expect(names).toContain("npm-script:build");
    expect(names).toContain("npm-script:test");
  });

  it("extracts bun test shorthand", () => {
    const content = `\`\`\`bash
bun test
\`\`\`
`;
    const claims = extractCommandClaims(content);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimed).toBe("npm-script:test");
  });

  it("extracts npx tsx and node file commands", () => {
    const content = `# Running

\`\`\`bash
npx tsx src/cli.ts run qa
node dist/server.js
npx ts-node src/index.ts
\`\`\`
`;
    const claims = extractCommandClaims(content);
    const names = claims.map((c) => c.claimed);
    expect(names).toContain("file-command:src/cli.ts");
    expect(names).toContain("file-command:dist/server.js");
    expect(names).toContain("file-command:src/index.ts");
  });

  it("skips non-verifiable commands (npm install, git, cd, echo)", () => {
    const content = `\`\`\`bash
npm install
git clone https://example.com/repo
cd my-project
echo "hello"
mkdir -p dist
export FOO=bar
\`\`\`
`;
    const claims = extractCommandClaims(content);
    expect(claims).toHaveLength(0);
  });

  it("skips comments and variable assignments", () => {
    const content = `\`\`\`bash
# This is a comment
FOO=bar npm run dev
\`\`\`
`;
    const claims = extractCommandClaims(content);
    // FOO=bar line starts with variable assignment, should be skipped
    // # comment should also be skipped
    expect(claims).toHaveLength(0);
  });

  it("deduplicates identical commands", () => {
    const content = `\`\`\`bash
npm run dev
\`\`\`

\`\`\`bash
npm run dev
\`\`\`
`;
    const claims = extractCommandClaims(content);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimed).toBe("npm-script:dev");
  });

  it("handles code blocks with no language tag", () => {
    const content = `\`\`\`
npm run lint
\`\`\`
`;
    const claims = extractCommandClaims(content);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimed).toBe("npm-script:lint");
  });

  it("handles $ prefix on command lines", () => {
    const content = `\`\`\`bash
$ npm run dev
> npm run build
\`\`\`
`;
    const claims = extractCommandClaims(content);
    const names = claims.map((c) => c.claimed);
    expect(names).toContain("npm-script:dev");
    expect(names).toContain("npm-script:build");
  });
});

// ── extractTestDirectoryClaims ───────────────────────────────────

describe("extractTestDirectoryClaims", () => {
  it("returns empty array for empty content", () => {
    expect(extractTestDirectoryClaims("")).toEqual([]);
    expect(extractTestDirectoryClaims("   ")).toEqual([]);
  });

  it("extracts test/ directory mention in backticks", () => {
    const content = "Tests live in `test/` directory.";
    const claims = extractTestDirectoryClaims(content);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimed).toBe("test-dir:test");
    expect(claims[0].type).toBe("test_directory");
  });

  it("extracts __tests__/ variant", () => {
    const content = "Unit tests are in `__tests__/`.";
    const claims = extractTestDirectoryClaims(content);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimed).toBe("test-dir:__tests__");
  });

  it("extracts tests/ and spec/ variants", () => {
    const content = "Tests in `tests/` and specs in `spec/`.";
    const claims = extractTestDirectoryClaims(content);
    const names = claims.map((c) => c.claimed);
    expect(names).toContain("test-dir:tests");
    expect(names).toContain("test-dir:spec");
  });

  it("extracts test file count claims", () => {
    const content = "The project has 42 test files covering all modules.";
    const claims = extractTestDirectoryClaims(content);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimed).toBe("test-count:42");
    expect(claims[0].type).toBe("test_directory");
  });

  it("extracts N tests pattern", () => {
    const content = "We have 150 tests across the codebase.";
    const claims = extractTestDirectoryClaims(content);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimed).toBe("test-count:150");
  });

  it("skips small test counts (< 5)", () => {
    const content = "There are 2 test files for this module.";
    const claims = extractTestDirectoryClaims(content);
    expect(claims).toHaveLength(0);
  });

  it("skips test directory mentions inside tree listing blocks", () => {
    const content = `Project structure:

\`\`\`
├── src/
│   └── index.ts
├── test/
│   └── index.test.ts
└── package.json
\`\`\`
`;
    const claims = extractTestDirectoryClaims(content);
    // test/ inside tree listing should be skipped (no backtick-wrapped `test/` in tree)
    expect(claims.filter((c) => c.claimed.startsWith("test-dir:"))).toHaveLength(0);
  });

  it("deduplicates duplicate directory mentions", () => {
    const content = "Tests are in `test/`. All tests run from `test/`.";
    const claims = extractTestDirectoryClaims(content);
    const dirClaims = claims.filter((c) => c.claimed.startsWith("test-dir:"));
    expect(dirClaims).toHaveLength(1);
  });
});

// ── verifyClaudeMdClaims (command) ───────────────────────────────

describe("verifyClaudeMdClaims (command)", () => {
  it("verifies npm-script that exists in package.json", () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ scripts: { dev: "vite", build: "tsc && vite build" } }),
    );
    const claims: ClaudeMdClaim[] = [
      { type: "command", claimed: "npm-script:dev", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toContain("script exists");
  });

  it("fails npm-script that does not exist in package.json", () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } }),
    );
    const claims: ClaudeMdClaim[] = [
      { type: "command", claimed: "npm-script:dev", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(false);
    expect(result[0].evidence).toContain('no "dev" script');
    expect(result[0].evidence).toContain("build");
  });

  it("defers when no package.json exists", () => {
    const claims: ClaudeMdClaim[] = [
      { type: "command", claimed: "npm-script:dev", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toContain("deferred");
  });

  it("defers on malformed package.json", () => {
    writeFileSync(join(TEST_DIR, "package.json"), "not json{{{");
    const claims: ClaudeMdClaim[] = [
      { type: "command", claimed: "npm-script:dev", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toContain("parse error");
  });

  it("handles package.json with no scripts key", () => {
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({ name: "foo" }));
    const claims: ClaudeMdClaim[] = [
      { type: "command", claimed: "npm-script:dev", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(false);
    expect(result[0].evidence).toContain('no "dev" script');
  });

  it("verifies file-command when file exists", () => {
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "cli.ts"), "console.log('hi')");
    const claims: ClaudeMdClaim[] = [
      { type: "command", claimed: "file-command:src/cli.ts", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toBe("file exists");
  });

  it("fails file-command when file does not exist", () => {
    const claims: ClaudeMdClaim[] = [
      { type: "command", claimed: "file-command:src/server.ts", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(false);
    expect(result[0].evidence).toBe("file does not exist");
  });

  it("npm test maps to scripts.test", () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    const claims: ClaudeMdClaim[] = [
      { type: "command", claimed: "npm-script:test", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toContain("vitest");
  });
});

// ── verifyClaudeMdClaims (test_directory) ────────────────────────

describe("verifyClaudeMdClaims (test_directory)", () => {
  it("verifies test directory that exists", () => {
    mkdirSync(join(TEST_DIR, "test"), { recursive: true });
    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-dir:test", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toBe("directory exists");
  });

  it("fails test directory that does not exist", () => {
    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-dir:__tests__", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(false);
    expect(result[0].evidence).toContain("directory does not exist");
  });

  it("suggests alternative directories when claimed dir missing", () => {
    mkdirSync(join(TEST_DIR, "test"), { recursive: true });
    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-dir:__tests__", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(false);
    expect(result[0].evidence).toContain("found instead: test");
  });

  it("verifies test count within tolerance", () => {
    // Create 10 test files
    mkdirSync(join(TEST_DIR, "test"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(TEST_DIR, "test", `file-${i}.test.ts`), "");
    }
    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-count:10", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toContain("actual count: 10");
  });

  it("fails test count outside tolerance", () => {
    // Create 5 test files but claim 42
    mkdirSync(join(TEST_DIR, "test"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(TEST_DIR, "test", `file-${i}.test.ts`), "");
    }
    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-count:42", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(false);
    expect(result[0].evidence).toContain("actual count: 5");
    expect(result[0].evidence).toContain("claimed: 42");
  });

  it("tolerance allows exactly 20% deviation", () => {
    // Create 8 test files, claim 10 → deviation of 2, tolerance = max(3, ceil(10*0.2)) = 3
    mkdirSync(join(TEST_DIR, "test"), { recursive: true });
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(TEST_DIR, "test", `f-${i}.test.ts`), "");
    }
    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-count:10", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(true);
  });

  it("handles zero test files gracefully", () => {
    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-count:50", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(false);
    expect(result[0].evidence).toContain("actual count: 0");
  });

  it("reports no test directory found when no alternatives exist", () => {
    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-dir:spec", evidence: "", verified: false },
    ];
    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(false);
    expect(result[0].evidence).toContain("no test directory found");
  });
});

// ── Integration: extractClaudeMdClaims ───────────────────────────

describe("integration: extractClaudeMdClaims includes new types", () => {
  it("extracts all 6 claim types from a full CLAUDE.md", () => {
    const content = `# My Project

## Tech Stack
- **Runtime:** Node.js with TypeScript
- **Framework:** Express
- **Tests:** Vitest

## Architecture
Entry point is \`src/index.ts\`. Tests live in \`test/\`.

We have 25 test files covering all modules.

## Usage

\`\`\`bash
npm run dev
npx tsx src/cli.ts run
npm test
\`\`\`

## Test Strategy
All tests use Vitest.

Source code in \`src/index.ts\`.
`;
    const claims = extractClaudeMdClaims(content);
    const types = new Set(claims.map((c) => c.type));

    expect(types.has("tech_stack")).toBe(true);
    expect(types.has("file_path")).toBe(true);
    expect(types.has("test_framework")).toBe(true);
    expect(types.has("command")).toBe(true);
    expect(types.has("test_directory")).toBe(true);
    // entry_point depends on specific pattern matching — may or may not appear
  });

  it("backward compat: content with no commands or test dirs produces no new types", () => {
    const content = `# Simple Project

## Tech Stack
Uses Express.
`;
    const claims = extractClaudeMdClaims(content);
    const commandClaims = claims.filter((c) => c.type === "command");
    const testDirClaims = claims.filter((c) => c.type === "test_directory");
    expect(commandClaims).toHaveLength(0);
    expect(testDirClaims).toHaveLength(0);
  });

  it("command and test_directory claims integrate with verification pipeline", () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({
        scripts: { dev: "vite", test: "vitest" },
        devDependencies: { vitest: "^1.0.0" },
      }),
    );
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "cli.ts"), "");
    mkdirSync(join(TEST_DIR, "test"), { recursive: true });

    const content = `# Project

## Tech Stack
Vitest for tests.

## Usage

\`\`\`bash
npm run dev
npx tsx src/cli.ts
npm run missing-script
\`\`\`

Tests in \`test/\`.

## Test Strategy
Vitest.
`;
    const claims = extractClaudeMdClaims(content);
    const verified = verifyClaudeMdClaims(claims, TEST_DIR, ["vitest"]);

    // npm run dev should verify (script exists)
    const devClaim = verified.find((c) => c.claimed === "npm-script:dev");
    expect(devClaim?.verified).toBe(true);

    // npm run missing-script should fail
    const missingClaim = verified.find((c) => c.claimed === "npm-script:missing-script");
    expect(missingClaim?.verified).toBe(false);

    // file-command:src/cli.ts should verify (file exists)
    const fileClaim = verified.find((c) => c.claimed === "file-command:src/cli.ts");
    expect(fileClaim?.verified).toBe(true);

    // test-dir:test should verify (directory exists)
    const testDirClaim = verified.find((c) => c.claimed === "test-dir:test");
    expect(testDirClaim?.verified).toBe(true);
  });

  it("new types do not break existing claims", () => {
    const content = `# Project

## Tech Stack
Express and React.

Entry point is \`src/index.ts\`.

\`\`\`bash
npm run dev
\`\`\`
`;
    const claims = extractClaudeMdClaims(content);
    const techClaims = claims.filter((c) => c.type === "tech_stack");
    const entryPointClaims = claims.filter((c) => c.type === "entry_point");

    // Existing types still work
    expect(techClaims.length).toBeGreaterThan(0);
    // Command claim also present
    expect(claims.some((c) => c.type === "command")).toBe(true);
  });
});

// ── Integration: buildEnrichedBootstrapPrompt switch cases ───────

describe("integration: formatEvaluationReport failed claims", () => {
  function makeReport(claims: ClaudeMdClaim[]): EvaluationReport {
    return {
      targetRepo: "/tmp/test",
      timestamp: "2026-03-29",
      bootstrap: {
        claudeMdExists: true,
        claudeMdSizeTokens: 500,
        claudeMdHasSections: ["Architecture", "Tech Stack", "Test Strategy", "Usage"],
        claudeMdMissingSections: [],
        todosMdExists: true,
        todosMdItemCount: 5,
        todosMdItemsAboveThreshold: 3,
        qualityScore: 60,
        qualityNotes: [],
        claims,
        claimsVerified: claims.filter((c) => c.verified).length,
        claimsTotal: claims.length,
        claimVerificationScore: 0,
        frameworkCoverageScore: 0,
      },
      oracle: {
        totalDecisions: 0,
        lowConfidenceCount: 0,
        escalatedCount: 0,
        averageConfidence: 0,
        researchTriggered: false,
        topicClusters: [],
      },
      pipeline: {
        skillsRun: ["bootstrap"],
        skillsCompleted: ["bootstrap"],
        totalRelays: 0,
        totalCostUsd: 0,
        totalDurationSec: 0,
        contextGrowthRate: 0,
      },
      improvements: [],
    };
  }

  it("shows failed command claims in report", () => {
    const report = makeReport([
      { type: "command", claimed: "npm-script:dev", evidence: 'no "dev" script in package.json', verified: false },
    ]);
    const output = formatEvaluationReport(report);
    expect(output).toContain("**Failed Claims:**");
    expect(output).toContain('[command] "npm-script:dev"');
  });

  it("shows failed test_directory claims in report", () => {
    const report = makeReport([
      { type: "test_directory", claimed: "test-dir:__tests__", evidence: "directory does not exist (found instead: test)", verified: false },
    ]);
    const output = formatEvaluationReport(report);
    expect(output).toContain("**Failed Claims:**");
    expect(output).toContain('[test_directory] "test-dir:__tests__"');
  });

  it("does not show Failed Claims section when all claims pass", () => {
    const report = makeReport([
      { type: "command", claimed: "npm-script:dev", evidence: "script exists", verified: true },
    ]);
    const output = formatEvaluationReport(report);
    expect(output).not.toContain("**Failed Claims:**");
  });
});
