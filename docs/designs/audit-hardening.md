---
status: ACTIVE
---
# Design: Audit Hardening — Fix All Gaps from Code Review

Generated 2026-03-26

## Problem

A thorough 4-agent audit of the Phase 5a/5b implementation found quality gaps across source code, tests, and QA fixes. No bugs in production, but dead code, missing test coverage, structural test flaws, and spec deviations that should be fixed before shipping more features.

## Fixes Required

### FIX-1: Wire `createReflectionCanUseTool` or remove it (Dead Code)

**File:** `src/reflection.ts`

The design doc specifies reflection should run as a separate SDK `query()` call with sandboxed `canUseTool`. The function `createReflectionCanUseTool()` (lines 344-371) was built and tested but is never called in production. `runReflection()` does all work algorithmically instead.

**Decision:** Remove the dead code. The algorithmic approach is better — deterministic, no API cost, no latency. Delete `createReflectionCanUseTool` and its tests. Add a comment explaining the design deviation.

### FIX-2: Add pipeline implement integration test

**File:** `test/pipeline.test.ts` (or new `test/pipeline-implement.test.ts`)

The `skillName === "implement"` branch in `executePipelineFrom()` has zero test coverage. Need tests that verify:
1. When `skillName === "implement"`, `buildImplementPrompt` is called (not `buildContextHandoff`)
2. All previous skills (not just the last one) are passed to `buildImplementPrompt`
3. The implement prompt is passed to `runSkillWithPrompt`

Mock the orchestrator (`runSkill`, `runSkillWithInitialPrompt`) and the implement module (`buildImplementPrompt`) to test the dispatch logic.

### FIX-3: Add `loadDesignDoc` tests

**File:** `test/implement.test.ts`

`loadDesignDoc()` is exported, has 3 code paths (absolute path, relative path, file not found), and zero tests. Add tests:
1. Loads file from absolute path
2. Loads file from relative path (resolved against projectDir)
3. Returns null for nonexistent path
4. Returns null when file read fails

### FIX-4: Add `buildImplementPrompt` with `config.designDoc` test

**File:** `test/implement.test.ts`

No test verifies that `buildImplementPrompt` uses `config.designDoc` when set (the `loadDesignDoc` path at line 179). Add a test with `config.designDoc = "docs/designs/specific.md"` that verifies the specific doc is loaded instead of auto-discovery.

### FIX-5: Fix tautological assertion in reflection test

**File:** `test/reflection.test.ts`

Line 440: `expect(result.reopenedCount).toBeGreaterThanOrEqual(0)` always passes. Change to `expect(result.reopenedCount).toBe(1)` (or the correct expected value based on test data).

### FIX-6: Fix regression-1 tests to import real code

**File:** `test/qa-regressions.regression-1.test.ts`

ISSUE-001 (checkpoint dedup), ISSUE-006 (job pruning), and ISSUE-015 (NaN CLI args) replicate fix logic locally instead of importing the actual source functions. A regression in the real code would not be caught.

Rewrite these tests to import and test the actual functions:
- ISSUE-001: Import from `checkpoint.ts`
- ISSUE-006: Import `createJobRunner` from `job-runner.ts`
- ISSUE-015: Import `parseArgs` from `cli.ts`

### FIX-7: Add cost accumulation across relays regression test

**File:** `test/orchestrator.test.ts` or new regression test file

The cost accumulation fix (ISSUE-001 from QA batch 1) has no regression test. Add a test that runs a multi-session orchestrator mock and verifies `estimatedCostUsd` accumulates across relay sessions, not resets.

### FIX-8: Replace silent catch in orchestrator

**File:** `src/orchestrator.ts`

Line 524: bare `catch {}` swallows reflection errors silently. Replace with `catch (err) { /* reflection is non-fatal */ }` or add `console.warn` to match the project's pattern.

### FIX-9: Clean up unused imports and dead code

**Files:**
- `src/safe-json.ts` line 51: Fix no-op ternary `(validate ? parsed : parsed) as T` → just `parsed as T`
- `src/oracle-memory.ts` line 30: Remove unused type import of `ORACLE_MEMORY_BUDGETS`
- `src/reflection.ts` lines 19-20: Combine duplicate `import { join } from "node:path"` and `import { resolve } from "node:path"` into single import
- `src/reflection.ts` line 27: Remove unused `RunReport` import
- `src/reflection.ts` line 311: Either compute `skippedPreExisting` or remove the field

### FIX-10: Remove double truncation in oracle-memory

**File:** `src/oracle-memory.ts`

Lines 167-168: `resolveLayered()` already truncates via `readAndSanitize()`, then the caller truncates again. Remove the redundant second truncation.

### FIX-11: Add Oracle health to daemon status

**Files:** `src/daemon.ts`, `src/cli.ts`

The design doc specifies: "`daemon status` shows Oracle health: memory file ages, decision accuracy score, last reflection timestamp."

In `buildIPCHandler` status response, add oracle health data by reading `metrics.json` from the project's oracle-memory directory. In the CLI `daemon status` display, show:
- Decision accuracy (if metrics exist)
- Last reflection timestamp
- Circuit breaker status

## Implementation Order

1. `src/reflection.ts` — Remove `createReflectionCanUseTool` and related dead code (FIX-1)
2. `src/orchestrator.ts` — Fix silent catch (FIX-8)
3. `src/safe-json.ts`, `src/oracle-memory.ts`, `src/reflection.ts` — Clean up imports and dead code (FIX-9, FIX-10)
4. `test/implement.test.ts` — Add `loadDesignDoc` tests and `config.designDoc` test (FIX-3, FIX-4)
5. `test/reflection.test.ts` — Fix tautological assertion (FIX-5)
6. `test/qa-regressions.regression-1.test.ts` — Rewrite to import real code (FIX-6)
7. `test/pipeline.test.ts` or new file — Add pipeline implement integration test (FIX-2)
8. `test/orchestrator.test.ts` or new file — Add cost accumulation regression test (FIX-7)
9. `src/daemon.ts`, `src/cli.ts` — Add Oracle health to daemon status (FIX-11)
10. `npm test` — Verify all tests pass

## Verification

1. `npm test` — all existing + new tests pass
2. No dead code remains: `createReflectionCanUseTool` removed
3. Pipeline implement dispatch is tested
4. `loadDesignDoc` is tested
5. regression-1 tests import real functions
6. `daemon status` shows Oracle health when metrics exist
