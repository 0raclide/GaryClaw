# GaryClaw Pipeline Report

**Pipeline ID:** pipeline-1774482143458-d7172c
**Skills:** /plan-ceo-review → /plan-eng-review → /ship
**Start:** 2026-03-25T23:42:23.459Z
**End:** 2026-03-26T00:18:25.956Z
**Sessions:** 3 | **Turns:** 236 | **Cost:** $2.773

## Skill Results

### /plan-ceo-review — COMPLETE
- Cost: $1.694
- Time: 2026-03-25T23:42:23.459Z → 2026-03-26T00:05:53.445Z

### /plan-eng-review — COMPLETE
- Cost: $0.725
- Time: 2026-03-26T00:05:53.445Z → 2026-03-26T00:17:45.966Z

### /ship — COMPLETE
- Cost: $0.354
- Time: 2026-03-26T00:17:45.967Z → 2026-03-26T00:18:25.956Z

## Decisions (32)

- **Q:** No design doc found for this branch. /office-hours produces a structured problem statement, premise challenge, and explored alternatives — it gives this review much sharper input to work with. Takes about 10 minutes. The design doc is per-feature, not per-product — it captures the thinking behind this specific change. Would you like to run /office-hours first? → **A:** B) Skip — proceed with standard review (8/10)
- **Q:** We're reviewing Phase 4b for GaryClaw (the daemon scheduling phase) on the main branch. The plan adds cron triggers and config hot-reload to the daemon. I've identified three implementation approaches:

Approach A is the basic version — add cron triggers using node-cron and SIGHUP for config reload. Simple, small diff, but doesn't handle laptop sleep/wake (missed cron windows are silently lost).

Approach B is the laptop-aware version — cron with catch-up semantics (if the laptop was asleep during a scheduled run, it fires when it wakes up) plus file-watch config reload (works cross-platform, no signal needed). More robust but more complex.

Approach C skips cron entirely and only ships config hot-reload. Users who want scheduling can use system crontab + the existing `garyclaw daemon trigger` command.

RECOMMENDATION: Choose B because GaryClaw runs on developer laptops, not servers. Cron without catch-up is actively wrong in this context — you'd schedule a nightly QA run and it would silently never fire because your laptop was asleep. The extra complexity (~15 min CC time) is the difference between "works" and "works correctly."

Completeness: A=6/10, B=9/10, C=4/10 → **A:** B) Smart Scheduling + File Watch (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b review on main branch. Approach B (smart scheduling + file watch) is locked in. Now choosing the review mode — this controls how ambitious we get.

Context: This is a feature enhancement to an existing system (adding scheduling to the daemon). The daemon architecture is solid (Phase 4a shipped clean). The scope is well-defined: cron triggers + config hot-reload. I'd default to SELECTIVE EXPANSION — make the plan bulletproof, but surface any interesting opportunities for you to cherry-pick.

RECOMMENDATION: Choose B (Selective Expansion) — the daemon architecture is proven and this is a natural extension. Hold scope as baseline but let me surface opportunities like resource-aware scheduling, quiet hours, or battery-level gating if they're cheap enough to be worth doing.

Completeness: A=10/10 (everything), B=9/10 (right balance), C=7/10 (safe), D=5/10 (minimal) → **A:** B) SELECTIVE EXPANSION (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b, Selective Expansion cherry-pick #1. QUIET HOURS: Add a config setting like `quietHours: { start: "22:00", end: "07:00" }` that suppresses all cron triggers during those hours. If a trigger fires during quiet hours, it gets deferred to the end of the quiet window. ~20 LOC in the cron poller + ~5 LOC in config validation. Effort: XS. Risk: Low. Prevents surprise 2am notifications when a nightly cron fires and the laptop happens to be awake. → **A:** A) Add to scope (9/10)
- **Q:** GaryClaw Phase 4b, cherry-pick #2. CATCH-UP LIMIT: When the laptop wakes from sleep, the cron poller checks how many windows were missed. Without a limit, a trigger set to every hour that was asleep for 48 hours would fire 48 times at once. The catch-up limit caps it at 1 fire per trigger on wake-up, regardless of how many windows were missed. ~10 LOC in the cron poller. Effort: XS. Risk: Low. This is arguably a bug fix, not an expansion — unbounded catch-up is a thundering herd problem. → **A:** A) Add to scope (10/10)
- **Q:** GaryClaw Phase 4b, cherry-pick #3. CONFIG VALIDATION ON RELOAD: When the file watcher detects a change to daemon.json, validate the new config before applying it. If the new config is invalid (bad cron expression, missing fields, etc.), keep running with the old config and log a warning + send a notification. Without this, a typo in the config file crashes the daemon. ~15 LOC. Effort: XS. Risk: Low. This is a robustness fundamental — production daemons should never crash on config edit. → **A:** A) Add to scope (10/10)
- **Q:** GaryClaw Phase 4b, cherry-pick #4. DAEMON SCHEDULE CLI: Add a `garyclaw daemon schedule` subcommand that shows all configured cron triggers with their next fire time and countdown. Like a friendlier `crontab -l`. Example output:

```
Trigger  | Schedule      | Skills           | Next Run
cron-1   | 0 3 * * *     | qa               | in 4h 23m
cron-2   | 0 9 * * MON   | design-review    | in 2d 8h
git-poll | every 60s     | qa, ship         | (on push)
```

~40 LOC (IPC request type + CLI display). Effort: S. Risk: Low. Gives users visibility into what the daemon is doing. Maps to the engineering preference for observability. → **A:** A) Add to scope (8/10)
- **Q:** GaryClaw Phase 4b on main. Architecture concern: daemon-state.json (which stores job history + lastRunTimestamps) uses a single file write with no rotation. checkpoint.ts already has 2-rotation (write to .tmp, rename, keep previous as .bak) for corruption recovery. If the laptop loses power mid-write to daemon-state.json, the file could be corrupted and all lastRunTimestamps would be lost — causing every cron trigger to fire a catch-up on next daemon start.

RECOMMENDATION: Choose A — reuse the same atomic write pattern from checkpoint.ts. ~10 LOC, eliminates the corruption risk. Maps to the engineering preference for handling more edge cases.

Completeness: A=9/10, B=6/10 → **A:** A) Add 2-rotation to daemon-state.json (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. Edge case: DST transitions. When clocks spring forward (2am→3am), a cron trigger scheduled for 2:30am has no valid fire time. When clocks fall back (2am repeats), a trigger at 1:30am could fire twice. cron-parser likely handles this correctly (it's a mature library), but the behavior should be tested. This is a test gap, not an implementation gap.

RECOMMENDATION: Choose A — adding 2-3 DST edge case tests costs minutes with CC and prevents a subtle bug that would only surface twice a year. Classic 'boil the lake' opportunity.

Completeness: A=9/10, B=6/10 → **A:** A) Add DST edge case tests (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. DRY concern: the 2-rotation atomic write pattern (write to .tmp, rename, keep .bak) currently lives inside checkpoint.ts. You just accepted adding the same pattern to daemon-state.json. Rather than copy-pasting, should we extract a shared `atomicWriteJSON(path, data)` utility that both checkpoint.ts and job-runner.ts use?

RECOMMENDATION: Choose A — it's ~15 LOC for the utility, eliminates duplication, and any future JSON state files get it for free. Maps directly to the DRY engineering preference.

Completeness: A=9/10, B=6/10 → **A:** A) Extract shared atomicWriteJSON utility (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. Long-term trajectory question: quiet hours is currently scoped as a daemon-level config (`DaemonConfig.quietHours?`), but the cron poller is the only consumer. Should git_poll triggers also respect quiet hours? If someone pushes code at 2am, do they want the git poll trigger to auto-run QA and send a notification? Probably not.

RECOMMENDATION: Choose A — quiet hours should apply to ALL triggers, not just cron. It's already at the DaemonConfig level, so the implementation is just adding the `isInQuietHours()` check to the git poller's debounce callback too (~3 LOC). Consistent behavior.

Completeness: A=9/10, B=7/10 → **A:** A) Quiet hours applies to all triggers (Recommended) (9/10)
- **Q:** All 10 review sections are complete. Want an outside voice? A different AI system can give a brutally honest, independent challenge of this plan — logical gaps, feasibility risks, and blind spots that are hard to catch from inside the review. Takes about 2 minutes.

RECOMMENDATION: Choose A — an independent second opinion catches structural blind spots. Two different AI models agreeing on a plan is stronger signal than one model's thorough review. Completeness: A=9/10, B=7/10. → **A:** A) Get the outside voice (Recommended) (8/10)
- **Q:** GaryClaw Phase 4b on main. Cross-model disagreement on catchUpLimit. The review said catchUpLimit guards against future sub-minute poll intervals. The outside voice says it's dead code — the algorithm calls prev() once per tick, so it can NEVER fire more than once. The limit field is impossible to use as designed. Either: (A) remove the field entirely (simpler, honest), (B) fix the algorithm to support it (iterate prev() to find N missed windows, fire up to catchUpLimit). Worth investigating further? → **A:** A) Remove catchUpLimit field (9/10)
- **Q:** GaryClaw Phase 4b on main. Cross-model disagreement on fs.watch. The review used fs.watch as primary + mtime polling as safety net. The outside voice says mtime polling every 5s IS the real implementation, and fs.watch is unreliable dead weight on macOS. Since the daemon already has a 5s processNext() tick, mtime polling is trivially cheap and reliable. fs.watch's only advantage is sub-second detection, which doesn't matter for config reload (nobody needs config applied in <1s).

RECOMMENDATION: Choose A — drop fs.watch entirely. Simpler code, more reliable, no platform quirks. The 5s mtime poll is sufficient.

Completeness: A=9/10, B=7/10 → **A:** A) Drop fs.watch, use mtime-only polling (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. TODO proposal #1: TRIGGER KEY CLEANUP. When a cron trigger config is edited (expression changes), the old trigger key becomes orphaned in daemon-state.json's lastRunTimestamps. Over months of config edits, this accumulates stale entries. Fix: on config reload, prune lastRunTimestamps keys that don't match any current trigger.

Effort: XS (human: ~2 hours / CC: ~10 min)
Priority: P3
Depends on: Phase 4b (cron triggers)

Pros: Prevents state file bloat. Clean state.
Cons: Very minor issue — stale keys are harmless except for file size. → **A:** C) Build it now in Phase 4b (8/10)
- **Q:** GaryClaw Phase 4b on main. TODO proposal #2: DIFF-BASED CONFIG RELOAD. Currently the plan restarts ALL pollers on any config change, even if only a budget number changed. This resets git poller baselines (loses current HEAD), causing a brief window where a push could be missed. Fix: compare old and new configs, only restart triggers that actually changed.

Effort: S (human: ~3 days / CC: ~20 min)
Priority: P2
Depends on: Phase 4b

Pros: No missed git events on config edit. Surgical reload.
Cons: Diff logic adds complexity. Must define what 'changed' means for each trigger type. → **A:** C) Build it now in Phase 4b (8/10)
- **Q:** GaryClaw Phase 4b on main. TODO proposal #3: TIMEZONE-AWARE CRON. When the laptop's timezone changes (travel), cron expressions evaluate differently — a 3am EST trigger becomes 3am PST, which is 6am EST. This can cause unexpected catch-up fires or missed windows. Fix: store the intended timezone alongside the cron expression in the CronTrigger config, and pass it to cron-parser (which supports `tz` option).

Effort: XS (human: ~2 hours / CC: ~10 min)
Priority: P2
Depends on: Phase 4b

Pros: Correct behavior for traveling developers. cron-parser has native TZ support.
Cons: Adds a config field. Most users won't notice the issue. → **A:** C) Build it now in Phase 4b (9/10)
- **Q:** GaryClaw Phase 4b on main. TODO proposal #4: PIN CRON-PARSER VERSION. The outside voice flagged that cron-parser has had breaking API changes between major versions (v4 changed the surface). The plan uses `prev()` and `next()` which are core API — pinning the exact version in package.json prevents surprise breakage on `npm update`.

RECOMMENDATION: This is a no-brainer — just pin the version in package.json. Not really a TODO, more of an implementation detail. I'll note it as required in the plan and move on. → **A:** A) Pin version (just do it) (9/10)
- **Q:** CEO review for Phase 4b is complete. Next step: this review expanded scope significantly (9 accepted items including diff-based reload, timezone-aware cron, shared atomicWriteJSON utility, quiet hours for all triggers). The existing eng review from 2026-03-25 covered Phase 4a, not these Phase 4b additions. A fresh eng review would validate the architecture decisions (mtime polling, catch-up algorithm, cron-parser dependency) and produce the test specs.

RECOMMENDATION: Choose A — eng review is the required shipping gate and needs to cover the expanded Phase 4b scope. The CEO plan document gives it sharp input to work from.

Completeness: A=9/10, B=7/10, C=5/10 → **A:** A) Run /plan-eng-review next (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. No design doc found for this branch. /office-hours produces a structured problem statement, premise challenge, and explored alternatives — it gives this review much sharper input to work with. Takes about 10 minutes. However, the CEO review just completed with a detailed plan document covering scope decisions, design choices, and temporal interrogation. That likely serves as sufficient input. Skip to the eng review? → **A:** Skip — proceed with review (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. ARCHITECTURE ISSUE 1: Who owns DaemonState persistence?

The plan adds lastRunTimestamps to DaemonState and says the cron poller will persist state via atomicWriteJSON() after each tick. But right now, DaemonState is exclusively managed by job-runner.ts — loadState() and persistState() are private functions inside that module (lines 269-291). The cron poller in triggers.ts would need to read AND write the same daemon-state.json file.

This creates a coupling problem: two modules (job-runner + cron poller) writing to the same file, and the cron poller needs access to state it doesn't own.

RECOMMENDATION: Choose A — separate files keeps each module owning its own persistence, which is the current pattern. Minimal diff, no refactoring of job-runner internals. Completeness: A=9/10, B=8/10, C=6/10. → **A:** A) Separate cron-state.json (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. ARCHITECTURE ISSUE 2: How do git pollers respect quiet hours?

The plan says quiet hours suppresses ALL triggers (cron + git_poll). But the current git poller in triggers.ts (line 75-83) fires its callback immediately on debounce — it has no concept of quiet hours. The plan doesn't specify WHERE the quiet hours check goes for git triggers.

Three places it could go:
- Inside createGitPoller (pollutes the generic poller with daemon-specific config)
- In daemon.ts's trigger callback wrapper (the anonymous function on line 277-279 that calls runner.enqueue)
- In the job runner's enqueue() method

RECOMMENDATION: Choose A — the daemon is the config owner and already wraps trigger callbacks. Adding the quiet hours check there keeps the poller and runner generic. One line of code in the right place. Explicit > clever. Completeness: A=9/10, B=7/10, C=7/10. → **A:** A) Check in daemon.ts callback (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. ARCHITECTURE ISSUE 3: Trigger equality for diff-based reload.

The plan says diff-based config reload only restarts triggers that actually changed. But it doesn't define how to compare two triggers for equality. For git_poll triggers, if you change ONLY debounceSeconds (30→60), should the poller restart?

This matters because restarting a git poller resets its baseline HEAD — there's a brief window where a push could be missed. But NOT restarting means the old config stays in effect.

The simplest approach: JSON.stringify() comparison of the full trigger object. If any field differs, restart. This is correct behavior (old config should not persist) and the "missed push" window is <5s (one poll interval) which is negligible.

RECOMMENDATION: Choose A — simple deep-compare via JSON.stringify is correct, explicit, and covers all trigger types (git_poll + cron) without type-specific comparison logic. Completeness: A=9/10, B=8/10. → **A:** A) JSON.stringify comparison (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. ARCHITECTURE ISSUE 4: Poller interface naming.

The current interface is `GitPoller` with `start()`/`stop()`. The new cron poller has the same shape. The plan implies creating `createCronPoller()` returning... what type? Reusing `GitPoller` is confusing (it's not git). Creating a new `CronPoller` interface with identical methods is a DRY violation.

The fix is trivial: rename to a generic `Poller` interface, export it from triggers.ts, and use it for both. The `GitPoller` type alias can stay for backward compat.

RECOMMENDATION: Choose A — clean naming, minimal diff (add type alias, update exports). DRY is important per your preferences. Completeness: A=9/10, B=7/10. → **A:** A) Generic Poller interface (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. CODE QUALITY ISSUE 1: atomicWriteJSON reconciliation with checkpoint.ts.

The plan proposes extracting a shared atomicWriteJSON() utility and says checkpoint.ts will reuse it. But the existing checkpoint.ts writeCheckpoint() (lines 24-47) uses a DIFFERENT pattern:
- Random hex in tmp filename: `checkpoint.tmp.${randomBytes(4).toString('hex')}.json`
- Different backup naming: `checkpoint.prev.json` (not `.bak`)

The plan's atomicWriteJSON uses `.tmp` suffix and `.bak` suffix. These are incompatible — migrating checkpoint.ts to the shared utility would change the backup file naming from `.prev.json` to `.bak`, breaking any code that looks for `checkpoint.prev.json`.

The random hex in checkpoint.ts was defensive (collision safety), but since we're single-threaded it's unnecessary.

RECOMMENDATION: Choose B — the shared utility is still valuable for job-runner + cron-state, and we get DRY for those two. Migrating checkpoint.ts requires updating readCheckpoint() fallback path too — extra diff for no functional gain. Completeness: A=8/10, B=9/10. → **A:** B) Shared utility for new code only (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. CODE QUALITY ISSUE 2: validateDaemonConfig hardcodes 'git_poll' rejection.

Line 71 of daemon.ts: `if (t.type !== "git_poll") return \`triggers[${i}].type must be \"git_poll\"\`;`

This must change to accept both 'git_poll' and 'cron' trigger types with type-specific validation (different required fields for each). The existing test on line 95-97 explicitly tests that type='cron' is REJECTED — this test will need updating to pass.

This is a straightforward fix with no real alternatives — I'll note it as a required change rather than waste a question. The validation should switch on trigger type:
- `git_poll`: validate intervalSeconds, skills, optional debounceSeconds/branch
- `cron`: validate expression (via cron-parser), skills, optional catchUp/timezone

Moving on. → **A:** A) Acknowledged — proceed (Recommended) (10/10)
- **Q:** GaryClaw Phase 4b on main. TEST ISSUE 1: The cron poller needs dependency injection for cron-parser.

The plan says cron poller uses `cron.parseExpression(expr, { tz })` directly. But to test catch-up semantics (lastRun 48h ago, DST transitions, etc.), you need to control what prev() and next() return. Importing cron-parser directly makes unit tests depend on real time.

The git poller solved this elegantly: `GitPollerDeps` injects `getHead`, `setInterval`, `setTimeout`, etc. The cron poller needs similar DI.

RECOMMENDATION: Choose A — follows the existing git poller pattern exactly. DI for time functions + cron parsing gives deterministic tests. Your preference for well-tested code is non-negotiable, and you can't test catch-up properly without controlling time. Completeness: A=10/10, B=5/10. → **A:** A) CronPollerDeps with mock support (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. TEST ISSUE 2: Config reload testing requires a testable extraction.

The config reload logic (mtime polling, diff-based restart, orphan pruning) is planned to live inside `startDaemon()` in daemon.ts. But `startDaemon()` is the full daemon lifecycle function — it forks processes, opens sockets, writes PID files. You can't unit test config reload without spinning up an actual daemon.

The existing codebase solves this pattern well: `buildIPCHandler()` is extracted as a pure function that takes dependencies and returns a handler. Config reload needs the same treatment.

RECOMMENDATION: Choose A — extract the reload logic as a testable function. This is the existing pattern (buildIPCHandler, createJobRunner, createGitPoller all follow it). Explicit > clever. Completeness: A=10/10, B=4/10. → **A:** A) Extract reloadConfig() function (Recommended) (10/10)
- **Q:** GaryClaw Phase 4b on main. TODO PROPOSAL 1: Config reload integration test.

The plan has unit tests for reloadConfig() (extracted function), but no test that verifies the full mtime-polling loop: daemon detects file change → reads config → calls reloadConfig() → pollers actually restart. This is the integration seam.

A lightweight integration test (mock fs.statSync for mtime, mock config file reads) would catch wiring bugs between the mtime polling loop and the reload function. Not needed for Phase 4b MVP but valuable for Phase 4c hardening.

RECOMMENDATION: Choose A — small TODO for Phase 4c. The unit tests cover the logic; this catches wiring. Completeness: A=8/10, B=6/10, C=9/10. → **A:** C) Build it now (8/10)
- **Q:** GaryClaw Phase 4b on main. TODO PROPOSAL 2: Update TODOS.md — Phase 4 daemon entry is stale.

The current TODOS.md has a P2 entry for 'Daemon Mode (Phase 4)' that describes Phase 4a work which is already COMPLETE. It should be updated to reflect Phase 4b (scheduling) as the current work, and Phase 4c (hardening) as the next deferred item. The existing P3 entries (Codebase Summary, Adaptive maxTurns) are still valid.

RECOMMENDATION: Choose A — stale TODOs are worse than no TODOs. Quick cleanup. Completeness: A=9/10, B=5/10. → **A:** A) Update TODOS.md (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. TODO PROPOSAL 3: CLI schedule output format.

The plan defines the IPC response structure for 'schedule' but doesn't specify how the CLI formats the output. Should it be a table? JSON? Colored text? This is a taste decision.

The existing CLI subcommands use ANSI-colored text (status shows key-value pairs, log shows raw text). A simple table matching that style would be consistent.

RECOMMENDATION: Choose A — matches existing CLI style. Completeness: A=9/10, B=7/10. → **A:** A) ANSI table like status (Recommended) (9/10)
- **Q:** GaryClaw Phase 4b on main. All review sections are complete. Want an outside voice? A different AI system can give a brutally honest, independent challenge of this plan — logical gaps, feasibility risks, and blind spots that are hard to catch from inside the review. Takes about 2 minutes.

RECOMMENDATION: Choose A — an independent second opinion catches structural blind spots. Two different AI models agreeing on a plan is stronger signal than one model's thorough review. Completeness: A=9/10, B=7/10. → **A:** B) Skip (7/10)

---
*Generated by GaryClaw Pipeline*