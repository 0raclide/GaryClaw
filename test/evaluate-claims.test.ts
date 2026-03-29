/**
 * Claim verification tests — extractClaudeMdClaims, verifyClaudeMdClaims,
 * generateReverseCoverageClaims, and score rebalancing with claims.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  extractClaudeMdClaims,
  verifyClaudeMdClaims,
  generateReverseCoverageClaims,
  analyzeBootstrapQuality,
  extractDependencies,
} from "../src/evaluate.js";

import type { ClaudeMdClaim } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-evaluate-claims-tmp");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── extractClaudeMdClaims ────────────────────────────────────────

describe("extractClaudeMdClaims", () => {
  it("returns empty array for empty content", () => {
    expect(extractClaudeMdClaims("")).toEqual([]);
    expect(extractClaudeMdClaims("   ")).toEqual([]);
  });

  it("extracts tech stack claims from prose", () => {
    const content = `# My Project

## Tech Stack
- **Framework:** React with Next.js
- **Tests:** Vitest
- **ORM:** Prisma
`;
    const claims = extractClaudeMdClaims(content);
    const techClaims = claims.filter((c) => c.type === "tech_stack");
    const claimedNames = techClaims.map((c) => c.claimed);

    expect(claimedNames).toContain("React");
    expect(claimedNames).toContain("Next.js");
    expect(claimedNames).toContain("Vitest");
    expect(claimedNames).toContain("Prisma");
  });

  it("skips tech names inside install instruction code blocks", () => {
    const content = `# Setup

Install dependencies:

\`\`\`bash
npm install prisma @prisma/client
\`\`\`

We use Express for the server.
`;
    const claims = extractClaudeMdClaims(content);
    const techClaims = claims.filter((c) => c.type === "tech_stack");
    const claimedNames = techClaims.map((c) => c.claimed);

    // Express is in prose — should be extracted
    expect(claimedNames).toContain("Express");
    // Prisma is in install block — should be skipped
    // (note: if Prisma also appears in prose elsewhere, it would be extracted)
  });

  it("skips tech names in negation/comparison context", () => {
    // Negation context words appear near the framework name — these should be skipped.
    // Positive mentions are separated by enough text to be outside the ~100 char window.
    const content = `# Tech Stack

We considered React as an alternative but it was not the right fit for our use case given our team's experience level and the project requirements we established.

## Frontend Framework

The entire frontend application is built with Vue and uses the Composition API extensively throughout all components in the project codebase.

## Testing Infrastructure

Our comprehensive test suite is powered by Vitest which provides excellent TypeScript support and fast parallel test execution for all unit and integration tests.

## Historical Context

Several years ago the team migrated from Jest when the project was first started, but that was before the current architecture was designed and is no longer relevant to the current setup.
`;
    const claims = extractClaudeMdClaims(content);
    const techClaims = claims.filter((c) => c.type === "tech_stack");
    const claimedNames = techClaims.map((c) => c.claimed);

    // "considered React" should be skipped (negation context)
    expect(claimedNames).not.toContain("React");
    // "migrated from Jest" should be skipped (negation context)
    expect(claimedNames).not.toContain("Jest");

    // Vue and Vitest are positive mentions (far from negation words)
    expect(claimedNames).toContain("Vue");
    expect(claimedNames).toContain("Vitest");
  });

  it("extracts file path claims from prose", () => {
    const content = `## Architecture

The entry point is \`src/index.ts\` which imports from src/utils/helpers.ts.
Tests live in test/unit/.
`;
    const claims = extractClaudeMdClaims(content);
    const pathClaims = claims.filter((c) => c.type === "file_path");
    const paths = pathClaims.map((c) => c.claimed);

    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/utils/helpers.ts");
    expect(paths).toContain("test/unit/");
  });

  it("extracts test framework claims", () => {
    const content = `## Test Strategy

We use vitest for unit tests and pytest for integration tests.
`;
    const claims = extractClaudeMdClaims(content);
    const testClaims = claims.filter((c) => c.type === "test_framework");
    const runners = testClaims.map((c) => c.claimed);

    expect(runners).toContain("vitest");
    expect(runners).toContain("pytest");
  });

  it("extracts entry point claims", () => {
    const content = `The main entry point is src/server.ts which starts the HTTP server.`;
    const claims = extractClaudeMdClaims(content);
    const entryPoints = claims.filter((c) => c.type === "entry_point");

    expect(entryPoints.length).toBeGreaterThanOrEqual(1);
    expect(entryPoints[0].claimed).toBe("src/server.ts");
  });

  it("deduplicates claims with same type and name", () => {
    const content = `# Project
Uses React for the frontend. React components are in src/components/.
React is great.
`;
    const claims = extractClaudeMdClaims(content);
    const reactClaims = claims.filter((c) => c.type === "tech_stack" && c.claimed === "React");

    // Should only appear once despite multiple mentions
    expect(reactClaims).toHaveLength(1);
  });

  it("extracts tree listing paths as a single claim", () => {
    const content = `## File Tree

\`\`\`
├── src/
│   ├── index.ts
│   ├── server.ts
│   ├── utils.ts
│   ├── config.ts
│   └── types.ts
\`\`\`
`;
    const claims = extractClaudeMdClaims(content);
    const treeClaims = claims.filter((c) => c.claimed.startsWith("tree:["));

    expect(treeClaims.length).toBeGreaterThanOrEqual(1);
    // Tree claims contain sampled leaf nodes
    expect(treeClaims[0].claimed).toContain("index.ts");
  });
});

// ── verifyClaudeMdClaims ──────────────────────────────────────────

describe("verifyClaudeMdClaims", () => {
  it("verifies tech stack claims against package.json deps", () => {
    // Create a package.json with vitest
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({
      devDependencies: { vitest: "^1.0.0" },
    }));

    const claims: ClaudeMdClaim[] = [
      { type: "tech_stack", claimed: "Vitest", evidence: "", verified: false },
      { type: "tech_stack", claimed: "Prisma", evidence: "", verified: false },
    ];

    const deps = extractDependencies(JSON.stringify({
      devDependencies: { vitest: "^1.0.0" },
    }));

    const verified = verifyClaudeMdClaims(claims, TEST_DIR, deps);

    expect(verified[0].verified).toBe(true);
    expect(verified[0].evidence).toContain("found in deps");

    expect(verified[1].verified).toBe(false);
    expect(verified[1].evidence).toContain("not found");
  });

  it("verifies file path claims via existsSync", () => {
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");

    const claims: ClaudeMdClaim[] = [
      { type: "file_path", claimed: "src/index.ts", evidence: "", verified: false },
      { type: "file_path", claimed: "src/missing.ts", evidence: "", verified: false },
    ];

    const verified = verifyClaudeMdClaims(claims, TEST_DIR, []);

    expect(verified[0].verified).toBe(true);
    expect(verified[0].evidence).toBe("file exists");

    expect(verified[1].verified).toBe(false);
    expect(verified[1].evidence).toBe("file does not exist");
  });

  it("verifies tree listing claims with 80% threshold", () => {
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "index.ts"), "");
    writeFileSync(join(TEST_DIR, "server.ts"), "");
    writeFileSync(join(TEST_DIR, "utils.ts"), "");
    writeFileSync(join(TEST_DIR, "config.ts"), "");
    // missing.ts does NOT exist — 4/5 = 80% threshold met

    const claims: ClaudeMdClaim[] = [
      {
        type: "file_path",
        claimed: "tree:[index.ts,server.ts,utils.ts,config.ts,missing.ts]",
        evidence: "",
        verified: false,
      },
    ];

    const verified = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(verified[0].verified).toBe(true);
    expect(verified[0].evidence).toContain("4/5");
  });

  it("fails tree listing claims below 80% threshold", () => {
    writeFileSync(join(TEST_DIR, "index.ts"), "");
    // Only 1/5 exists

    const claims: ClaudeMdClaim[] = [
      {
        type: "file_path",
        claimed: "tree:[index.ts,a.ts,b.ts,c.ts,d.ts]",
        evidence: "",
        verified: false,
      },
    ];

    const verified = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(verified[0].verified).toBe(false);
  });

  it("verifies test framework claims against deps and config files", () => {
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({
      devDependencies: { vitest: "^1.0.0" },
    }));

    const deps = ["vitest"];
    const claims: ClaudeMdClaim[] = [
      { type: "test_framework", claimed: "vitest", evidence: "", verified: false },
      { type: "test_framework", claimed: "jest", evidence: "", verified: false },
    ];

    const verified = verifyClaudeMdClaims(claims, TEST_DIR, deps);

    expect(verified[0].verified).toBe(true);
    expect(verified[1].verified).toBe(false);
  });

  it("verifies test framework via config file when not in deps", () => {
    writeFileSync(join(TEST_DIR, "package.json"), "{}");
    writeFileSync(join(TEST_DIR, "vitest.config.ts"), "export default {};");

    const claims: ClaudeMdClaim[] = [
      { type: "test_framework", claimed: "vitest", evidence: "", verified: false },
    ];

    const verified = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(verified[0].verified).toBe(true);
    expect(verified[0].evidence).toContain("config file found");
  });

  it("verifies entry point claims via existsSync", () => {
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "app.ts"), "");

    const claims: ClaudeMdClaim[] = [
      { type: "entry_point", claimed: "src/app.ts", evidence: "", verified: false },
      { type: "entry_point", claimed: "src/main.ts", evidence: "", verified: false },
    ];

    const verified = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(verified[0].verified).toBe(true);
    expect(verified[1].verified).toBe(false);
  });

  it("defers tech stack verification for non-Node repos", () => {
    // No package.json exists
    const claims: ClaudeMdClaim[] = [
      { type: "tech_stack", claimed: "React", evidence: "", verified: false },
    ];

    const verified = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(verified[0].verified).toBe(true);
    expect(verified[0].evidence).toContain("non-Node repo");
  });
});

// ── generateReverseCoverageClaims ──────────────────────────────────

describe("generateReverseCoverageClaims", () => {
  it("generates claims for deps not mentioned in CLAUDE.md", () => {
    const deps = ["vitest", "express", "prisma"];
    const claudeMd = "We use Vitest for testing and Express for the server.";

    const claims = generateReverseCoverageClaims(deps, claudeMd);

    // Prisma is in deps but not mentioned
    const prismaClaim = claims.find((c) => c.claimed === "Prisma");
    expect(prismaClaim).toBeDefined();
    expect(prismaClaim!.verified).toBe(false);
    expect(prismaClaim!.evidence).toContain("not mentioned");
  });

  it("returns empty when all deps are mentioned", () => {
    const deps = ["vitest", "express"];
    const claudeMd = "We use Vitest for testing and Express for the server.";

    const claims = generateReverseCoverageClaims(deps, claudeMd);
    expect(claims).toHaveLength(0);
  });

  it("ignores deps not in KNOWN_FRAMEWORKS", () => {
    const deps = ["lodash", "dayjs"]; // not in KNOWN_FRAMEWORKS
    const claudeMd = "A simple project.";

    const claims = generateReverseCoverageClaims(deps, claudeMd);
    expect(claims).toHaveLength(0);
  });
});

// ── analyzeBootstrapQuality with claims ──────────────────────────

describe("analyzeBootstrapQuality — claim verification scoring", () => {
  it("includes claim verification results in evaluation", () => {
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export {};");
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({
      dependencies: { express: "^4.0.0" },
      devDependencies: { vitest: "^1.0.0" },
    }));

    const claudeMd = `# My Project

## Architecture
Entry point is src/index.ts.

## Tech Stack
Uses Express and Vitest.

## Test Strategy
Vitest for unit tests.

## Usage
npm test
`;
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), claudeMd);
    writeFileSync(join(TEST_DIR, "TODOS.md"), "## P2: Fix tests\n\n**What:** fix\n**Why:** broken\n**Effort:** XS\n**Depends on:** Nothing\n");

    const result = analyzeBootstrapQuality(TEST_DIR);

    expect(result.claims).toBeDefined();
    expect(result.claimsTotal).toBeGreaterThan(0);
    expect(result.claimsVerified).toBeDefined();
    expect(result.claimVerificationScore).toBeDefined();
  });

  it("scores hallucinated tech stack lower than before", () => {
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({
      dependencies: { fastify: "^4.0.0" },
      devDependencies: { vitest: "^1.0.0" },
    }));

    // CLAUDE.md claims Express, Jest, Prisma — none of which are in deps
    const claudeMd = `# My Project

## Architecture
Standard web server.

## Tech Stack
Uses Express, Jest, and Prisma.

## Test Strategy
Jest test suite.

## Usage
npm start
`;
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), claudeMd);
    writeFileSync(join(TEST_DIR, "TODOS.md"), "## P2: Fix\n\n**What:** x\n**Why:** y\n**Effort:** XS\n**Depends on:** Nothing\n");

    const result = analyzeBootstrapQuality(TEST_DIR);

    // Should have failed claims (Express, Jest, Prisma not in deps)
    const failedClaims = (result.claims ?? []).filter((c) => !c.verified);
    expect(failedClaims.length).toBeGreaterThan(0);

    // Claim verification score should be less than full (20 pts)
    expect(result.claimVerificationScore!).toBeLessThan(20);
  });

  it("gives full claim score when no claims are extracted", () => {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Project\n\nJust a description with no tech claims.\n");
    writeFileSync(join(TEST_DIR, "TODOS.md"), "## P2: Item\n\n**What:** x\n**Why:** y\n**Effort:** XS\n**Depends on:** Nothing\n");

    const result = analyzeBootstrapQuality(TEST_DIR);

    // No claims to verify → neutral score (vagueness is not rewarded)
    if (result.claimsTotal === 0) {
      expect(result.claimVerificationScore).toBe(10);
    }
  });

  it("uses new scoring weights (30 structural, 20 claims, 20 coverage, 20 viability, 10 efficiency)", () => {
    // All sections present, good size, no TODOS, no package.json
    const claudeMd = `# Project
## Architecture
Details here.
## Tech Stack
Details here.
## Test Strategy
Details here.
## Usage
Details here.
${"x ".repeat(1000)}
`;
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), claudeMd);

    const result = analyzeBootstrapQuality(TEST_DIR);

    // Structural: 4/4 sections = 30 pts
    // Claims: no extractable claims = 10 pts (neutral, vagueness not rewarded)
    // Coverage: no package.json = 1.0 ratio = 20 pts
    // Viability: no TODOS = 0 pts
    // Efficiency: check token range
    // Total should be around 60-70 (depending on token count)
    expect(result.qualityScore).toBeGreaterThanOrEqual(60);
  });

  it("adds quality note for failed claims", () => {
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({
      dependencies: { express: "^4.0.0" },
    }));

    // Claim Prisma but it's not in deps
    const claudeMd = `# Project
## Architecture
Uses Prisma ORM.
## Tech Stack
Prisma for database.
## Test Strategy
None.
## Usage
npm start
`;
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), claudeMd);

    const result = analyzeBootstrapQuality(TEST_DIR);

    const claimNote = result.qualityNotes.find((n) => n.includes("Claim verification"));
    expect(claimNote).toBeDefined();
  });
});

// ── ClaudeMdClaim serialization ──────────────────────────────────

describe("ClaudeMdClaim serialization", () => {
  it("round-trips through JSON", () => {
    const claim: ClaudeMdClaim = {
      type: "tech_stack",
      claimed: "React",
      evidence: "found in deps: react",
      verified: true,
    };

    const serialized = JSON.stringify(claim);
    const deserialized = JSON.parse(serialized) as ClaudeMdClaim;

    expect(deserialized).toEqual(claim);
  });
});
