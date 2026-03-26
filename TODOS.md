# TODOS

## P2: garyclaw doctor — Self-Diagnostic Command

**What:** A `garyclaw doctor` command that checks in 5 seconds: stale PID files, corrupt oracle memory, orphaned worktrees, stuck reflection locks, exhausted global budget, valid auth. Prints PASS/WARN/FAIL per check. Includes shared PID liveness utility with process-name verification (prevents PID reuse false positives).

**Why:** When the daemon won't start or behaves oddly, there's no diagnostic tool. Users read raw logs. Doctor gives instant triage. Also subsumes the P2 "stale PID cleanup" TODO.

**Pros:** 5-second diagnostic for all common failure modes. Self-healing (offers to fix stale PIDs, stuck locks).

**Cons:** None significant — reads existing state files, no side effects except optional cleanup.

**Context:** Identified in CEO review battle-test dogfood plan (2026-03-26). Accepted as cherry-pick #2. Eng review approved with: auth check needs 10s timeout (WARN on timeout, FAIL on actual error), shared PID utility with process-name check.

**Effort:** S (human: ~2 days / CC: ~20 min)
**Depends on:** Nothing
**Added by:** /plan-ceo-review on 2026-03-26

## P2: Failure Taxonomy in Job Runner

**What:** When a daemon job fails, classify the error into: `garyclaw-bug` (harness issue), `skill-bug` (gstack skill misbehavior), `project-bug` (target project issue), `sdk-bug` (Agent SDK issue), `auth-issue` (token/login), `infra-issue` (disk/network/OOM). Store as structured JSON in `.garyclaw/failures.jsonl`.

**Why:** Right now when a job fails, the error message is whatever the exception says. Classification enables: auto-retry for infra issues, skip for project bugs, escalate for GaryClaw bugs. Makes overnight runs resilient instead of fragile.

**Pros:** Structured failure data. Enables smart retry logic. Makes debugging overnight runs trivial.

**Cons:** Classification heuristic may misclassify edge cases.

**Context:** Identified in CEO review battle-test dogfood plan (2026-03-26). Eng review: classify in job-runner.ts where all errors converge (single classification point).

**Effort:** S (human: ~2 days / CC: ~20 min)
**Depends on:** Nothing
**Added by:** /plan-ceo-review on 2026-03-26

## P2: Dogfood Dashboard

**What:** After each daemon job completes, auto-generate a health dashboard at `.garyclaw/dogfood-report.md`: jobs run, decisions made, issues found/fixed, relay count, oracle accuracy, cost. One glance tells you if GaryClaw is healthy.

**Why:** Without it, you're reading raw logs to understand if overnight runs were productive.

**Pros:** Instant visibility into daemon health. Extends existing report.ts.

**Cons:** None significant.

**Context:** Identified in CEO review battle-test dogfood plan (2026-03-26). Eng review: wire into job-runner completion, not a separate subcommand. Add `garyclaw dashboard` read-only command.

**Effort:** S (human: ~2 days / CC: ~20 min)
**Depends on:** Nothing
**Added by:** /plan-ceo-review on 2026-03-26

## P1: Spike — Verify GIT_COMMITTER_EMAIL Propagation Through SDK

**What:** Run a 5-minute spike to confirm that setting `GIT_COMMITTER_EMAIL` in the env passed to `query()` propagates through to Claude's `git commit` calls. The dogfood plan's recursive loop prevention relies on this.

**Why:** If the SDK strips or overrides env vars before they reach Claude's Bash tool, the entire loop prevention strategy (env var marker → poller checks committer email) fails silently. The spike is the cheapest way to de-risk the most critical safety feature in the dogfood plan.

**Pros:** 5-minute de-risk for a blocking safety feature.

**Cons:** Might be unnecessary if env passthrough already covers this (spike 3 proved general env passthrough, but git committer email is a special case).

**Context:** Identified in eng review failure modes analysis (2026-03-26). The CEO review chose env var marker over git hooks for loop prevention. This spike validates the approach before implementation.

**Effort:** XS (human: ~30 min / CC: ~5 min)
**Depends on:** Nothing
**Added by:** /plan-eng-review on 2026-03-26

## P4: Daemon Hardening (Phase 4b) — SUBSUMED BY DOCTOR

**What:** Remaining hardening for the daemon: ~~log rotation (size-based, 10MB threshold)~~, ~~job state pruning~~, stale PID cleanup on startup.

**Why:** Phase 4a daemon MVP is complete and working — runs jobs, enforces budgets, sends notifications. Stale PID files from crashes still aren't cleaned up.

**Pros:** Production-readiness for long-running daemon instances.

**Cons:** Low urgency — the daemon works fine for short sessions. Only matters for always-on deployment.

**Context:** Phase 4a completed 2026-03-25. Hardening fixes completed 2026-03-26. Log rotation (ISSUE-005) and job pruning (ISSUE-006) fixed by /qa on main, 2026-03-26. maxJobsPerDay enforcement gap (ISSUE-016) fixed by /qa Run 3. Shell injection in triggers.ts (ISSUE-002) and resumeSkill checkpoint discard (ISSUE-003) fixed by /qa Run 4 on main, 2026-03-26. Remaining: stale PID cleanup → **subsumed by `garyclaw doctor` in battle-test dogfood plan** (detects AND fixes stale PIDs as check #1).

**Effort:** XS (human: ~1 day / CC: ~15 min)
**Depends on:** Phase 4a (complete)
**Added by:** /plan-eng-review on 2026-03-26

## P3: Codebase Summary Persistence Across Relays

**What:** Generate a structured "codebase summary" during each session that persists across relays — documenting patterns, conventions, file relationships, and lessons learned during the run.

**Why:** When GaryClaw relays to a fresh session, the checkpoint captures conclusions (issue list, fix status) but not reasoning (codebase conventions, failed approaches, architectural patterns Claude learned). The new session may re-explore dead ends or apply fixes that contradict conventions the previous session had learned. A persistent codebase summary would carry this tacit knowledge across relay boundaries.

**Pros:** Better fix quality across relays. Less re-exploration. Preserves the "mental model" that the previous session built up. Could also be useful for skill chaining (Phase 3) — passing codebase understanding between different skills.

**Cons:** Generating the summary costs tokens. Summary quality depends on Claude's ability to identify what's worth remembering vs. what's noise. Adds complexity to checkpoint/relay flow.

**Context:** Identified by outside voice review during eng review (2026-03-25). The relay prompt currently includes issues and decisions but not codebase-level insights. The tiered checkpoint strategy (full for open, summary for fixed) helps with structured data but doesn't address unstructured codebase understanding.

**Effort:** S (human: ~3 days / CC: ~30 min)
**Depends on:** Phase 1a (relay working), Phase 2 (if bundled with oracle context)
**Added by:** /plan-eng-review on 2026-03-25

## P3: Adaptive maxTurns Strategy

**What:** Dynamic segment sizing — start at 15 turns per segment, increase if the skill is making progress (commits happening, issues being fixed), decrease if context growth rate is high.

**Why:** Fixed maxTurns is a blunt instrument. Too low (5) = Claude can't finish a fix iteration. Too high (50) = context grows too much before the relay check. The optimal value depends on what the skill is doing: browse-heavy phases (screenshots) consume context faster than edit-only phases.

**Pros:** Better relay timing — fewer unnecessary interruptions, fewer surprise context overflows. Adapts to different skill types and phases automatically.

**Cons:** More complex token monitor. Requires heuristics for "is the skill making progress" (git commit detection, issue status changes). Risk of over-tuning.

**Context:** Identified during eng review performance section (2026-03-25). Phase 1a uses fixed maxTurns: 15 as a reasonable default. Outside voice noted "you fly blind" if maxTurns is wrong. The token monitor already tracks growth rate — adaptive turns is a natural extension.

**Effort:** XS (human: ~1 day / CC: ~15 min)
**Depends on:** Phase 1a (token monitor working)
**Added by:** /plan-eng-review on 2026-03-25

## P3: Memory-Informed Adaptive Scheduling

**What:** The Oracle learns optimal trigger patterns from job outcomes — e.g., "QA finds 3x more bugs after large commits, so trigger QA after commits touching 5+ files, not on every push." Replaces static cron rules with learned patterns.

**Why:** Static cron triggers fire on fixed schedules regardless of what changed. Adaptive scheduling fires based on what the Oracle learned actually matters — commit size, file types changed, time of day. More efficient use of compute budget.

**Pros:** Smarter resource allocation. Fewer unnecessary jobs. Better bug detection timing.

**Cons:** Cold-start problem — requires 50+ jobs of history to learn from. Needs quality metrics (Phase 5b) to measure what "better" means. Risk of over-fitting to recent patterns.

**Context:** Identified during CEO review cherry-pick ceremony (2026-03-26, SELECTIVE EXPANSION). Deferred because it requires enough job history data to learn from. Ship static cron (Phase 4b) first, layer adaptive triggers when data exists.

**Effort:** M (human: ~1 week / CC: ~1 hour)
**Depends on:** Phase 5b (quality metrics, DONE), Phase 4b (cron baseline, DONE), 50+ jobs of history (NOT YET — currently ~16 jobs)
**Added by:** /plan-ceo-review on 2026-03-26

## P4: Daemon Shutdown AbortSignal Improvement

**What:** Improve daemon shutdown handler to use AbortSignal propagation instead of polling with setTimeout, so running jobs can be cleanly cancelled rather than waiting 60s for the timeout cap.

**Why:** Current shutdown polls `runner.isRunning()` every 1s for up to 60s. If a job is truly stuck, the daemon exits mid-job. AbortSignal threading (already partially implemented in orchestrator) could enable clean cancellation.

**Pros:** Cleaner shutdown. No orphaned SDK queries. Faster daemon stop.

**Cons:** Low urgency — 60s timeout works in practice for non-stuck jobs.

**Context:** Found by /qa Run 6 on main, 2026-03-26 (ISSUE-004). Already in Phase 4c roadmap.

**Effort:** XS (human: ~1 day / CC: ~15 min)
**Depends on:** Phase 4a (complete)
**Added by:** /qa Run 6 on 2026-03-26

## P3: Oracle Decision Batching (Latency Optimization)

**What:** Batch nearby Oracle decisions into a single API call when multiple AskUserQuestions fire within the same segment. Currently each decision is a separate 40K-token API call (~2-5s). Batching could reduce total Oracle latency by 50-70%.

**Why:** At 20 decisions per job × 2-5s each = 40-100 seconds of serial Oracle overhead. Currently ~3-5% of typical job time. Acceptable now but worth optimizing as job frequency increases with daemon mode.

**Pros:** Faster jobs. Lower Oracle cost per decision. Smoother daemon throughput.

**Cons:** Batching changes the decision-by-decision audit trail. Requires buffering AskUserQuestions and responding in bulk, which may not work if later questions depend on earlier answers.

**Context:** Identified by outside voice during CEO review (2026-03-26). The latency is documented but not addressed in the current plan. Future optimization after the Oracle memory system is validated.

**Effort:** S (human: ~3 days / CC: ~30 min)
**Depends on:** Phase 5a (memory Oracle working)
**Added by:** /plan-ceo-review on 2026-03-26

## P3: Implement Step Tracking Across Relays — INCLUDED IN DOGFOOD PLAN

**What:** Track which implementation steps from the design doc's "Implementation Order" have been completed, so that after a checkpoint/relay the fresh session knows where to resume instead of re-reading the full design doc from scratch.

**Why:** The implement skill constructs a prompt with the full design doc + implementation order. After relay, the fresh session gets a generic checkpoint summary but doesn't know which steps are done vs. remaining. For long implementations (5+ steps), the new session may repeat completed steps or lose its place. The "follow implementation order exactly" rule becomes contradictory when the order has already been partially executed.

**Pros:** Correct relay behavior for multi-step implementations. Saves context tokens by only injecting remaining steps. Prevents duplicate commits.

**Cons:** Requires checkpoint.ts to understand implement-specific state (step index, completed steps). Adds coupling between implement.ts and the checkpoint system. May need git log analysis to detect which steps were committed.

**Context:** Identified by outside voice during eng review of the implement skill (2026-03-26). The orchestrator's generic checkpoint captures issues/decisions but not implement-specific progress. A step-tracking field in the checkpoint state (e.g., `implementProgress: { completedSteps: number[], currentStep: number }`) could be injected into the relay prompt to resume at the right place.

**Effort:** S (human: ~3 days / CC: ~30 min)
**Depends on:** Implement skill (complete)
**Added by:** /plan-eng-review on 2026-03-26

## P3: Auto-Research Trigger (Daemon Integration)

**What:** When the Oracle makes 3+ low-confidence decisions (confidence < 6) in a single job within the same topic area, the daemon auto-enqueues a research session for that topic before the next job runs.

**Why:** Closes the feedback loop: Oracle encounters unfamiliar territory → auto-researches → next job has domain expertise. Currently, domain expertise only gets populated via manual `garyclaw research <topic>`. The auto-trigger makes the system self-improving.

**Pros:** Fully autonomous learning. No human intervention needed to improve Oracle knowledge over time. Topics researched are directly relevant (driven by actual low-confidence decisions, not guesses).

**Cons:** Requires topic extraction heuristic (inferring what topic caused low confidence from the question text). Cold start — needs Phase 5c (manual research) working first. Needs daemon config flag (`autoResearch.enabled`) to gate the behavior.

**Context:** Deferred from Phase 5c plan (2026-03-26). The plan includes the config schema (`autoResearch: { enabled, lowConfidenceThreshold, minDecisionsToTrigger }`) but explicitly defers implementation to after manual research is validated.

**Effort:** S (human: ~3 days / CC: ~30 min)
**Depends on:** Phase 5c (manual research working), daemon job runner
**Added by:** /plan-eng-review on 2026-03-26
