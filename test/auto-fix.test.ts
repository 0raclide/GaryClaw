/**
 * Auto-Fix Coordinator tests — retry cap, budget cap, config gate,
 * state persistence, prune, cost accumulation.
 *
 * All synthetic data — mocks safe-json I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  maybeEnqueueAutoFix,
  readAutoFixState,
  writeAutoFixState,
  updateAutoFixCost,
  MAX_AUTO_FIX_RETRIES,
  AUTO_FIX_BUDGET_MULTIPLIER,
} from "../src/auto-fix.js";
import type { AutoFixState, MaybeEnqueueAutoFixContext } from "../src/auto-fix.js";

const TMP = join(import.meta.dirname ?? __dirname, ".tmp-auto-fix-test");

function makeCtx(overrides: Partial<MaybeEnqueueAutoFixContext> = {}): MaybeEnqueueAutoFixContext {
  return {
    projectDir: TMP,
    checkpointDir: TMP,
    mergeSha: "abc123def456",
    jobId: "job-001",
    jobCost: 4.0,
    instanceName: "worker-1",
    skills: ["implement", "qa"],
    testOutput: "FAIL: test/foo.test.ts > bar > should pass",
    revertSha: "rev789",
    bugTodoTitle: "P2: Fix post-merge regression from worker-1 (job job-001)",
    enqueue: vi.fn().mockReturnValue("job-fix-001"),
    log: vi.fn(),
    config: { autoFixOnRevert: true },
    ...overrides,
  };
}

describe("auto-fix", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  // ── Constants ──────────────────────────────────────────────────

  describe("constants", () => {
    it("MAX_AUTO_FIX_RETRIES is 2", () => {
      expect(MAX_AUTO_FIX_RETRIES).toBe(2);
    });

    it("AUTO_FIX_BUDGET_MULTIPLIER is 2", () => {
      expect(AUTO_FIX_BUDGET_MULTIPLIER).toBe(2);
    });
  });

  // ── State persistence ──────────────────────────────────────────

  describe("readAutoFixState / writeAutoFixState", () => {
    it("returns empty state when file missing", () => {
      const state = readAutoFixState(TMP);
      expect(state.entries).toEqual({});
    });

    it("round-trips state", () => {
      const state: AutoFixState = {
        entries: {
          abc123: {
            originalMergeSha: "abc123",
            originalJobId: "job-001",
            originalJobCost: 4.0,
            retryCount: 1,
            totalAutoFixCost: 2.0,
            createdAt: new Date().toISOString(),
            lastAttemptAt: new Date().toISOString(),
          },
        },
      };
      writeAutoFixState(TMP, state);
      const read = readAutoFixState(TMP);
      expect(read.entries["abc123"]).toBeDefined();
      expect(read.entries["abc123"].retryCount).toBe(1);
    });

    it("prunes entries older than 24h on read", () => {
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const state: AutoFixState = {
        entries: {
          old_sha: {
            originalMergeSha: "old_sha",
            originalJobId: "job-old",
            originalJobCost: 2.0,
            retryCount: 1,
            totalAutoFixCost: 1.0,
            createdAt: oldDate,
          },
          new_sha: {
            originalMergeSha: "new_sha",
            originalJobId: "job-new",
            originalJobCost: 3.0,
            retryCount: 0,
            totalAutoFixCost: 0,
            createdAt: new Date().toISOString(),
          },
        },
      };
      writeAutoFixState(TMP, state);
      const read = readAutoFixState(TMP);
      expect(read.entries["old_sha"]).toBeUndefined();
      expect(read.entries["new_sha"]).toBeDefined();
    });
  });

  // ── maybeEnqueueAutoFix ─────────────────────────────────────────

  describe("maybeEnqueueAutoFix", () => {
    it("returns disabled when autoFixOnRevert is false", () => {
      const ctx = makeCtx({ config: { autoFixOnRevert: false } });
      const result = maybeEnqueueAutoFix(ctx);
      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe("autoFixOnRevert disabled");
      expect(ctx.enqueue).not.toHaveBeenCalled();
    });

    it("enqueues on first attempt", () => {
      const ctx = makeCtx();
      const result = maybeEnqueueAutoFix(ctx);
      expect(result.enqueued).toBe(true);
      expect(result.reason).toBe("enqueued");
      expect(ctx.enqueue).toHaveBeenCalledWith(
        ["implement", "qa"],
        "post-merge-revert",
        expect.stringContaining("auto-fix attempt 1/2"),
      );
    });

    it("includes test output in trigger detail (truncated to 1500 chars)", () => {
      const longOutput = "X".repeat(2000);
      const ctx = makeCtx({ testOutput: longOutput });
      maybeEnqueueAutoFix(ctx);
      const detail = (ctx.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      expect(detail).toContain("Test output:");
      // 1500 chars of X + prefix should be less than 2000
      const xCount = (detail.match(/X/g) ?? []).length;
      expect(xCount).toBe(1500);
    });

    it("includes merge SHA prefix in trigger detail", () => {
      const ctx = makeCtx({ mergeSha: "deadbeef1234" });
      maybeEnqueueAutoFix(ctx);
      const detail = (ctx.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      expect(detail).toContain("for revert of deadbeef");
    });

    it("increments retryCount on second attempt", () => {
      const ctx = makeCtx();
      maybeEnqueueAutoFix(ctx);

      // Second attempt with same SHA
      const ctx2 = makeCtx();
      const result = maybeEnqueueAutoFix(ctx2);
      expect(result.enqueued).toBe(true);
      const detail = (ctx2.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      expect(detail).toContain("auto-fix attempt 2/2");
    });

    it("blocks at retry cap (2 attempts)", () => {
      const ctx1 = makeCtx();
      maybeEnqueueAutoFix(ctx1);
      const ctx2 = makeCtx();
      maybeEnqueueAutoFix(ctx2);

      // Third attempt should be blocked
      const ctx3 = makeCtx();
      const result = maybeEnqueueAutoFix(ctx3);
      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe("retry_cap_reached");
    });

    it("blocks when budget cap reached", () => {
      // Write state where cost already equals budget cap
      const state: AutoFixState = {
        entries: {
          abc123def456: {
            originalMergeSha: "abc123def456",
            originalJobId: "job-001",
            originalJobCost: 4.0,
            retryCount: 1,
            totalAutoFixCost: 8.0, // 4.0 * 2 = budget cap reached
            createdAt: new Date().toISOString(),
          },
        },
      };
      writeAutoFixState(TMP, state);

      const ctx = makeCtx();
      const result = maybeEnqueueAutoFix(ctx);
      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe("budget_cap_reached");
    });

    it("returns enqueue_failed when enqueue returns null", () => {
      const ctx = makeCtx({ enqueue: vi.fn().mockReturnValue(null) });
      const result = maybeEnqueueAutoFix(ctx);
      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe("enqueue_failed");
    });

    it("persists state after enqueue", () => {
      const ctx = makeCtx();
      maybeEnqueueAutoFix(ctx);

      const state = readAutoFixState(TMP);
      expect(state.entries["abc123def456"]).toBeDefined();
      expect(state.entries["abc123def456"].retryCount).toBe(1);
      expect(state.entries["abc123def456"].lastAttemptAt).toBeDefined();
    });

    it("logs on retry cap", () => {
      // Pre-populate state at retry cap
      const state: AutoFixState = {
        entries: {
          abc123def456: {
            originalMergeSha: "abc123def456",
            originalJobId: "job-001",
            originalJobCost: 4.0,
            retryCount: 2,
            totalAutoFixCost: 4.0,
            createdAt: new Date().toISOString(),
          },
        },
      };
      writeAutoFixState(TMP, state);

      const ctx = makeCtx();
      maybeEnqueueAutoFix(ctx);
      expect(ctx.log).toHaveBeenCalledWith("info", expect.stringContaining("retry cap reached"));
    });

    it("logs on budget cap", () => {
      const state: AutoFixState = {
        entries: {
          abc123def456: {
            originalMergeSha: "abc123def456",
            originalJobId: "job-001",
            originalJobCost: 4.0,
            retryCount: 1,
            totalAutoFixCost: 8.0,
            createdAt: new Date().toISOString(),
          },
        },
      };
      writeAutoFixState(TMP, state);

      const ctx = makeCtx();
      maybeEnqueueAutoFix(ctx);
      expect(ctx.log).toHaveBeenCalledWith("info", expect.stringContaining("budget cap reached"));
    });

    it("omits test output from detail when undefined", () => {
      const ctx = makeCtx({ testOutput: undefined });
      maybeEnqueueAutoFix(ctx);
      const detail = (ctx.enqueue as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
      expect(detail).not.toContain("Test output:");
    });

    it("budget cap is jobCost * AUTO_FIX_BUDGET_MULTIPLIER", () => {
      // $2 job cost -> $4 budget cap. $3.99 spent -> should still enqueue
      const state: AutoFixState = {
        entries: {
          abc123def456: {
            originalMergeSha: "abc123def456",
            originalJobId: "job-001",
            originalJobCost: 2.0,
            retryCount: 1,
            totalAutoFixCost: 3.99,
            createdAt: new Date().toISOString(),
          },
        },
      };
      writeAutoFixState(TMP, state);

      const ctx = makeCtx({ jobCost: 2.0 });
      const result = maybeEnqueueAutoFix(ctx);
      expect(result.enqueued).toBe(true);
    });
  });

  // ── updateAutoFixCost ──────────────────────────────────────────

  describe("updateAutoFixCost", () => {
    it("accumulates cost on matching entry", () => {
      const state: AutoFixState = {
        entries: {
          abc123def456: {
            originalMergeSha: "abc123def456",
            originalJobId: "job-001",
            originalJobCost: 4.0,
            retryCount: 1,
            totalAutoFixCost: 1.5,
            createdAt: new Date().toISOString(),
          },
        },
      };
      writeAutoFixState(TMP, state);

      updateAutoFixCost(TMP, "auto-fix attempt 1/2 for revert of abc123de", 2.5);
      const updated = readAutoFixState(TMP);
      expect(updated.entries["abc123def456"].totalAutoFixCost).toBe(4.0);
    });

    it("no-ops when trigger detail has no SHA match", () => {
      const state: AutoFixState = {
        entries: {
          abc123: {
            originalMergeSha: "abc123",
            originalJobId: "job-001",
            originalJobCost: 4.0,
            retryCount: 1,
            totalAutoFixCost: 1.0,
            createdAt: new Date().toISOString(),
          },
        },
      };
      writeAutoFixState(TMP, state);

      updateAutoFixCost(TMP, "some unrelated detail", 2.0);
      const updated = readAutoFixState(TMP);
      expect(updated.entries["abc123"].totalAutoFixCost).toBe(1.0);
    });

    it("no-ops when no matching SHA prefix in state", () => {
      const state: AutoFixState = { entries: {} };
      writeAutoFixState(TMP, state);

      updateAutoFixCost(TMP, "auto-fix attempt 1/2 for revert of deadbeef", 2.0);
      const updated = readAutoFixState(TMP);
      expect(Object.keys(updated.entries)).toHaveLength(0);
    });
  });
});
