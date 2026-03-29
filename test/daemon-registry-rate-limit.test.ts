/**
 * Cross-instance rate limit coordination tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setGlobalRateLimitHold, readGlobalBudget } from "../src/daemon-registry.js";
import { safeWriteJSON } from "../src/safe-json.js";
import type { GlobalBudget } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-registry-ratelimit-tmp");

function writeGlobalBudget(overrides: Partial<GlobalBudget> = {}): void {
  const budget: GlobalBudget = {
    date: new Date().toISOString().slice(0, 10),
    totalUsd: 5,
    jobCount: 3,
    byInstance: { "worker-1": { totalUsd: 2, jobCount: 1 }, "worker-2": { totalUsd: 3, jobCount: 2 } },
    ...overrides,
  };
  safeWriteJSON(join(TEST_DIR, "global-budget.json"), budget);
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("setGlobalRateLimitHold", () => {
  it("sets rateLimitResetAt on global budget", () => {
    writeGlobalBudget();
    const resetAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    setGlobalRateLimitHold(TEST_DIR, resetAt, "worker-1");

    const budget = readGlobalBudget(TEST_DIR);
    expect(budget.rateLimitResetAt).toBe(resetAt);
    // Other fields preserved
    expect(budget.totalUsd).toBe(5);
    expect(budget.jobCount).toBe(3);
  });

  it("extends hold (later time wins)", () => {
    const earlyReset = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const lateReset = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    writeGlobalBudget({ rateLimitResetAt: earlyReset });
    setGlobalRateLimitHold(TEST_DIR, lateReset, "worker-2");

    const budget = readGlobalBudget(TEST_DIR);
    expect(budget.rateLimitResetAt).toBe(lateReset);
  });

  it("does NOT shorten hold (earlier time ignored)", () => {
    const lateReset = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const earlyReset = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    writeGlobalBudget({ rateLimitResetAt: lateReset });
    setGlobalRateLimitHold(TEST_DIR, earlyReset, "worker-1");

    const budget = readGlobalBudget(TEST_DIR);
    expect(budget.rateLimitResetAt).toBe(lateReset);
  });

  it("sets hold when no prior hold exists", () => {
    writeGlobalBudget(); // No rateLimitResetAt
    const resetAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();

    setGlobalRateLimitHold(TEST_DIR, resetAt, "worker-1");

    const budget = readGlobalBudget(TEST_DIR);
    expect(budget.rateLimitResetAt).toBe(resetAt);
  });

  it("creates budget file if missing", () => {
    // Don't write any budget file
    const resetAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();

    setGlobalRateLimitHold(TEST_DIR, resetAt, "worker-1");

    const budget = readGlobalBudget(TEST_DIR);
    expect(budget.rateLimitResetAt).toBe(resetAt);
  });
});
