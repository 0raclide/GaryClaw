# TODOS

## ~~P2: garyclaw doctor — Self-Diagnostic Command~~ — COMPLETE (2026-03-27)

Implemented in 7 commits (340c87f..c2b4827). 6 subsystem checks, --fix/--json/--skip-auth flags, shared pid-utils.ts, 72 tests.

**What:** A `garyclaw doctor` command that checks in 5 seconds: stale PID files, corrupt oracle memory, orphaned worktrees, stuck reflection locks, exhausted global budget, valid auth. Prints PASS/WARN/FAIL per check. Includes shared PID liveness utility with process-name verification (prevents PID reuse false positives).

**Why:** When the daemon won't start or behaves oddly, there's no diagnostic tool. Users read raw logs. Doctor gives instant triage. Also subsumes the P2 "stale PID cleanup" TODO.

**Pros:** 5-second diagnostic for all common failure modes. Self-healing (offers to fix stale PIDs, stuck locks).

**Cons:** None significant — reads existing state files, no side effects except optional cleanup.

**Context:** Identified in CEO review battle-test dogfood plan (2026-03-26). Accepted as cherry-pick #2. Eng review approved with: auth check needs 10s timeout (WARN on timeout, FAIL on actual error), shared PID utility with process-name check.

**Effort:** S (human: ~2 days / CC: ~20 min)
**Depends on:** Nothing
**Added by:** /plan-ceo-review on 2026-03-26

## ~~P2: Failure Taxonomy in Job Runner~~ — COMPLETE (2026-03-27)

Implemented in 5 commits (ad94ab7..49e34a9). Eng review hardened patterns + added 17 per-pattern tests. 8 failure categories, table-driven classification, failures.jsonl output, notification integration. 72 tests covering all codepaths.

## ~~P2: Dogfood Dashboard~~ — COMPLETE (2026-03-27)

Implemented in 5 commits. Health score (4-signal weighted: jobs 40%, oracle 25%, budget 20%, circuit breaker 15%), job/oracle/budget aggregation, markdown formatting, auto-generation after every job, `garyclaw dashboard` CLI command. 40 tests covering all edge cases including NaN guard, over-budget clamp, DEGRADED/UNHEALTHY status labels, zero-limit budget headroom.

**What:** After each daemon job completes, auto-generate a health dashboard at `.garyclaw/dogfood-report.md`: jobs run, decisions made, issues found/fixed, relay count, oracle accuracy, cost. One glance tells you if GaryClaw is healthy.

**Why:** Without it, you're reading raw logs to understand if overnight runs were productive.

**Pros:** Instant visibility into daemon health. Extends existing report.ts.

**Cons:** None significant.

**Context:** Identified in CEO review battle-test dogfood plan (2026-03-26). Eng review: wire into job-runner completion, not a separate subcommand. Add `garyclaw dashboard` read-only command.

**Effort:** S (human: ~2 days / CC: ~20 min)
**Depends on:** Nothing
**Added by:** /plan-ceo-review on 2026-03-26

## ~~P1: Spike — Verify GIT_COMMITTER_EMAIL Propagation Through SDK~~ — COMPLETE (2026-03-27)

Verified manually: `GIT_COMMITTER_EMAIL=garyclaw-daemon@local` propagates through git commit. Committer email shows custom value while author stays unchanged. Loop prevention via env var marker is validated.

**What:** Run a 5-minute spike to confirm that setting `GIT_COMMITTER_EMAIL` in the env passed to `query()` propagates through to Claude's `git commit` calls. The dogfood plan's recursive loop prevention relies on this.

**Why:** If the SDK strips or overrides env vars before they reach Claude's Bash tool, the entire loop prevention strategy (env var marker → poller checks committer email) fails silently. The spike is the cheapest way to de-risk the most critical safety feature in the dogfood plan.

**Pros:** 5-minute de-risk for a blocking safety feature.

**Cons:** Might be unnecessary if env passthrough already covers this (spike 3 proved general env passthrough, but git committer email is a special case).

**Context:** Identified in eng review failure modes analysis (2026-03-26). The CEO review chose env var marker over git hooks for loop prevention. This spike validates the approach before implementation.

**Effort:** XS (human: ~30 min / CC: ~5 min)
**Depends on:** Nothing
**Added by:** /plan-eng-review on 2026-03-26

## ~~P4: Daemon Hardening (Phase 4b)~~ — COMPLETE (subsumed by doctor)

All items resolved: ~~log rotation~~ (ISSUE-005, /qa 2026-03-26), ~~job state pruning~~ (ISSUE-006, /qa 2026-03-26), ~~stale PID cleanup~~ (subsumed by `garyclaw doctor` check #1 — detects AND fixes stale PIDs with `--fix`). See `src/doctor.ts`, `src/pid-utils.ts`.

## ~~P3: Codebase Summary Persistence Across Relays~~ — COMPLETE (2026-03-27)

Implemented in 9 commits (5a964dc..4d7baac). CodebaseSummary interface, signal-word extraction with code-anchor bonus, Levenshtein dedup, token budget enforcement (500 failedApproaches + 1500 observations), relay prompt injection, checkpoint validation, orchestrator wiring. 51 tests covering all codepaths including version-string filter, missing lastSessionIndex validation, and relay carry-through integration.

**What:** Generate a structured "codebase summary" during each session that persists across relays — documenting patterns, conventions, file relationships, and lessons learned during the run.

**Why:** When GaryClaw relays to a fresh session, the checkpoint captures conclusions (issue list, fix status) but not reasoning (codebase conventions, failed approaches, architectural patterns Claude learned). The new session may re-explore dead ends or apply fixes that contradict conventions the previous session had learned. A persistent codebase summary would carry this tacit knowledge across relay boundaries.

**Pros:** Better fix quality across relays. Less re-exploration. Preserves the "mental model" that the previous session built up. Could also be useful for skill chaining (Phase 3) — passing codebase understanding between different skills.

**Cons:** Generating the summary costs tokens. Summary quality depends on Claude's ability to identify what's worth remembering vs. what's noise. Adds complexity to checkpoint/relay flow.

**Context:** Identified by outside voice review during eng review (2026-03-25). The relay prompt currently includes issues and decisions but not codebase-level insights. The tiered checkpoint strategy (full for open, summary for fixed) helps with structured data but doesn't address unstructured codebase understanding.

**Effort:** S (human: ~3 days / CC: ~30 min)
**Depends on:** Phase 1a (relay working), Phase 2 (if bundled with oracle context)
**Added by:** /plan-eng-review on 2026-03-25

## ~~P3: Implement Skill Hardening~~ — COMPLETE (2026-03-27)

All three items from `docs/designs/implement-skill-hardening.md` implemented: `validateImplementationOrder()` with warnings for missing sections (`implement.ts:105`), `actionableOnly` filter for review context (`implement.ts:123-138`), static import conversion (`pipeline.ts:20`). Pre-existing test coverage: `test/implement.test.ts` (48 tests incl. 5 for validateImplementationOrder, 8 for actionableOnly filter), `test/implement-loaddesigndoc.regression-1.test.ts` (7 tests), `test/pipeline-implement.test.ts` (4 tests).

## ~~P3: Adaptive maxTurns Strategy~~ — COMPLETE (2026-03-28)

**What:** Dynamic segment sizing — start at 15 turns per segment, increase if the skill is making progress (commits happening, issues being fixed), decrease if context growth rate is high.

**Why:** Fixed maxTurns is a blunt instrument. Too low (5) = Claude can't finish a fix iteration. Too high (50) = context grows too much before the relay check. The optimal value depends on what the skill is doing: browse-heavy phases (screenshots) consume context faster than edit-only phases.

**Pros:** Better relay timing — fewer unnecessary interruptions, fewer surprise context overflows. Adapts to different skill types and phases automatically.

**Cons:** More complex token monitor. Requires heuristics for "is the skill making progress" (git commit detection, issue status changes). Risk of over-tuning.

**Context:** Identified during eng review performance section (2026-03-25). Phase 1a uses fixed maxTurns: 15 as a reasonable default. Outside voice noted "you fly blind" if maxTurns is wrong. The token monitor already tracks growth rate — adaptive turns is a natural extension.

**Implementation:** `computeAdaptiveMaxTurns()` in token-monitor.ts. Per-segment turn prediction from growth rate + heavy tool lookahead. HEAVY_TOOLS (WebFetch/WebSearch/Screenshot) trigger 2.5x growth rate multiplier. `--no-adaptive` flag disables. 26 unit tests + 7 integration tests (orchestrator + CLI). Commits: 5b251aa..558986f.

**Effort:** XS (human: ~1 day / CC: ~15 min)
**Depends on:** Phase 1a (token monitor working)
**Added by:** /plan-eng-review on 2026-03-25

## ~~P3: Dashboard Adaptive Turns Stats~~ — COMPLETE (2026-03-28)

Implemented in commit 923c08a. Aggregates avg/min/max adaptive turns per job, segment count with adaptive prediction vs. fallback default, heavy tool multiplier activation distribution. 27 tests in `test/dashboard.test.ts` and `test/dashboard.regression-1.test.ts`.

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

## ~~P3: Implement Step Tracking Across Relays~~ — COMPLETE (2026-03-27)

Implemented in 6 commits (fbe24f8..b7a74e5). ImplementProgress interface, detectCompletedSteps with two-tier commit matching (exact step number + fuzzy token overlap), formatImplementProgress for relay prompts, orchestrator wiring, pipeline resume awareness, 45 tests.

**What:** Track which implementation steps from the design doc's "Implementation Order" have been completed, so that after a checkpoint/relay the fresh session knows where to resume instead of re-reading the full design doc from scratch.

**Why:** The implement skill constructs a prompt with the full design doc + implementation order. After relay, the fresh session gets a generic checkpoint summary but doesn't know which steps are done vs. remaining. For long implementations (5+ steps), the new session may repeat completed steps or lose its place. The "follow implementation order exactly" rule becomes contradictory when the order has already been partially executed.

**Pros:** Correct relay behavior for multi-step implementations. Saves context tokens by only injecting remaining steps. Prevents duplicate commits.

**Cons:** Requires checkpoint.ts to understand implement-specific state (step index, completed steps). Adds coupling between implement.ts and the checkpoint system. May need git log analysis to detect which steps were committed.

**Context:** Identified by outside voice during eng review of the implement skill (2026-03-26). The orchestrator's generic checkpoint captures issues/decisions but not implement-specific progress. A step-tracking field in the checkpoint state (e.g., `implementProgress: { completedSteps: number[], currentStep: number }`) could be injected into the relay prompt to resume at the right place.

**Effort:** S (human: ~3 days / CC: ~30 min)
**Depends on:** Implement skill (complete)
**Added by:** /plan-eng-review on 2026-03-26

## ~~P3: Auto-Research Trigger (Daemon Integration)~~ — COMPLETE, 3 bugs fixed by /qa (2026-03-27)

**What:** When the Oracle makes 3+ low-confidence decisions (confidence < 6) in a single job within the same topic area, the daemon auto-enqueues a research session for that topic before the next job runs.

**Why:** Closes the feedback loop: Oracle encounters unfamiliar territory → auto-researches → next job has domain expertise. Currently, domain expertise only gets populated via manual `garyclaw research <topic>`. The auto-trigger makes the system self-improving.

**Bugs found and fixed by /qa on 2026-03-27:**
- ISSUE-001: `extractTopicKeywords` filtered 3-char words, killing API/SSL/JWT/SQL/CSS/DOM/RPC. Fixed: threshold >2, added stop words.
- ISSUE-002: Greedy clustering snowball — accumulated keywords attracted unrelated decisions. Fixed: seed-keyword matching.
- ISSUE-003: Pipeline decisions read from wrong path — auto-research only read top-level, missed skill subdirs. Fixed: `collectAllDecisions()`.
- 40 regression tests added across 3 new test files.

**Effort:** S (human: ~3 days / CC: ~30 min)
**Depends on:** Phase 5c (manual research working), daemon job runner
**Added by:** /plan-eng-review on 2026-03-26

## ~~P4: Research Job Cost Tracking~~ — COMPLETE (2026-03-27)

Fixed by /qa ISSUE-002/003: added `costUsd` to `ResearchResult`, extract `total_cost_usd` from SDK result message in `runResearch()`, pass through orchestrator research dispatch. Also added missing `segment_end` event.

**Added by:** /qa on 2026-03-27

## P5: Low-Severity QA Findings (deferred)

**What:** 15 low-severity issues found by /qa deep audit (run 5, 2026-03-27). None are bugs that affect correctness today, but are code quality / robustness improvements.

**Items:**
- [ ] `isTaste` field in oracle.ts mirrors confidence threshold, not taste semantics — rename or document
- [x] Oracle ESCALATION_PHRASES "delete" matches benign strings like "deleted" — use word boundary — Fixed by /qa Run 6 on main, 2026-03-27 (ISSUE-003)
- [ ] `(msg as any)` type assertions in `createSdkOracleQueryFn` — add runtime shape validation
- [x] `INJECTION_PATTERNS` in oracle-memory.ts bypassable with leading whitespace — trim before matching — Fixed by /qa Run 6 on main, 2026-03-27 (ISSUE-001)
- [x] Shallow copy in `updateMetricsWithOutcome` shares `confidenceTrend` array reference — deep copy array — Fixed by /qa Run 8 on main, 2026-03-27 (ISSUE-001)
- [x] `readDecisionsFromLog` silently drops corrupt JSONL lines — add warning log — Fixed by /qa Run 8 on main, 2026-03-27 (ISSUE-002)
- [ ] `parseDomainSections` edge case with adjacent sections without body text — add test
- [x] `createResearchCanUseTool` sync return used where async expected — align signatures — Fixed by /qa Run 8 on main, 2026-03-27 (ISSUE-003)
- [ ] Research cost extraction uses `(msg as any).total_cost_usd` — use extractResultData instead
- [ ] `extractTopicKeywords` doesn't filter numeric-only tokens — add isNaN guard
- [ ] `isTopicGroupFresh` brittle to topic naming variations — consider fuzzy matching
- [x] `branchName` doesn't sanitize `instanceName` for illegal git branch chars — add validation — Fixed by /qa Run 6 on main, 2026-03-27 (ISSUE-002)
- [x] `listWorktrees` swallows all git errors silently — log warning on error — Fixed by /qa Run 8 on main, 2026-03-27 (ISSUE-004)
- [ ] Pipeline `startTime!` non-null assertion — use explicit default
- [ ] Pipeline dynamic import of orchestrator creates circular dependency — extract shared interface

**Effort:** XS each (human: ~30 min each / CC: ~5 min each)
**Depends on:** Nothing
**Added by:** /qa on 2026-03-27
