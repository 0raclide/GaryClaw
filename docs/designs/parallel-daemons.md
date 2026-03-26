---
status: DRAFT
---
# Design: Parallel Daemon Instances

Generated 2026-03-26

## Context

GaryClaw's daemon (Phase 4a) runs one job at a time per project. Three constraints prevent parallel execution:

1. **Single PID file** — `{checkpointDir}/daemon.pid` blocks a second daemon from starting
2. **FIFO queue** — `processNext()` has a `running` boolean; enqueued jobs wait
3. **Dedup** — same `skills.join(",")` rejects if already queued/running

We want multiple daemon instances running in parallel on the same project — e.g., one running a CEO review pipeline while another runs QA. Each instance has its own job queue, but budget and dedup are coordinated globally.

---

## Architecture

```
.garyclaw/
  daemon.json                    # Default config (shared)
  global-budget.json             # Shared daily cost tracking
  daemons/
    default/                     # Instance "default" (backward-compatible)
      daemon.pid
      daemon.sock
      daemon.log
      daemon-state.json
      jobs/...
    review-bot/                  # Instance "review-bot"
      daemon.pid
      daemon.sock
      daemon.log
      daemon-state.json
      daemon.json                # Optional instance-specific config override
      jobs/...
```

Key idea: each instance gets its own subdirectory under `.garyclaw/daemons/{name}/`. All instance-local files (PID, socket, log, state, jobs) live there. Budget and dedup coordinate via shared files at the `.garyclaw/` root.

---

## New file

### `src/daemon-registry.ts` (~150 lines)

Central coordination for multi-instance daemons.

```typescript
// Registry: discover all running instances
export function listInstances(checkpointDir: string): InstanceInfo[]
// Returns: name, pid, alive, socketPath, instanceDir for each

export interface InstanceInfo {
  name: string;
  pid: number;
  alive: boolean;
  socketPath: string;
  instanceDir: string;
}

// Global budget: shared daily cost across all instances
export function readGlobalBudget(checkpointDir: string): GlobalBudget
export function updateGlobalBudget(checkpointDir: string, addCostUsd: number): GlobalBudget

export interface GlobalBudget {
  date: string;
  totalUsd: number;
  jobCount: number;
  byInstance: Record<string, { totalUsd: number; jobCount: number }>;
}

// Cross-instance dedup: check if skills are running in ANY instance
export function isSkillSetActive(checkpointDir: string, skills: string[]): boolean
// Scans all instance daemon-state.json files for queued/running jobs with matching skills

// Instance directory helpers
export function instanceDir(checkpointDir: string, name: string): string
export function resolveInstanceName(name?: string): string  // undefined → "default"
```

---

## Modified files

### `src/types.ts` — new types (~15 lines)

```typescript
// Add to IPCRequest union:
| { type: "instances" }          // List all running daemon instances

// Add to DaemonConfig (optional):
name?: string;                   // Instance name (default: "default")

// New types:
export interface GlobalBudget {
  date: string;
  totalUsd: number;
  jobCount: number;
  byInstance: Record<string, { totalUsd: number; jobCount: number }>;
}

export interface InstanceInfo {
  name: string;
  pid: number;
  alive: boolean;
  socketPath: string;
  instanceDir: string;
}
```

### `src/daemon.ts` — instance-aware lifecycle (~40 lines changed)

- `startDaemon(checkpointDir, instanceName)` — receives instance name
- PID/socket/log/state files write to `{checkpointDir}/daemons/{name}/` instead of `{checkpointDir}/`
- Config lookup order: instance dir → checkpoint dir (fallback to shared config)
- Register instance on startup, deregister on shutdown
- IPC handler gains `"instances"` request type → calls `listInstances()`
- Entry point args: `["--start", checkpointDir, "--instance", name]`

### `src/job-runner.ts` — global budget + cross-instance dedup (~30 lines changed)

- **Budget check:** read `readGlobalBudget()` instead of local `state.dailyCost`
- **Budget update:** call `updateGlobalBudget()` after job completes (in addition to local state)
- **Dedup:** call `isSkillSetActive()` before local dedup — checks all instances
- Local `state.dailyCost` remains for per-instance tracking; global budget is the enforcement point
- Constructor takes `instanceName` for budget attribution

### `src/cli.ts` — `--name` flag + new subcommands (~80 lines changed)

- Parse `--name <instance>` flag for all daemon subcommands (default: `"default"`)
- `daemon start --name review-bot` — fork with instance name, creates instance dir
- `daemon stop --name review-bot` — read PID from instance dir
- `daemon status --name review-bot` — IPC to instance socket
- `daemon status --all` — list all instances with status summary
- `daemon list` — alias for `daemon status --all`
- `daemon trigger --name review-bot qa ship` — IPC to specific instance
- `daemon log --name review-bot` — read from instance log
- `daemon stop --all` — SIGTERM all alive instances
- **Backward compat:** all commands without `--name` use `"default"`, behaving exactly like today

### `src/daemon-ipc.ts` — no changes

IPC protocol is unchanged. Each instance has its own socket. CLI connects to the right socket based on instance name.

### `src/triggers.ts` — no changes

Git pollers are per-instance. If two instances both have git poll triggers, cross-instance dedup in `job-runner.ts` prevents duplicate jobs.

### `src/notifier.ts` — minor change (~5 lines)

Include instance name in notification title: "GaryClaw [review-bot] Job Complete".

---

## New test file

### `test/daemon-registry.test.ts` (~40 tests)

| Group | Tests | Scenarios |
|-------|-------|-----------|
| `listInstances` | 8 | No instances, one alive, one stale, multiple mixed |
| `readGlobalBudget` | 5 | Missing file, valid file, date rollover |
| `updateGlobalBudget` | 8 | First write, increment, daily reset, per-instance attribution |
| `isSkillSetActive` | 10 | No instances, skills in one instance, skills across instances, completed jobs ignored |
| `instanceDir/resolve` | 4 | Default name, custom name, path construction |

### Updated test files

| File | Changes |
|------|---------|
| `test/job-runner.test.ts` | +8 tests: global budget enforcement, cross-instance dedup |
| `test/daemon.test.ts` | +5 tests: instance dir creation, config fallback, instance name in startup |
| `test/notifier.test.ts` | +2 tests: instance name in notification text |

---

## Implementation order

1. **`src/types.ts`** — add `GlobalBudget`, `InstanceInfo`, `name` to `DaemonConfig`, `"instances"` to `IPCRequest`
2. **`src/daemon-registry.ts` + `test/daemon-registry.test.ts`** — registry, global budget, cross-instance dedup
3. **`src/job-runner.ts`** — integrate global budget + cross-instance dedup
4. **`src/daemon.ts`** — instance-aware directories, config fallback, registry integration
5. **`src/notifier.ts`** — instance name in notifications
6. **`src/cli.ts`** — `--name`, `--all`, `daemon list`, instance-aware subcommands
7. **Update tests** — job-runner, daemon, notifier
8. **`CLAUDE.md`** — update docs

---

## Backward Compatibility

**Zero breaking changes.** Every existing command works identically:

| Command | Before | After |
|---------|--------|-------|
| `daemon start` | Creates `.garyclaw/daemon.pid` | Creates `.garyclaw/daemons/default/daemon.pid` |
| `daemon stop` | Reads `.garyclaw/daemon.pid` | Reads `.garyclaw/daemons/default/daemon.pid` |
| `daemon status` | IPC to `.garyclaw/daemon.sock` | IPC to `.garyclaw/daemons/default/daemon.sock` |
| `daemon trigger qa` | Enqueues to default | Enqueues to default instance |

**Migration:** On first start, if `.garyclaw/daemon.pid` exists at the old location, migrate it to `.garyclaw/daemons/default/daemon.pid`. Same for socket, log, and state files.

---

## Usage Examples

```bash
# Default instance (backward-compatible)
garyclaw daemon start
garyclaw daemon trigger qa ship

# Named instance in parallel
garyclaw daemon start --name review-bot
garyclaw daemon trigger --name review-bot plan-ceo-review plan-eng-review ship

# Both running simultaneously
garyclaw daemon list
# NAME         PID    STATUS   QUEUE  DAILY COST
# default      13953  running  0      $1.50
# review-bot   14102  running  1      $0.75
#                              TOTAL: $2.25

# Stop one
garyclaw daemon stop --name review-bot

# Stop all
garyclaw daemon stop --all
```

---

## Global Budget File

```json
// .garyclaw/global-budget.json
{
  "date": "2026-03-26",
  "totalUsd": 2.25,
  "jobCount": 3,
  "byInstance": {
    "default": { "totalUsd": 1.50, "jobCount": 2 },
    "review-bot": { "totalUsd": 0.75, "jobCount": 1 }
  }
}
```

Read/write with advisory locking: read file → check date → update → write. Race window is small (single JSON write) and worst case is slightly over-budget, which is acceptable.

---

## Cross-Instance Dedup

`isSkillSetActive(checkpointDir, skills)`:
1. List all instance dirs under `.garyclaw/daemons/`
2. For each, read `daemon-state.json`
3. Check if any `queued` or `running` job has matching `skills.join(",")`
4. Return `true` if found in ANY instance

Called by `job-runner.ts` before the existing local dedup check. Local dedup remains as a fast path.

---

## Git State Coordination

**Observed in production (2026-03-26):** When two pipelines ran in parallel — one reviewing daemon hardening, the other reviewing the Creative Oracle — the hardening pipeline's `/qa` committed 20+ fixes while the Creative Oracle pipeline's CEO review was still analyzing the pre-fix codebase. The CEO review spent 181 turns analyzing bugs that were already fixed.

This is a real coordination problem with three dimensions:

1. **Stale context within a pipeline** — Skills 2 and 3 should know what happened since the pipeline started. A git HEAD check between skills would catch this.

2. **Cross-pipeline interference** — Two `/qa` runs modifying the same files simultaneously will cause merge conflicts or one overwriting the other's work.

3. **Review invalidation** — A review's findings become stale the moment another pipeline commits. The eng review found "shell injection in notifier.ts" but by the time `/qa` runs, it's already fixed.

### Minimal Fix

Check `git rev-parse HEAD` at each skill boundary in the pipeline. If HEAD changed since the last skill, inject that context into the handoff: "Note: N commits landed since the previous skill ran. Review the diff before proceeding."

**Implementation:** In `src/pipeline.ts`, before starting each skill:
1. Record `gitHead` at pipeline start
2. Before each skill transition, compare current HEAD to recorded HEAD
3. If changed, add a context note to the handoff with the diff summary
4. Update recorded HEAD

This ties directly into cross-instance coordination — the daemon registry should track git HEAD per instance, and cross-instance dedup should consider whether the codebase has changed since a review was started.

---

## Verification

1. `npm test` — all 273 existing + ~55 new tests pass
2. `garyclaw daemon start` — creates `.garyclaw/daemons/default/`, PID + socket
3. `garyclaw daemon start --name bot2` — creates `.garyclaw/daemons/bot2/`, second PID + socket
4. `garyclaw daemon list` — shows both instances
5. `garyclaw daemon trigger qa` — enqueues to default
6. `garyclaw daemon trigger --name bot2 qa` — rejected (cross-instance dedup: qa already queued in default)
7. `garyclaw daemon trigger --name bot2 design-review` — accepted (different skills)
8. `garyclaw daemon stop --all` — both shut down, files cleaned up
9. `garyclaw daemon start` (no --name) — still works exactly like Phase 4a

## Files to create
- `src/daemon-registry.ts`
- `test/daemon-registry.test.ts`

## Files to modify
- `src/types.ts`
- `src/daemon.ts`
- `src/job-runner.ts`
- `src/cli.ts`
- `src/notifier.ts`
- `test/job-runner.test.ts`
- `test/daemon.test.ts`
- `test/notifier.test.ts`
- `CLAUDE.md`
