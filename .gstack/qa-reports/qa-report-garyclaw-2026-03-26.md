# QA Report — GaryClaw (Run 4)

| Field | Value |
|-------|-------|
| Date | 2026-03-26 |
| Branch | main |
| Project Type | Node.js CLI tool (no web UI) |
| Test Framework | Vitest 3.2.4 |
| Duration | ~3 minutes |
| Mode | Test suite + code audit (CLI tool, no browser target) |

---

## Summary

| Metric | Value |
|--------|-------|
| Tests (before) | 972 passing / 41 files |
| Tests (after) | 974 passing / 42 files |
| TypeScript | ✅ Clean (zero type errors) |
| Issues found | 7 (2 fixed, 5 deferred) |
| Fixes applied | 2 (verified: 2, best-effort: 0, reverted: 0) |
| Commits | 2 (1 fix + 1 regression test) |
| Coverage | 74% statements, 89% branch, 94% functions |

---

## Health Score: 91.8 / 100

| Category | Score | Weight | Weighted |
|----------|-------|--------|----------|
| Tests | 100 | 25% | 25.0 |
| Type Safety | 100 | 20% | 20.0 |
| Code Quality | 85 | 20% | 17.0 |
| Coverage | 74 | 20% | 14.8 |
| CLI Functionality | 100 | 15% | 15.0 |
| **Total** | | | **91.8** |

---

## Top 3 Things to Fix

1. **ISSUE-001 (HIGH) — child.pid undefined after fork() ✅ FIXED**
   - `src/cli.ts:778`: `fork()` can return undefined PID on failure
   - Fix: Added explicit null check, exits with error message
   - Commit: `5d41282`

2. **ISSUE-002 (MEDIUM) — Unsafe property access on IPC response ✅ FIXED**
   - `src/cli.ts:845`: `d.dailyCost.totalUsd` crashes if `dailyCost` is undefined
   - Fix: Nullish coalescing for `dailyCost` and `currentJob.costUsd`
   - Commit: `5d41282`

3. **ISSUE-003 (MEDIUM) — createSdkOracleQueryFn has zero test coverage**
   - `src/oracle.ts:278-305`: The actual SDK integration path is completely untested
   - Risk: SDK behavior changes wouldn't be caught
   - Status: Deferred (requires SDK mock infrastructure)

---

## All Issues

### ISSUE-001: child.pid undefined after fork() — **FIXED ✅**
- **Severity:** HIGH
- **Category:** Null safety
- **File:** `src/cli.ts:778`
- **Description:** After `fork()`, `child.pid` may be undefined if fork fails silently. The CLI would print "PID undefined" masking the failure.
- **Fix:** Added explicit `!child.pid` check with `process.exit(1)`
- **Commit:** `5d41282`
- **Regression test:** `test/cli.regression-1.test.ts`

### ISSUE-002: Unsafe property access on IPC response — **FIXED ✅**
- **Severity:** MEDIUM
- **Category:** Type safety
- **File:** `src/cli.ts:845`
- **Description:** `d.dailyCost.totalUsd.toFixed(3)` crashes if IPC response doesn't include `dailyCost`. Similarly `d.currentJob.costUsd` could be undefined.
- **Fix:** Nullish coalescing: `d.dailyCost ?? { totalUsd: 0, jobCount: 0 }` and `(d.currentJob.costUsd ?? 0)`
- **Commit:** `5d41282`
- **Regression test:** `test/cli.regression-1.test.ts`

### ISSUE-003: createSdkOracleQueryFn untested — **DEFERRED**
- **Severity:** MEDIUM
- **Category:** Test coverage
- **File:** `src/oracle.ts:278-305`
- **Description:** The function that wraps the SDK for oracle queries has zero test coverage. Tests mock `queryFn` directly, never exercising the generator loop.
- **Risk:** Silent result loss if SDK changes message format.

### ISSUE-004: Shutdown signal race in daemon — **DEFERRED**
- **Severity:** MEDIUM
- **Category:** Race condition
- **File:** `src/daemon.ts:383-389, 425-426`
- **Description:** `processNext()` callback queued before `clearInterval()` may complete after shutdown begins, potentially starting new jobs during teardown.
- **Risk:** Low — tight timing window in single-threaded Node.js.

### ISSUE-005: pipeline.ts startTime non-null assertion — **DEFERRED**
- **Severity:** MEDIUM
- **Category:** Null safety
- **File:** `src/pipeline.ts:297`
- **Description:** `entry.startTime!` uses non-null assertion. If `getGitDiffSummary` throws before `entry.startTime` is set, undefined would be passed to `buildSkillReport`.
- **Risk:** Low — git operations rarely throw.

### ISSUE-006: Socket file TOCTOU in daemon startup — **DEFERRED**
- **Severity:** LOW
- **Category:** Resource conflict
- **File:** `src/daemon.ts:370-372`
- **Description:** Between `unlinkSync` and server bind, another process could create the socket file. Mitigated by single-threaded Node.js and PID file checks.

### ISSUE-007: cli.ts low statement coverage (36%) — **DEFERRED**
- **Severity:** LOW
- **Category:** Test coverage
- **Description:** Most uncovered lines are in the `main()` function's daemon subcommand handlers. The core logic (parseArgs, formatEvent, formatUptime) is well tested.

---

## Coverage Summary

| File | Stmts | Branch | Funcs | Notes |
|------|-------|--------|-------|-------|
| ask-handler.ts | 97% | 82% | 100% | ✅ |
| checkpoint.ts | 99% | 88% | 100% | ✅ |
| cli.ts | 36% | 92% | 67% | ⚠️ Main function integration paths |
| daemon.ts | 69% | 86% | 90% | ⚠️ Lifecycle/shutdown paths |
| daemon-ipc.ts | 81% | 70% | 100% | OK |
| daemon-registry.ts | 95% | 87% | 100% | ✅ |
| implement.ts | 94% | 90% | 100% | ✅ |
| issue-extractor.ts | 90% | 94% | 100% | ✅ |
| job-runner.ts | 98% | 89% | 94% | ✅ |
| notifier.ts | 100% | 90% | 100% | ✅ |
| oracle-memory.ts | 100% | 93% | 100% | ✅ |
| oracle.ts | 87% | 90% | 86% | ⚠️ SDK query fn untested |
| orchestrator.ts | 91% | 88% | 100% | ✅ |
| pipeline.ts | 79% | 91% | 85% | OK |
| reflection-lock.ts | 92% | 81% | 100% | ✅ |
| reflection.ts | 90% | 91% | 100% | ✅ |
| relay.ts | 100% | 86% | 100% | ✅ |
| report.ts | 100% | 87% | 100% | ✅ |
| researcher.ts | 97% | 76% | 89% | ✅ |
| safe-json.ts | 89% | 91% | 100% | ✅ |
| sdk-wrapper.ts | 82% | 91% | 67% | OK |
| token-monitor.ts | 100% | 94% | 100% | ✅ |
| triggers.ts | 100% | 96% | 100% | ✅ |
| types.ts | 100% | 100% | 100% | ✅ |

---

## CLI Functionality Verification

| Command | Status |
|---------|--------|
| `garyclaw` (no args) | ✅ Shows help |
| `garyclaw run` (no skill) | ✅ Error with usage message |
| `garyclaw replay` | ✅ Correct error when no log exists |
| `garyclaw oracle init` | ✅ Creates memory dirs + templates |
| `garyclaw daemon status` | ✅ Reports "not running" correctly |

---

## PR Summary

> QA found 7 issues, fixed 2 (null safety guards in CLI daemon commands), health score 91.8/100. 974 tests passing, zero type errors.
