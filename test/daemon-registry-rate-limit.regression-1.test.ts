/**
 * Regression: ISSUE-001 — global rateLimitResetAt never cleared on expiry.
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * When the global rate limit hold expired, no instance ever cleared it from
 * global-budget.json. clearGlobalRateLimitHold() now removes stale holds.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { clearGlobalRateLimitHold, readGlobalBudget } from "../src/daemon-registry.js";
import { safeWriteJSON } from "../src/safe-json.js";
import type { GlobalBudget } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-registry-clear-ratelimit-tmp");

function writeGlobalBudget(overrides: Partial<GlobalBudget> = {}): void {
  const budget: GlobalBudget = {
    date: new Date().toISOString().slice(0, 10),
    totalUsd: 5,
    jobCount: 3,
    byInstance: { "worker-1": { totalUsd: 2, jobCount: 1 } },
    ...overrides,
  };
  safeWriteJSON(join(TEST_DIR, "global-budget.json"), budget);
}

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("clearGlobalRateLimitHold", () => {
  it("removes rateLimitResetAt from global budget", () => {
    const expiredReset = new Date(Date.now() - 60_000).toISOString();
    writeGlobalBudget({ rateLimitResetAt: expiredReset });

    clearGlobalRateLimitHold(TEST_DIR);

    const budget = readGlobalBudget(TEST_DIR);
    expect(budget.rateLimitResetAt).toBeUndefined();
    // Other fields preserved
    expect(budget.totalUsd).toBe(5);
    expect(budget.jobCount).toBe(3);
  });

  it("no-ops when no hold exists", () => {
    writeGlobalBudget(); // No rateLimitResetAt

    clearGlobalRateLimitHold(TEST_DIR);

    const budget = readGlobalBudget(TEST_DIR);
    expect(budget.rateLimitResetAt).toBeUndefined();
    expect(budget.totalUsd).toBe(5);
  });

  it("preserves byInstance data after clearing", () => {
    const expiredReset = new Date(Date.now() - 60_000).toISOString();
    writeGlobalBudget({ rateLimitResetAt: expiredReset });

    clearGlobalRateLimitHold(TEST_DIR);

    const budget = readGlobalBudget(TEST_DIR);
    expect(budget.byInstance["worker-1"]).toEqual({ totalUsd: 2, jobCount: 1 });
  });
});
