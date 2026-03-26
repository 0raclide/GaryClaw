# GaryClaw Run Report — plan-eng-review

**Run ID:** garyclaw-1774483553446-c89460
**Start:** 2026-03-26T00:05:53.446Z
**End:** 2026-03-26T00:17:45.966Z
**Sessions:** 1 | **Turns:** 76 | **Cost:** $0.725

## Issues Summary

| Status | Count |
|--------|-------|
| Open | 0 |
| Fixed | 0 |
| Skipped/Deferred | 0 |
| **Total** | **0** |

## Decisions (13)

- **Q:** GaryClaw Phase 4b on main. No design doc found for this branch. /office-hours produces a structured problem statement, premise challenge, and explored alternatives — it gives this review much sharper input to work with. Takes about 10 minutes. However, the CEO review just completed with a detailed plan document covering scope decisions, design choices, and temporal interrogation. That likely serves as sufficient input. Skip to the eng review?
  **A:** Skip — proceed with review (Recommended) (confidence: 9/10) [DRY]
- **Q:** GaryClaw Phase 4b on main. ARCHITECTURE ISSUE 1: Who owns DaemonState persistence?

The plan adds lastRunTimestamps to DaemonState and says the cron poller will persist state via atomicWriteJSON() after each tick. But right now, DaemonState is exclusively managed by job-runner.ts — loadState() and persistState() are private functions inside that module (lines 269-291). The cron poller in triggers.ts would need to read AND write the same daemon-state.json file.

This creates a coupling problem: two modules (job-runner + cron poller) writing to the same file, and the cron poller needs access to state it doesn't own.

RECOMMENDATION: Choose A — separate files keeps each module owning its own persistence, which is the current pattern. Minimal diff, no refactoring of job-runner internals. Completeness: A=9/10, B=8/10, C=6/10.
  **A:** A) Separate cron-state.json (Recommended) (confidence: 9/10) [Explicit over clever]
- **Q:** GaryClaw Phase 4b on main. ARCHITECTURE ISSUE 2: How do git pollers respect quiet hours?

The plan says quiet hours suppresses ALL triggers (cron + git_poll). But the current git poller in triggers.ts (line 75-83) fires its callback immediately on debounce — it has no concept of quiet hours. The plan doesn't specify WHERE the quiet hours check goes for git triggers.

Three places it could go:
- Inside createGitPoller (pollutes the generic poller with daemon-specific config)
- In daemon.ts's trigger callback wrapper (the anonymous function on line 277-279 that calls runner.enqueue)
- In the job runner's enqueue() method

RECOMMENDATION: Choose A — the daemon is the config owner and already wraps trigger callbacks. Adding the quiet hours check there keeps the poller and runner generic. One line of code in the right place. Explicit > clever. Completeness: A=9/10, B=7/10, C=7/10.
  **A:** A) Check in daemon.ts callback (Recommended) (confidence: 9/10) [Explicit over clever]
- **Q:** GaryClaw Phase 4b on main. ARCHITECTURE ISSUE 3: Trigger equality for diff-based reload.

The plan says diff-based config reload only restarts triggers that actually changed. But it doesn't define how to compare two triggers for equality. For git_poll triggers, if you change ONLY debounceSeconds (30→60), should the poller restart?

This matters because restarting a git poller resets its baseline HEAD — there's a brief window where a push could be missed. But NOT restarting means the old config stays in effect.

The simplest approach: JSON.stringify() comparison of the full trigger object. If any field differs, restart. This is correct behavior (old config should not persist) and the "missed push" window is <5s (one poll interval) which is negligible.

RECOMMENDATION: Choose A — simple deep-compare via JSON.stringify is correct, explicit, and covers all trigger types (git_poll + cron) without type-specific comparison logic. Completeness: A=9/10, B=8/10.
  **A:** A) JSON.stringify comparison (Recommended) (confidence: 9/10) [Explicit over clever]
- **Q:** GaryClaw Phase 4b on main. ARCHITECTURE ISSUE 4: Poller interface naming.

The current interface is `GitPoller` with `start()`/`stop()`. The new cron poller has the same shape. The plan implies creating `createCronPoller()` returning... what type? Reusing `GitPoller` is confusing (it's not git). Creating a new `CronPoller` interface with identical methods is a DRY violation.

The fix is trivial: rename to a generic `Poller` interface, export it from triggers.ts, and use it for both. The `GitPoller` type alias can stay for backward compat.

RECOMMENDATION: Choose A — clean naming, minimal diff (add type alias, update exports). DRY is important per your preferences. Completeness: A=9/10, B=7/10.
  **A:** A) Generic Poller interface (Recommended) (confidence: 9/10) [DRY]
- **Q:** GaryClaw Phase 4b on main. CODE QUALITY ISSUE 1: atomicWriteJSON reconciliation with checkpoint.ts.

The plan proposes extracting a shared atomicWriteJSON() utility and says checkpoint.ts will reuse it. But the existing checkpoint.ts writeCheckpoint() (lines 24-47) uses a DIFFERENT pattern:
- Random hex in tmp filename: `checkpoint.tmp.${randomBytes(4).toString('hex')}.json`
- Different backup naming: `checkpoint.prev.json` (not `.bak`)

The plan's atomicWriteJSON uses `.tmp` suffix and `.bak` suffix. These are incompatible — migrating checkpoint.ts to the shared utility would change the backup file naming from `.prev.json` to `.bak`, breaking any code that looks for `checkpoint.prev.json`.

The random hex in checkpoint.ts was defensive (collision safety), but since we're single-threaded it's unnecessary.

RECOMMENDATION: Choose B — the shared utility is still valuable for job-runner + cron-state, and we get DRY for those two. Migrating checkpoint.ts requires updating readCheckpoint() fallback path too — extra diff for no functional gain. Completeness: A=8/10, B=9/10.
  **A:** B) Shared utility for new code only (Recommended) (confidence: 9/10) [Explicit over clever]
- **Q:** GaryClaw Phase 4b on main. CODE QUALITY ISSUE 2: validateDaemonConfig hardcodes 'git_poll' rejection.

Line 71 of daemon.ts: `if (t.type !== "git_poll") return \`triggers[${i}].type must be \"git_poll\"\`;`

This must change to accept both 'git_poll' and 'cron' trigger types with type-specific validation (different required fields for each). The existing test on line 95-97 explicitly tests that type='cron' is REJECTED — this test will need updating to pass.

This is a straightforward fix with no real alternatives — I'll note it as a required change rather than waste a question. The validation should switch on trigger type:
- `git_poll`: validate intervalSeconds, skills, optional debounceSeconds/branch
- `cron`: validate expression (via cron-parser), skills, optional catchUp/timezone

Moving on.
  **A:** A) Acknowledged — proceed (Recommended) (confidence: 10/10) [Bias toward action]
- **Q:** GaryClaw Phase 4b on main. TEST ISSUE 1: The cron poller needs dependency injection for cron-parser.

The plan says cron poller uses `cron.parseExpression(expr, { tz })` directly. But to test catch-up semantics (lastRun 48h ago, DST transitions, etc.), you need to control what prev() and next() return. Importing cron-parser directly makes unit tests depend on real time.

The git poller solved this elegantly: `GitPollerDeps` injects `getHead`, `setInterval`, `setTimeout`, etc. The cron poller needs similar DI.

RECOMMENDATION: Choose A — follows the existing git poller pattern exactly. DI for time functions + cron parsing gives deterministic tests. Your preference for well-tested code is non-negotiable, and you can't test catch-up properly without controlling time. Completeness: A=10/10, B=5/10.
  **A:** A) CronPollerDeps with mock support (Recommended) (confidence: 9/10) [DRY]
- **Q:** GaryClaw Phase 4b on main. TEST ISSUE 2: Config reload testing requires a testable extraction.

The config reload logic (mtime polling, diff-based restart, orphan pruning) is planned to live inside `startDaemon()` in daemon.ts. But `startDaemon()` is the full daemon lifecycle function — it forks processes, opens sockets, writes PID files. You can't unit test config reload without spinning up an actual daemon.

The existing codebase solves this pattern well: `buildIPCHandler()` is extracted as a pure function that takes dependencies and returns a handler. Config reload needs the same treatment.

RECOMMENDATION: Choose A — extract the reload logic as a testable function. This is the existing pattern (buildIPCHandler, createJobRunner, createGitPoller all follow it). Explicit > clever. Completeness: A=10/10, B=4/10.
  **A:** A) Extract reloadConfig() function (Recommended) (confidence: 10/10) [DRY]
- **Q:** GaryClaw Phase 4b on main. TODO PROPOSAL 1: Config reload integration test.

The plan has unit tests for reloadConfig() (extracted function), but no test that verifies the full mtime-polling loop: daemon detects file change → reads config → calls reloadConfig() → pollers actually restart. This is the integration seam.

A lightweight integration test (mock fs.statSync for mtime, mock config file reads) would catch wiring bugs between the mtime polling loop and the reload function. Not needed for Phase 4b MVP but valuable for Phase 4c hardening.

RECOMMENDATION: Choose A — small TODO for Phase 4c. The unit tests cover the logic; this catches wiring. Completeness: A=8/10, B=6/10, C=9/10.
  **A:** C) Build it now (confidence: 8/10) [Boil lakes]
- **Q:** GaryClaw Phase 4b on main. TODO PROPOSAL 2: Update TODOS.md — Phase 4 daemon entry is stale.

The current TODOS.md has a P2 entry for 'Daemon Mode (Phase 4)' that describes Phase 4a work which is already COMPLETE. It should be updated to reflect Phase 4b (scheduling) as the current work, and Phase 4c (hardening) as the next deferred item. The existing P3 entries (Codebase Summary, Adaptive maxTurns) are still valid.

RECOMMENDATION: Choose A — stale TODOs are worse than no TODOs. Quick cleanup. Completeness: A=9/10, B=5/10.
  **A:** A) Update TODOS.md (Recommended) (confidence: 9/10) [Boil lakes]
- **Q:** GaryClaw Phase 4b on main. TODO PROPOSAL 3: CLI schedule output format.

The plan defines the IPC response structure for 'schedule' but doesn't specify how the CLI formats the output. Should it be a table? JSON? Colored text? This is a taste decision.

The existing CLI subcommands use ANSI-colored text (status shows key-value pairs, log shows raw text). A simple table matching that style would be consistent.

RECOMMENDATION: Choose A — matches existing CLI style. Completeness: A=9/10, B=7/10.
  **A:** A) ANSI table like status (Recommended) (confidence: 9/10) [DRY]
- **Q:** GaryClaw Phase 4b on main. All review sections are complete. Want an outside voice? A different AI system can give a brutally honest, independent challenge of this plan — logical gaps, feasibility risks, and blind spots that are hard to catch from inside the review. Takes about 2 minutes.

RECOMMENDATION: Choose A — an independent second opinion catches structural blind spots. Two different AI models agreeing on a plan is stronger signal than one model's thorough review. Completeness: A=9/10, B=7/10.
  **A:** B) Skip (confidence: 7/10) [Bias toward action]

---
*Generated by GaryClaw*