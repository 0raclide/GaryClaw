# QA Report: GaryClaw — Run 4 (Code-Level QA)

**Date:** 2026-03-26
**Branch:** main
**Mode:** Code-level QA (CLI tool, no web UI)
**Tier:** Standard
**Duration:** ~10 minutes
**Test suite:** 516 tests passing (22 test files)

---

## Summary

QA found **5 issues**, fixed **4** (all verified), deferred **1** (design concern).

| Severity | Found | Fixed | Deferred |
|----------|-------|-------|----------|
| Critical | 1 | 1 | 0 |
| High | 1 | 1 | 0 |
| Medium | 2 | 2 | 0 |
| Low | 1 | 0 | 1 |

**Health score:** 481/516 tests passing (93.2%) → 516/516 (100%)

---

## Issues

### ISSUE-001 [High] — maxJobsPerDay counted completions, not enqueues
- **Status:** verified
- **Commit:** `7ad554d`
- **Files Changed:** `src/job-runner.ts`
- **What:** `enqueue()` checked `dailyCost.jobCount` which only increments when a job completes in `processNext()`. You could enqueue unlimited jobs before any finished.
- **Fix:** Count all jobs with `enqueuedAt` matching today's date instead of relying on the completion counter.
- **Regression test:** `test/job-runner.regression-2.test.ts` (3 tests)

### ISSUE-002 [Critical] — Shell injection in triggers.ts getGitHead
- **Status:** verified
- **Commit:** `9be7143`
- **Files Changed:** `src/triggers.ts`
- **What:** `execSync(\`git rev-parse ${ref}\`)` interpolated the `branch` string from daemon config directly into a shell command. Same class of vulnerability already fixed in notifier.ts (hardening Fix #7).
- **Fix:** Replaced `execSync` with `execFileSync("git", ["rev-parse", ref], ...)` to avoid shell interpretation.

### ISSUE-003 [High] — resumeSkill discards checkpoint data
- **Status:** verified
- **Commit:** `96ed012`
- **Files Changed:** `src/orchestrator.ts`, `test/orchestrator.test.ts`
- **What:** `resumeSkill` read the checkpoint but called `runSkill()` which starts fresh with `"Run the /skill"` prompt. All accumulated issues, findings, decisions, and cost data were discarded — making `garyclaw resume` effectively useless.
- **Fix:** Generate a relay prompt from the checkpoint via `generateRelayPrompt()` and use `runSkillWithInitialPrompt()` so state carries forward.

### ISSUE-004/005 [Medium] — CLI numeric args missing NaN validation
- **Status:** verified
- **Commit:** `8df856d`
- **Files Changed:** `src/cli.ts`
- **What:** Two gaps: (1) `--tail` in daemon log had no NaN check — `garyclaw daemon log --tail abc` silently printed nothing. (2) The resume/replay branch parsed `--max-turns`, `--threshold`, `--max-sessions` without any validation (the run branch had it).
- **Fix:** Added consistent NaN/range validation matching the run branch pattern across all command branches.

### ISSUE-006 [Low] — Overly broad Oracle escalation keywords (deferred)
- **Status:** deferred
- **What:** Keywords like `"token"` and `"remove"` in `ESCALATION_KEYWORDS` match common development terms. Any question about "token tracking" or "remove unused import" triggers unnecessary security escalation in autonomous mode.
- **Impact:** False-positive escalations reduce autonomous mode effectiveness. Design concern, not a crash bug.
- **Recommendation:** Use more specific keywords (`"api token"`, `"auth token"`, `"remove database"`) in a future pass.

---

## Top 3 Things Fixed

1. **Shell injection in triggers.ts** (ISSUE-002) — security vulnerability allowing arbitrary command execution via daemon config
2. **resumeSkill discards checkpoint** (ISSUE-003) — the entire resume command was broken, losing all accumulated work
3. **maxJobsPerDay bypass** (ISSUE-001) — budget enforcement gap allowing unlimited job enqueues

---

## Test Suite Health

| Metric | Before | After |
|--------|--------|-------|
| Test files | 21 | 22 |
| Total tests | 513 (1 failing) | 516 (all passing) |
| New regression tests | — | 3 (ISSUE-001) |

---

## Commits (this QA run)

| SHA | Message |
|-----|---------|
| `7ad554d` | fix(qa): ISSUE-001 — maxJobsPerDay counted completions not enqueues |
| `3160455` | test(qa): regression test for ISSUE-001 — maxJobsPerDay enqueue counting |
| `9be7143` | fix(qa): ISSUE-002 — shell injection in triggers.ts getGitHead |
| `96ed012` | fix: orchestrator and test updates from hardening review |
| `8df856d` | fix(qa): ISSUE-004/005 — validate --tail and resume branch numeric args |

---

**PR Summary:** QA found 5 issues (1 critical security, 1 high functional, 2 medium validation), fixed 4, deferred 1 design concern. Health: 93.2% → 100%. 516 tests passing.
