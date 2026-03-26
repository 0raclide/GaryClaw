---
status: ACTIVE
---
# Design: Phase 4b — Cron Scheduling + Config Reload + Small Fixes

Generated 2026-03-26

## Problem

The daemon currently only triggers jobs via git polling or manual CLI trigger. Users need time-based scheduling (e.g., "run QA every night at 2am") and the ability to reload config without restarting the daemon. Additionally, two small deferred fixes should be bundled: stale PID cleanup and narrower Oracle escalation keywords.

## Features

### 1. Cron Trigger

Add `CronTrigger` alongside the existing `GitPollTrigger` in the trigger system.

**Types (add to `src/types.ts`):**

```typescript
export interface CronTrigger {
  type: "cron";
  expression: string;     // standard 5-field cron: "0 2 * * *" = 2am daily
  skills: string[];
  designDoc?: string;     // optional design doc for implement skill
}

export type TriggerConfig = GitPollTrigger | CronTrigger;
```

**Implementation (`src/triggers.ts`):**

Add `createCronPoller()` alongside `createGitPoller()`. Uses a simple interval-based approach:
- Parse the cron expression into next-run time
- Check every 60 seconds if current time >= next-run
- On match: fire callback, compute next-run
- No external cron library — implement a minimal 5-field parser (minute, hour, day-of-month, month, day-of-week)

The cron parser must handle: `*`, specific numbers, ranges (`1-5`), steps (`*/15`), and comma-separated values (`1,15,30`). Reject anything else with a validation error.

**Validation:** Add cron expression validation in `validateDaemonConfig()`. Invalid expressions: skip the trigger with a warning, start daemon with remaining valid triggers.

### 2. SIGHUP Config Reload

**File:** `src/daemon.ts`

Add a `SIGHUP` handler that:
1. Re-reads `daemon.json`
2. Validates the new config
3. If valid: update budget via `runner.updateBudget()`, restart pollers with new trigger configs
4. If invalid: keep old config, log warning
5. In-flight jobs keep the config snapshot from when they started (same pattern as `updateBudget()`)

**Reload boundary:** Config changes apply only to:
- Future job enqueues (new budget limits)
- New poller intervals (old pollers stopped, new ones started)
- NOT in-flight jobs (they keep their original config snapshot)

### 3. Stale PID Cleanup on Startup

**File:** `src/daemon.ts`

Currently, if the daemon crashes without cleanup, the PID file persists and blocks a new start (user must manually `daemon stop` the stale PID). Fix:

In `startDaemon()`, after reading an existing PID file, if `isPidAlive()` returns false:
1. Log warning: "Cleaning up stale PID file"
2. Call `cleanupDaemonFiles()` to remove PID + socket
3. Continue startup normally

This is already partially implemented (the check exists) but needs to be more robust: also remove a stale socket file that might block `createIPCServer`.

### 4. Narrow Oracle Escalation Keywords

**File:** `src/oracle.ts`

Current `ESCALATION_KEYWORDS` includes overly broad terms like `"token"` and `"remove"` that trigger false-positive security escalations on questions about "token tracking" or "remove unused import."

Replace broad keywords with specific patterns:
- `"token"` → `"api token"`, `"auth token"`, `"secret token"`, `"access token"`
- `"remove"` → `"remove database"`, `"remove user"`, `"remove account"`, `"delete permanently"`
- Keep existing specific keywords: `"delete"`, `"drop"`, `"production"`, `"deploy"`, `"secret"`, `"credential"`, `"password"`, `"key"`

Change the matching from word-level to phrase-level: check if the question text (lowercased) contains any escalation phrase, not just individual words.

## New Code

### `src/triggers.ts` additions (~100 lines)

```typescript
// Cron expression parser
export function parseCronExpression(expr: string): CronSchedule | null

// Cron schedule checker
export function matchesCronSchedule(schedule: CronSchedule, date: Date): boolean

// Cron poller (same interface as GitPoller)
export function createCronPoller(
  config: CronTrigger,
  onTrigger: (skills: string[], detail: string) => void,
  deps?: { now?: () => Date; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval }
): GitPoller  // same start/stop interface
```

### `src/daemon.ts` modifications (~30 lines)

- Add SIGHUP handler in `startDaemon()`
- Add `reloadConfig()` helper that validates + applies new config
- Improve stale PID cleanup

### `src/oracle.ts` modifications (~15 lines)

- Replace `ESCALATION_KEYWORDS` array with `ESCALATION_PHRASES` array
- Update `shouldEscalate()` to use phrase matching

## Test Plan

### `test/triggers.test.ts` additions (~20 tests)

- `parseCronExpression`: valid expressions (every minute, specific hour, ranges, steps, day-of-week), invalid expressions (6 fields, bad range, non-numeric), edge cases (*/0, 60 minutes)
- `matchesCronSchedule`: matches exact time, doesn't match wrong hour, range matching, step matching, day-of-week matching
- `createCronPoller`: fires at correct time, doesn't fire between intervals, stop prevents future fires

### `test/daemon.test.ts` additions (~5 tests)

- SIGHUP reload: valid config updates budget and restarts pollers
- SIGHUP reload: invalid config keeps old config
- Stale PID cleanup on startup

### `test/oracle.test.ts` additions (~5 tests)

- "token tracking" does NOT escalate
- "remove unused import" does NOT escalate
- "delete the production database" DOES escalate
- "api token exposed" DOES escalate

## Implementation Order

1. `src/types.ts` — Add `CronTrigger` type, update `TriggerConfig` union
2. `src/triggers.ts` — Cron parser + poller
3. `test/triggers.test.ts` — Cron tests
4. `src/oracle.ts` — Narrow escalation keywords
5. `test/oracle.test.ts` — Escalation tests
6. `src/daemon.ts` — SIGHUP reload + stale PID cleanup
7. `test/daemon.test.ts` — Reload and PID tests
8. `src/cli.ts` — Update help text with cron examples
9. `npm test` — Verify all tests pass

## Verification

1. `npm test` — all existing + ~30 new tests pass
2. Cron parser handles standard 5-field expressions
3. SIGHUP reloads config without restart
4. "token tracking" no longer triggers escalation
5. Stale PID files cleaned up on daemon start
