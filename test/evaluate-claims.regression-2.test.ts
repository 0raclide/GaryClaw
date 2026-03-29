/**
 * Evaluate claims regression-2: per-feature test count fix, PostgreSQL indirect deps,
 * and NihontoWatch fixture integration.
 *
 * Bug 1: Multiple test-count claims (per-feature pattern) were each compared against
 *         the repo-wide total, causing all to fail. Fix: mark as per-feature verified.
 * Bug 2: PostgreSQL via Supabase was not recognized because KNOWN_FRAMEWORKS only
 *         checked for "pg"/"@types/pg". Fix: extend entry with indirect dep packages.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  verifyClaudeMdClaims,
  analyzeBootstrapQuality,
  extractDependencies,
  KNOWN_FRAMEWORKS,
} from "../src/evaluate.js";

import type { ClaudeMdClaim } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-evaluate-claims-reg2-tmp");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── Bug 1: Per-feature test count verification ──────────────────

describe("verifyClaudeMdClaims — per-feature test counts", () => {
  it("marks multiple test-count claims as per-feature verified", () => {
    // Create 15 test files in the repo
    mkdirSync(join(TEST_DIR, "tests"), { recursive: true });
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(TEST_DIR, "tests", `mod-${i}.test.ts`), "");
    }

    // Per-feature claims: 40 + 159 + 93 — none match the repo total (15)
    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-count:40", evidence: "", verified: false },
      { type: "test_directory", claimed: "test-count:159", evidence: "", verified: false },
      { type: "test_directory", claimed: "test-count:93", evidence: "", verified: false },
    ];

    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);

    // All should be verified as per-feature counts
    for (const r of result) {
      expect(r.verified).toBe(true);
      expect(r.evidence).toContain("per-feature count");
      expect(r.evidence).toContain("15 total test files in repo");
    }
  });

  it("single test-count claim within 20% tolerance verifies against actual total", () => {
    mkdirSync(join(TEST_DIR, "test"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(TEST_DIR, "test", `f-${i}.test.ts`), "");
    }

    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-count:10", evidence: "", verified: false },
    ];

    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toContain("actual count: 10");
  });

  it("single test-count claim outside 20% tolerance fails with explicit message", () => {
    mkdirSync(join(TEST_DIR, "test"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(TEST_DIR, "test", `f-${i}.test.ts`), "");
    }

    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-count:100", evidence: "", verified: false },
    ];

    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(false);
    expect(result[0].evidence).toBe("claimed 100, found 10 (±20% tolerance failed)");
  });

  it("two test-count claims triggers per-feature path", () => {
    // Even just 2 per-feature counts should trigger the multi-count path
    mkdirSync(join(TEST_DIR, "tests"), { recursive: true });
    writeFileSync(join(TEST_DIR, "tests", "a.test.ts"), "");

    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-count:25", evidence: "", verified: false },
      { type: "test_directory", claimed: "test-count:50", evidence: "", verified: false },
    ];

    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    expect(result[0].verified).toBe(true);
    expect(result[1].verified).toBe(true);
    expect(result[0].evidence).toContain("per-feature count");
  });

  it("mixed test-dir and test-count claims: test-dir verified independently", () => {
    mkdirSync(join(TEST_DIR, "tests"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(TEST_DIR, "tests", `m-${i}.test.ts`), "");
    }

    const claims: ClaudeMdClaim[] = [
      { type: "test_directory", claimed: "test-dir:tests", evidence: "", verified: false },
      { type: "test_directory", claimed: "test-count:40", evidence: "", verified: false },
      { type: "test_directory", claimed: "test-count:93", evidence: "", verified: false },
    ];

    const result = verifyClaudeMdClaims(claims, TEST_DIR, []);
    // test-dir verified normally
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toBe("directory exists");
    // test-counts verified as per-feature
    expect(result[1].verified).toBe(true);
    expect(result[1].evidence).toContain("per-feature count");
    expect(result[2].verified).toBe(true);
  });
});

// ── Bug 2: PostgreSQL indirect dependency verification ──────────

describe("verifyClaudeMdClaims — PostgreSQL indirect deps", () => {
  it("verifies PostgreSQL claim when @supabase/supabase-js is in deps", () => {
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({
      dependencies: { "@supabase/supabase-js": "^2.45.0" },
    }));

    const deps = extractDependencies(JSON.stringify({
      dependencies: { "@supabase/supabase-js": "^2.45.0" },
    }));

    const claims: ClaudeMdClaim[] = [
      { type: "tech_stack", claimed: "PostgreSQL", evidence: "", verified: false },
    ];

    const result = verifyClaudeMdClaims(claims, TEST_DIR, deps);
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toContain("@supabase/supabase-js");
  });

  it("verifies PostgreSQL claim when @prisma/client is in deps", () => {
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({
      dependencies: { "@prisma/client": "^5.0.0" },
    }));

    const deps = extractDependencies(JSON.stringify({
      dependencies: { "@prisma/client": "^5.0.0" },
    }));

    const claims: ClaudeMdClaim[] = [
      { type: "tech_stack", claimed: "PostgreSQL", evidence: "", verified: false },
    ];

    const result = verifyClaudeMdClaims(claims, TEST_DIR, deps);
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toContain("@prisma/client");
  });

  it("verifies PostgreSQL claim when drizzle-orm is in deps", () => {
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({
      dependencies: { "drizzle-orm": "^0.30.0" },
    }));

    const deps = extractDependencies(JSON.stringify({
      dependencies: { "drizzle-orm": "^0.30.0" },
    }));

    const claims: ClaudeMdClaim[] = [
      { type: "tech_stack", claimed: "PostgreSQL", evidence: "", verified: false },
    ];

    const result = verifyClaudeMdClaims(claims, TEST_DIR, deps);
    expect(result[0].verified).toBe(true);
    expect(result[0].evidence).toContain("drizzle-orm");
  });

  it("fails PostgreSQL claim when no matching deps exist", () => {
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify({
      dependencies: { "express": "^4.0.0" },
    }));

    const deps = extractDependencies(JSON.stringify({
      dependencies: { "express": "^4.0.0" },
    }));

    const claims: ClaudeMdClaim[] = [
      { type: "tech_stack", claimed: "PostgreSQL", evidence: "", verified: false },
    ];

    const result = verifyClaudeMdClaims(claims, TEST_DIR, deps);
    expect(result[0].verified).toBe(false);
    expect(result[0].evidence).toContain("not found");
  });
});

// ── KNOWN_FRAMEWORKS entry validation ───────────────────────────

describe("KNOWN_FRAMEWORKS — PostgreSQL entry", () => {
  it("includes indirect dependency packages", () => {
    const pgPackages = KNOWN_FRAMEWORKS.get("PostgreSQL");
    expect(pgPackages).toBeDefined();
    expect(pgPackages).toContain("@supabase/supabase-js");
    expect(pgPackages).toContain("@prisma/client");
    expect(pgPackages).toContain("prisma");
    expect(pgPackages).toContain("drizzle-orm");
    // Original entries still present
    expect(pgPackages).toContain("pg");
    expect(pgPackages).toContain("@types/pg");
  });
});

// ── Fixture integration: NihontoWatch bootstrap ─────────────────

describe("analyzeBootstrapQuality — NihontoWatch fixture", () => {
  const FIXTURE_DIR = join(__dirname, "fixtures", "nihontowatch-bootstrap");

  it("scores above 50 (quality gate passes)", () => {
    const result = analyzeBootstrapQuality(FIXTURE_DIR);
    expect(result.qualityScore).toBeGreaterThan(50);
  });

  it("has zero test_directory false negatives on per-feature counts", () => {
    const result = analyzeBootstrapQuality(FIXTURE_DIR);
    const testCountClaims = (result.claims ?? []).filter(
      (c) => c.type === "test_directory" && c.claimed.startsWith("test-count:"),
    );
    // Should have per-feature counts extracted
    expect(testCountClaims.length).toBeGreaterThan(0);
    // All should be verified
    for (const c of testCountClaims) {
      expect(c.verified).toBe(true);
      expect(c.evidence).toContain("per-feature count");
    }
  });

  it("verifies PostgreSQL claim via Supabase", () => {
    const result = analyzeBootstrapQuality(FIXTURE_DIR);
    const pgClaim = (result.claims ?? []).find(
      (c) => c.type === "tech_stack" && c.claimed === "PostgreSQL",
    );
    expect(pgClaim).toBeDefined();
    expect(pgClaim!.verified).toBe(true);
    expect(pgClaim!.evidence).toContain("@supabase/supabase-js");
  });
});
