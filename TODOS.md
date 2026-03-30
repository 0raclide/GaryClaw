# TODOS

## ~~P1: TODO State Tracking — Artifact Detection + State Files~~ — COMPLETE (2026-03-29)

**What:** Track the lifecycle state of each TODO item so the daemon can resume from where it left off instead of rebuilding from scratch. Two complementary systems:

**System B (state file):** `.garyclaw/todo-state/{slug}.json` — persistent memory per TODO. Written after each pipeline skill completes. Survives instance cleanup, branch deletion, daemon restarts. Fields: `title`, `state` (open→designed→implemented→reviewed→qa-complete→merged→complete), `designDocPath`, `branch`, `instanceName`, `lastJobId`, `updatedAt`.

**System A (artifact detection):** Evidence-based verification. Scans for design docs in `docs/designs/`, branches with commits ahead of main, completed jobs in daemon-state.json, commits on main matching the title. Cross-validates System B every cycle. Self-heals when B is stale or missing.

**State transitions** happen only at skill boundaries (never mid-skill). Skills are idempotent — re-running QA just finds fewer issues. Pipeline start skill determined by state:
- `open` → start at prioritize
- `designed` → skip prioritize + office-hours, start at implement
- `implemented` → skip to eng-review
- `reviewed` → skip to QA
- `qa-complete` → merge only
- `merged/complete` → skip entirely

**Edge cases addressed:**
- **Slug stability:** Pure deterministic `slugify()` function with comprehensive tests. State file stores original title for Levenshtein fallback matching (threshold 0.3) if title changes slightly.
- **Stale "implementing" state:** If `updatedAt` > 2h and instance PID is dead (via `isPidAlive`), reset to previous stage with warning log.
- **Instance cleanup deletes branch:** B says "implemented" but no branch exists. Reconciliation checks if commits landed on main → promote to "merged." If nowhere → reset to "designed."
- **Parallel write prevention:** Pre-assignment claiming (claimedTodoTitle) is the lock. State file writes only happen after claiming. No new locking needed.
- **A disagrees with B:** A shows MORE advanced state → promote B (evidence trumps records). A shows LESS advanced AND B is stale (>2h) → trust A. B is recent (<2h) → trust B (work in progress).

**Implementation:**
- New module `src/todo-state.ts` (~150 lines): `slugify()`, `readTodoState()`, `writeTodoState()`, `reconcileState()`, `getStartSkill()`
- Wire into `src/job-runner.ts` `processNext()`: read state → determine start skill → pass to pipeline
- Wire into `src/pipeline.ts`: after each skill completes, call `writeTodoState()` to advance state
- Wire into `src/job-runner.ts` post-merge: advance to "merged"/"complete"
- Extend `src/doctor.ts`: detect orphaned state files, stale states, slug mismatches
- All state writes use `safeWriteJSON` (atomic, corruption recovery)

**Deferred (not in scope):**
- Dashboard state summary widget
- Automatic TODOS.md `~~complete~~` annotation from state
- Mid-skill checkpointing (skills are idempotent)

**Why:** On 2026-03-29, 5 parallel workers rebuilt the same features 2-3x each ($30 wasted) because the daemon had no memory of what was already designed/implemented. Design docs existed, branches had code, but every cycle started fresh. State tracking eliminates this waste and makes the self-improvement loop truly incremental.

**Effort:** S (human: ~3 days / CC: ~30 min)
**Depends on:** Nothing
**Added by:** human + AI brainstorm on 2026-03-29

## ~~P2: Pre-Merge Validation Gate~~ — COMPLETE (2026-03-29)

Implemented by default daemon. Pre-merge test gate + merge audit log in worktree.ts, validation config wiring in job-runner, merge-failed failure taxonomy rule, dashboard merge health stats, DaemonConfig.merge validation. QA'd with regression tests.

## ~~P2: File-Level Conflict Prevention for Parallel Instances~~ — COMPLETE (2026-03-29)

Implemented by default daemon. Extracts predicted file paths from TODO descriptions and design docs, builds claimedFiles set across instances, skips items with overlapping files. Fail-open when no files detected.

## ~~P3: Semantic Validation for Bootstrap~~ — COMPLETE (2026-03-29)

Built by default daemon. Command + test_directory claim types for bootstrap validation. Commit d2554cb.

## ~~P2: Fix Auto-Merge Dirty Working Tree + Cross-Cycle Dedup~~ — COMPLETE (2026-03-29)

Implemented by default daemon. Stash/pop in mergeWorktreeBranch (commit 6b14436). getCompletedTodoTitles in daemon-registry.ts for cross-cycle dedup (commits 1450261, b70b005). Wired into job-runner pre-assignment.

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

## ~~P2: Self-Maintaining Backlog — Auto-Complete + Rate Limit Resilience~~ — COMPLETE (2026-03-29)

**What:** Two capabilities that make the daemon's backlog management fully autonomous:

**1. Auto-mark TODOS.md when features land on main.** After a successful pipeline (auto-merge or direct commit), scan git log for recent commits, fuzzy-match against open TODO titles, and update the heading to `~~complete~~` with a summary. Also runs on daemon start as catch-up for items completed before a crash. Guard: never mark items currently "running" in any instance.

**2. Rate limit backoff with scheduled retry.** Parse the reset time from Claude Max rate limit errors ("resets at Xpm"), store `rateLimitResetAt` in daemon state, hold queued jobs until the reset time passes. Mark rate-limited jobs as `"rate_limited"` status (not "complete") so cross-cycle dedup ignores them. Prevents the spam-retry pattern that burned through 25+ auth attempts in 10 seconds overnight.

**Why:** The two biggest operational pains in Session 3. Auto-mark: daemon built features but TODOS.md showed them open → re-picked → rebuilt → $30 wasted overnight. Rate limit: 5 instances hit limit at 02:19 → spam-retried → ran $0 pipelines → polluted dedup → lost 4 hours of idle time.

**Files:** `src/job-runner.ts` (post-pipeline hook for auto-mark, rate limit check in processNext), `src/orchestrator.ts` (parse reset time from auth error), `src/types.ts` (rateLimitResetAt, rate_limited status), new function `markTodoComplete()`

**Effort:** S (human: ~3 days / CC: ~25 min)
**Depends on:** Nothing
**Added by:** Session 3 retrospective on 2026-03-29

## ~~P2: Adaptive Pipeline Composition — Rule-Based~~ — COMPLETE (2026-03-29)

Implemented by default daemon. Rule-based skill sequence selection based on effort/priority. Skips prioritize (already picked) and eng-review for low-risk items. Saves ~$0.90 per cycle on small items.

## ~~P2: Upgrade Pipeline Composition to Oracle-Driven Skill Selection~~ — COMPLETE (2026-03-29)

**What:** Replace the rule-based pipeline composition (currently live: skips skills based on effort/priority heuristics) with Oracle-driven selection. Let the Oracle decide which skills each TODO needs by reasoning about risk, novelty, scope, and history — not just size labels.

**Approach: Bundle skill selection into prioritize.** Prioritize already evaluates each TODO's priority, effort, risk, and context. Extend its output in `priority.md` to include a "Recommended Pipeline" section (e.g., `### Recommended Pipeline` followed by `implement → qa`).

## ~~P3: Code Quality Sweep~~ — COMPLETE (2026-03-30)

Completed by default instance (job job-1774878955249-0d5486).


**What:** Five independent XS fixes with no architectural risk. Items are fully specified, no shared interfaces affected.

### Recommended Pipeline
implement → qa

**Effort:** XS (human: ~1 day / CC: ~15 min)
**Depends on:** Nothing
**Added by:** Daemon prioritize on 2026-03-30

## ~~P3: Daemon Fleet Command — Parallel Launch + Auto-Cleanup + Live Status~~ — COMPLETE (2026-03-30)

**What:** Three capabilities that make parallel daemon operation a first-class experience:

**1. `daemon start --parallel N`.** Single command to launch N coordinated instances. Creates worker-1 through worker-N with worktrees, writes per-instance configs (unique designDoc for dedup bypass), triggers each with the self-improvement pipeline. Validates budget fits N simultaneous jobs. Replaces 50+ manual tool calls.

**2. Auto-cleanup on start.** Runs `doctor --fix` automatically when any daemon starts: clears stale PIDs, orphaned worktrees, stuck locks, dead instance budget entries, orphaned TODO state files. No more manual cleanup sessions.

**3. Real-time pipeline status.** `daemon status` shows: current skill (e.g., "implement 3/5"), claimed TODO title, time elapsed, commits made. Format: `Running: implement (3/5) — "Self-Commit Filtering" — 12m 34s — 3 commits`. Reads pipeline.json + worktree git log. Replaces 100+ manual log-reading tool calls per session.

**Why:** Launching 5 parallel instances in Session 3 took 30+ minutes of manual orchestration per attempt. Every session started with 15+ minutes of cleanup. Every status check required reading raw logs. These three features make parallel operation a single command with full visibility.

**Files:** `src/cli.ts` (--parallel flag, status formatting), `src/daemon.ts` (multi-instance start, doctor-on-boot, IPC status enhancement), `src/doctor.ts` (extract fix logic into callable function)

**Effort:** M (human: ~1 week / CC: ~45 min)
**Depends on:** Nothing
**Added by:** Session 3 retrospective on 2026-03-29

## ~~P3: Oracle Intelligence — Session Reuse + Adaptive Scheduling + Resilience~~ — COMPLETE (2026-03-30)

**What:** Three capabilities that make the Oracle smarter, faster, and more robust:

**1. Session reuse (50% latency reduction).** Persistent Oracle conversation per job. First decision sends full 43K context, subsequent resume with ~1K. Oracle sees its full decision thread for consistency. Auto-reset after 25 decisions. Fallback to full prompt on session errors. Requires spike to verify SDK resume with maxTurns:1.

**2. Memory-informed adaptive scheduling.** Oracle learns trigger patterns from job outcomes: "QA finds 3x more bugs after large commits, trigger QA on 5+ file changes." Replaces static cron with learned patterns. Needs 50+ jobs of history (currently ~40+).

**3. Graceful shutdown + observability.** AbortSignal propagation for clean daemon shutdown (replaces 60s polling timeout). Route parseBatchOracleResponse console.warn through event callbacks for daemon log visibility. Both are small fixes rolled into the larger Oracle work.

**Why:** Oracle latency is ~3-5% of job time at 20 decisions × 2-5s each. Session reuse halves this. Adaptive scheduling eliminates unnecessary jobs entirely. Graceful shutdown prevents orphaned SDK queries on SIGTERM.

**Effort:** M (human: ~1 week / CC: ~1 hour)
**Depends on:** Oracle batching (COMPLETE), 50+ jobs of history for scheduling (nearly met)
**Added by:** /plan-ceo-review 2026-03-26, consolidated in Session 3 retrospective

## ~~P3: Oracle Decision Batching (Latency Optimization)~~ — COMPLETE (2026-03-29)

Implemented in 2 commits on `garyclaw/worker-5`. `askOracleBatch()` in oracle.ts batches multiple questions into one API call with `buildBatchOraclePrompt()` / `parseBatchOracleResponse()`. Ask-handler uses batching when available + multi-question, serial fallback otherwise. Orchestrator wires `askOracleBatch` into oracle config. 43 new tests (32 oracle-batch + 11 ask-handler-batch). Backward compatible: single questions delegate to `askOracle()`, `askOracleBatch` is optional in config.

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

## ~~P5: Low-Severity QA Findings (deferred)~~ — COMPLETE (2026-03-29)

All 15 items resolved. Last 4 fixed by worker-5 instance on 2026-03-29: isTaste JSDoc documentation, parseDomainSections edge case test, pipeline startTime default fallback, pipeline static import conversion.

**What:** 15 low-severity issues found by /qa deep audit (run 5, 2026-03-27). None are bugs that affect correctness today, but are code quality / robustness improvements.

**Items:**
- [x] `isTaste` field in oracle.ts mirrors confidence threshold, not taste semantics — rename or document — Documented with JSDoc on OracleOutput.isTaste, 2026-03-29
- [x] Oracle ESCALATION_PHRASES "delete" matches benign strings like "deleted" — use word boundary — Fixed by /qa Run 6 on main, 2026-03-27 (ISSUE-003)
- [x] `(msg as any)` type assertions in `createSdkOracleQueryFn` — add runtime shape validation — Fixed by /qa Run 11 on main, 2026-03-28 (ISSUE-001): replaced with extractResultData
- [x] `INJECTION_PATTERNS` in oracle-memory.ts bypassable with leading whitespace — trim before matching — Fixed by /qa Run 6 on main, 2026-03-27 (ISSUE-001)
- [x] Shallow copy in `updateMetricsWithOutcome` shares `confidenceTrend` array reference — deep copy array — Fixed by /qa Run 8 on main, 2026-03-27 (ISSUE-001)
- [x] `readDecisionsFromLog` silently drops corrupt JSONL lines — add warning log — Fixed by /qa Run 8 on main, 2026-03-27 (ISSUE-002)
- [x] `parseDomainSections` edge case with adjacent sections without body text — add test — Added 2 edge case tests, 2026-03-29
- [x] `createResearchCanUseTool` sync return used where async expected — align signatures — Fixed by /qa Run 8 on main, 2026-03-27 (ISSUE-003)
- [x] Research cost extraction uses `(msg as any).total_cost_usd` — use extractResultData instead — Fixed by /qa Run 10 on main, 2026-03-28 (ISSUE-002)
- [x] `extractTopicKeywords` doesn't filter numeric-only tokens — add isNaN guard — Fixed by /qa Run 11 on main, 2026-03-28 (ISSUE-002): added `/^\d+$/` filter
- [x] `isTopicGroupFresh` brittle to topic naming variations — consider fuzzy matching — Fixed by /qa Run 11 on main, 2026-03-28 (ISSUE-003): checks all matching sections, not just first
- [x] `branchName` doesn't sanitize `instanceName` for illegal git branch chars — add validation — Fixed by /qa Run 6 on main, 2026-03-27 (ISSUE-002)
- [x] `listWorktrees` swallows all git errors silently — log warning on error — Fixed by /qa Run 8 on main, 2026-03-27 (ISSUE-004)
- [x] Pipeline `startTime!` non-null assertion — use explicit default — Replaced with `?? state.startTime` fallback, 2026-03-29
- [x] Pipeline dynamic import of orchestrator creates circular dependency — extract shared interface — No circular dep exists; converted to static import, 2026-03-29

**Effort:** XS each (human: ~30 min each / CC: ~5 min each)
**Depends on:** Nothing
**Added by:** /qa on 2026-03-27

## ~~P3: Evaluate Bootstrap Output Quality After First Dogfood Run~~ — COMPLETE (2026-03-30)

Implemented in commit adeabef. Fixed two verifier bugs: per-feature test-count claims now marked as per-feature verified (pre-pass count detection), PostgreSQL indirect deps extended with Supabase/Prisma/Drizzle packages. NihontoWatch fixture integration test validates score >50. 13 new tests in evaluate-claims.regression-2.test.ts.

**What:** After the first dogfood run on an external repo, evaluate bootstrap output quality: is CLAUDE.md accurate enough for the pipeline? Does TODOS.md produce items scoring >5.0 in prioritize? If not, implement Approach B (QA pre-scan before bootstrap).
**Why:** The entire bootstrap skill is a bet that single-pass analysis produces useful artifacts. The bet needs an explicit evaluation checkpoint. Without it, the evaluation gets forgotten and we ship a bootstrap skill that might produce unusable output.
**Effort:** S (human: ~2 hours / CC: ~15 min)
**Depends on:** First dogfood run completing on an external repo
**Added by:** /plan-eng-review on 2026-03-28, confirmed by /qa on 2026-03-28

## ~~P2: Wire Deterministic TS Analysis Into Evaluate Pipeline Path~~ — COMPLETE (2026-03-28)

Implemented in commit 0b53787 + eng review fixes. `createTextAccumulatingCallbacks` in pipeline.ts wraps evaluate callbacks for text capture. `runPostEvaluateAnalysis` in evaluate.ts runs full deterministic pipeline: analyzeBootstrapQuality + analyzeOraclePerformance + analyzePipelineHealth + extractObviousImprovements + parseClaudeImprovements (last-valid-match) + deduplicateImprovements + writeEvaluationReport. Default evaluation helpers extracted for DRY. 18 tests in pipeline-evaluate-wiring.test.ts. All sub-items (1A-4A + error boundary) complete.

**What:** The evaluate skill has well-tested pure TS analysis functions (writeEvaluationReport, parseClaudeImprovements, deduplicateImprovements, extractObviousImprovements) that are never called in the actual pipeline path. The pipeline currently relies on Claude writing files via the prompt, which is best-effort. Wire the deterministic path: after the evaluate segment completes, run all analysis functions from TypeScript, parse Claude's `<improvements>` output, merge with obvious improvements via dedup, and write the final improvement-candidates.md. Also includes 3 accepted code quality fixes.

**Why:** Without this wiring, the self-improvement loop is broken. The cli.ts post-pipeline hook reads improvement-candidates.md to append to GaryClaw's TODOS.md, but that file only exists if Claude happens to write it. The tested, deterministic TypeScript path is orphaned from the runtime pipeline. This blocks the entire evaluate skill from functioning as designed.

**Pros:** Closes the self-improvement feedback loop. Makes the evaluate skill deterministic instead of best-effort. Enables the dedup merge logic (obvious + Claude candidates) that's already tested. Fixes 3 code quality issues found in eng review.

**Cons:** Requires understanding how to extract Claude's segment output after runSkillWithPrompt completes. May need a small pipeline.ts change to capture segment output.

**Context:** Found by /plan-eng-review on 2026-03-28. Four accepted findings rolled into one TODO:
- 1A: Wire TS analysis into pipeline (writeEvaluationReport + parseClaudeImprovements + deduplicateImprovements called after segment)
- 2A: Fix effort scale mapping in formatImprovementCandidates (human/CC scales are identical, should show compression ratio: XS→human:~30min/CC:~5min, S→human:~2days/CC:~20min, M→human:~1week/CC:~1h)
- 3A: Use atomic read-then-write for TODOS.md append in cli.ts hook (safeReadText + safeWriteText instead of appendFileSync)
- 4A: Add 4 CLI hook tests (happy path, skip same project, skip missing candidates, error handling) + 4 minor branch tests (priority.md extraction, researchTriggered, duration, adaptiveTurnsUsed)
- Add error boundary in buildEvaluatePrompt around analysis function calls

**Effort:** S (human: ~3 days / CC: ~20 min)
**Depends on:** Nothing (evaluate.ts and all analysis functions already exist and are tested)
**Added by:** /plan-eng-review on 2026-03-28

## ~~P2: Self-Commit Filtering in Git Poller~~ — COMPLETE (2026-03-28)

Implemented by cron-fix daemon instance. GARYCLAW_DAEMON_EMAIL constant in sdk-wrapper.ts, getCommitEmails() in triggers.ts, self-commit filtering in poll loop, selfCommitEmail config override. 7 commits auto-merged to main. QA'd with 4 fixes.

## ~~P2: Sleep-Resilient Cron Poller~~ — COMPLETE (2026-03-28)

Implemented by worker-1 daemon instance. lastCheckedAt scan on wake, single-fire cap, recovery logging, O(minutes-slept) per tick. 4 commits auto-merged to main.

## ~~P2: Pipeline Resume After Daemon Crash~~ ✅ COMPLETE (2026-03-29)

Shipped in 5 commits on `garyclaw/overnight-3`: retry logic in `job-runner.ts` (re-queue with `retryCount`, abandon after 3 crashes), `resumePipeline` wiring for multi-skill jobs with `pipeline.json`, `priorSkillCostUsd` for dashboard cost tracking, crash recovery stats in `formatDashboard`, and `notifyJobResumed` for recovery notifications. 27 tests in `job-runner-resume.test.ts` + 11 regression tests from QA review.

## ~~P3: Oracle Session Reuse~~ — Absorbed into "Oracle Intelligence" above

## ~~P5: Route parseBatchOracleResponse console.warn Through Callbacks~~ — COMPLETE (2026-03-29)

## ~~P4: Extract Shared Oracle Prompt Prefix (DRY Fix)~~ — COMPLETE (2026-03-29)

## ~~P3: Code Quality Sweep — Observability + Platform Safety + DRY~~ — COMPLETE (2026-03-29)

**What:** Batch of 5 code quality fixes that are individually XS but together form a meaningful improvement to daemon observability and cross-platform safety:

1. **Route remaining 8 console.warn calls through callbacks** — ask-handler (2), reflection (4), worktree (2) all use console.warn which is invisible in daemon mode. Apply the proven onWarn callback pattern.
2. **Replace `head -5` shell-out in detectArtifacts with native Node I/O** — platform dependency (no `head` on Windows), unnecessary subprocess spawn per design doc scan.
3. **Pass rootCheckpointDir explicitly through GaryClawConfig** — replace fragile regex path stripping (`replace(/\/jobs\/[^/]+$/, "")`) with an explicit field set by job-runner.
4. **Cache resolveBaseBranchSafe() in detectArtifacts** — called twice per invocation, each spawning a subprocess. Call once, pass result.
5. **Harden todo-state slugify for edge cases** — test with Unicode titles, very long titles, titles with only special characters.

**Why:** Each fix is 5-15 minutes individually but together they make the daemon more observable (warn routing), more portable (native I/O), more robust (explicit paths), and faster (cached git calls). Worth one pipeline cycle as a batch.

**Effort:** S (human: ~2 days / CC: ~20 min as batch)
**Depends on:** Nothing
**Added by:** /plan-eng-review on 2026-03-29, consolidated in Session 3 retrospective

## ~~P3: Post-Merge Test Verification + Auto-Revert Safety Net~~ — COMPLETE (2026-03-30)

Implemented as `verifyPostMerge()` in `worktree.ts` + `handlePostMergeVerification()` in `job-runner.ts`. Includes: test execution on main after merge, SHA-targeted auto-revert, audit log (`merge-reverts.jsonl`), failure taxonomy record, P2 bug TODO creation, macOS notification, smart skip (when pre-merge tests passed), `skipPostMergeVerification`/`forcePostMergeVerification` config flags, dashboard integration. 22+ tests across `worktree-post-merge.test.ts`, `job-runner-post-merge.test.ts`, `dashboard-post-merge.test.ts`.

Fixed by /qa on main, 2026-03-30.

## ~~P3: Daemon Continuous Self-Improvement Mode~~ — ALREADY EXISTS (2026-03-29)

Already implemented in commit b8c5ac8. Invented by prioritize without checking existing source code.

**What:** When the daemon's job queue is empty and no cron/git triggers are pending, automatically enqueue the self-improvement pipeline (`prioritize → implement → qa`) instead of idling. Configurable via `daemon.continuous: true` (default: false). Rate-limited to one auto-enqueue per 30 minutes to prevent runaway spending. Respects daily budget.

**Why:** Currently the daemon idles when the queue is empty, waiting for manual `daemon trigger` or git/cron triggers. But GaryClaw's core value proposition is "push code, go to sleep, wake up to results." If the backlog has items, the daemon should be working on them without requiring an explicit trigger for each cycle. This turns the daemon from a job executor into a perpetual improvement engine.

**Implementation:**
- New function `shouldAutoEnqueue()` in `job-runner.ts`: checks queue empty, no active job, no pending triggers, `continuous` config flag, last auto-enqueue > 30 minutes ago, remaining budget > `perJobCostLimitUsd`.
- Call `shouldAutoEnqueue()` in the daemon's main poll loop (alongside git/cron triggers). On true, enqueue `["prioritize", "implement", "qa"]` with `triggeredBy: "continuous"`.
- Add `"continuous"` to `Job.triggeredBy` union type.
- Add cooldown tracking in daemon state: `lastContinuousEnqueueAt` timestamp.
- Dashboard: show continuous cycle count + cost.

**Effort:** S (human: ~2 days / CC: ~20 min)
**Depends on:** Nothing
**Added by:** Auto-generated by prioritize on 2026-03-30 (backlog exhausted)

## ~~P3: GitHub PR Workflow — Create PRs Instead of Direct Merge~~ — COMPLETE (2026-03-30)

**What:** Instead of auto-merging worktree branches directly to main, create a GitHub Pull Request with a structured description (pipeline summary, skills run, issues found/fixed, oracle decisions, test results). Optionally wait for CI checks to pass before auto-merging the PR. Configurable: `merge.strategy: "direct" | "pr"` (default: `"direct"` for backward compat).

**Why:** Direct merge to main works for solo developers but lacks the paper trail that teams expect. PRs provide: (1) a reviewable history of what the daemon did and why, (2) a natural intervention point where humans can reject bad changes, (3) GitHub CI integration for external quality gates, (4) PR comments as a communication channel between daemon and developer. This moves GaryClaw from "solo dev tool" toward "team-ready autonomous agent."

**Implementation:**
- New function `createPullRequest()` in `worktree.ts`: uses `gh pr create` with title from TODO item, body from pipeline report + oracle decisions summary. Returns PR URL.
- New function `waitForChecksAndMerge()` in `worktree.ts`: polls `gh pr checks` until all pass, then `gh pr merge --squash`.
- Wire into `job-runner.ts` as alternative merge path when `config.merge.strategy === "pr"`.
- Extend dashboard with PR count, merge wait time.
- Extend notifier with PR created/merged notifications.
- Guard: if `gh` CLI not available, fall back to direct merge with warning.

**Effort:** S (human: ~3 days / CC: ~25 min)
**Depends on:** Nothing
**Added by:** Auto-generated by prioritize on 2026-03-30 (backlog exhausted)

## ~~P3: Global Budget Locking — Prevent Lost Updates in Parallel Instances~~

**Status:** COMPLETE — Fixed by /qa on main, 2026-03-30. See commits e10d6db..0f04a1a (5 commits). Budget lock module + doctor check #8 + daemon-registry integration. Constant drift risk fixed in 7909dcb.

**What:** `updateGlobalBudget()` in `daemon-registry.ts` does read-modify-write on `global-budget.json` with no file locking. When 2+ parallel daemon instances complete jobs simultaneously, they can lose each other's budget updates, under-counting costs and allowing budget overruns. Same applies to `setGlobalRateLimitHold()` and `clearGlobalRateLimitHold()`.

**Fix:** Wrap read-modify-write in a mkdir-based advisory lock (same pattern as `reflection-lock.ts`). Lock scope: per-budget-file. Timeout: 5s with retry.

**Effort:** XS (human: ~2 hours / CC: ~10 min)
**Depends on:** Nothing
**Added by:** /qa on 2026-03-30 (ISSUE-005, deferred)

## ~~P4: IPC Server Connection Timeout~~ — COMPLETE (2026-03-30)

Fixed by /qa on main, 2026-03-30. Commit d95a15b: socket.setTimeout(30_000) + 1 MiB buffer cap. Regression test: daemon-ipc.regression-1.test.ts.

**What:** The Unix domain socket IPC server in `daemon-ipc.ts` has no per-connection timeout. A hung CLI process that connects but never sends data keeps the connection open indefinitely, with the data buffer accumulating with no cap.

**Fix:** Add `socket.setTimeout(30000)` with cleanup handler.

**Effort:** XS (human: ~1 hour / CC: ~5 min)
**Depends on:** Nothing
**Added by:** /qa on 2026-03-30 (ISSUE-006, deferred)

## ~~P5: Dead Code in Auto-Mark Guard~~ — COMPLETE (2026-03-30)

Completed (detected by artifact reconciliation, job job-1774882911918-a44eea).


**What:** Line 857 of `job-runner.ts`: `finalState === "complete" || finalState === "merged"` — the `"merged"` branch is unreachable because the ternary on lines 840-844 always promotes merged → complete before the guard runs. Not a behavioral bug, but misleading code.

**Fix:** Change to `if (finalState === "complete")` with a comment explaining why merged is covered (promoted upstream).

**Effort:** XS (human: ~15 min / CC: ~2 min)
**Depends on:** Nothing
**Added by:** /qa on 2026-03-30 (ISSUE-002, deferred)

## ~~P3: Auto-Fix Loop After Post-Merge Revert~~ — COMPLETE (2026-03-30)

Implemented in 6 commits (6a926f7..d668ded). Auto-fix coordinator module with retry cap (max 2), budget guard (2× original job cost), state persistence in `.garyclaw/auto-fix-state/`. Wired into post-merge verification and job completion. Doctor check #9 for stale auto-fix state. Dashboard auto-fix stats in Merge Health section. `autoFixOnRevert` config flag (default: false).

**What:** When post-merge verification reverts a merge, immediately enqueue an `implement → qa` pipeline targeting the specific regression, instead of waiting for the next prioritize cycle. The operator wakes up to a clean main instead of a reverted main + pending bug TODO.

**Why:** Currently, after a revert the daemon creates a P2 bug TODO and waits for the next prioritize cycle to pick it up. With an auto-fix loop, the daemon would attempt an immediate fix. This makes overnight operation fully self-healing for test regressions.

**Risks:**
- Infinite loop: fix introduces new regression → revert → fix → ... Mitigate with a retry cap (max 2 auto-fix attempts per original merge, then fall back to bug TODO).
- Budget: each attempt costs $3-5. Cap total auto-fix budget at 2× the original job cost.
- Complex interaction with prioritize: the auto-fix job must claim the bug TODO and skip the prioritize step.

**Implementation:**
- After revert in `handlePostMergeVerification()`, enqueue `implement → qa` with the bug TODO title as context and a `triggeredBy: "post-merge-revert"` source.
- Add `autoFixRetryCount` to the bug TODO or job metadata. If count >= 2, skip auto-fix and leave the bug TODO for human/prioritize.
- Guard: `config.merge.autoFixOnRevert: false` (default, opt-in).

**Effort:** S (human: ~3 days / CC: ~25 min)
**Depends on:** Post-merge test verification (COMPLETE)
**Added by:** /plan-eng-review recommendation, added by /qa on 2026-03-30

## ~~P3: Add Exponential Decay to computeCategoryStats()~~ — COMPLETE (2026-03-30)

Completed (detected by artifact reconciliation, job job-1774886576583-c78bb2).


**What:** Add exponential decay weighting to `computeCategoryStats()` in `pipeline-history.ts`, consistent with the existing `computeSkipRiskScores()` decay pattern in the same file.

**Why:** Category stats treat a 6-month-old outcome the same as yesterday's. The existing skip-risk scoring already uses exponential decay (`DEFAULT_DECAY_HALF_LIFE`). As the daemon accumulates category history, stale patterns will persist and mislead the Oracle. Inconsistent treatment within the same file.

**Implementation:**
- Copy the timestamp parsing + weighting approach from `computeSkipRiskScores()` (~lines 150-200)
- Apply decay to outcome counts in `computeCategoryStats()` so recent outcomes weigh more
- ~30 lines of code + ~10 tests

**Effort:** XS (human: ~2 hours / CC: ~15 min)
**Depends on:** Nothing
**Added by:** /plan-eng-review outside-voice finding #5, added by /qa on 2026-03-30

## ~~P2: Oracle-Driven Skill Selection + Deterministic Override Mode~~ — COMPLETE (2026-03-30)

**What:** Replace the static 5-skill lookup table in `pipeline-compose.ts` with two modes:

**Mode 1 — Deterministic Override: COMPLETE (2026-03-30).** When the user specifies both a TODO item and a skill sequence via `daemon trigger --todo "Title" skill1 skill2 ...`, bypass composition entirely. No intersection, no stripping. The user owns the pipeline.

**Mode 2 — Oracle Task Category Learning Loop: COMPLETE (2026-03-30).** When no skills are specified (or the daemon auto-picks via prioritize/continuous), the Oracle reasons about what the task actually needs by:
1. ~~Reading the TODO description and classifying the task nature (visual/UX, architectural, bug fix, refactor, performance, infra)~~ DONE: `parseTaskCategory()` in job-runner.ts
2. ~~Consulting a **skill catalog** — a structured description of every available gstack skill (what it does, when it's useful, what it produces).~~ DONE: `src/skill-catalog.ts` static registry (10 skills, plan/exec modes).
3. ~~Selecting the optimal skill sequence based on task nature + skill capabilities + history~~ DONE: prioritize prompt outputs `### Recommended Pipeline` + `### Task Category`
4. ~~Learning from outcomes: "last time we skipped design-review on a UI task, QA found 8 visual issues"~~ DONE: `computeCategoryStats()` in pipeline-history.ts, injected into prioritize prompt

**Why:** The current static table only knows 5 skills (`prioritize, office-hours, implement, plan-eng-review, qa`). Any gstack skill (`plan-design-review`, `design-review`, `design-consultation`, `browse`, `qa-only`, etc.) gets silently killed by the intersection logic in `composePipeline()`. This caused a P0 mobile UI/UX task to have its design skills stripped and then get deprioritized because the pipeline couldn't do design work. The Oracle should understand that a visual UX task needs design skills, an architectural change needs eng review, and a simple bug fix just needs implement + qa.

**Immediate fix (ship first):** ~~Pass through unknown skills in `composePipeline()` — skills not in `FULL_PIPELINE` should survive intersection untouched.~~ DONE (commit 1a519db, 2026-03-30). This unblocks manual triggers with gstack skills while the Oracle skill selection is built.

**Implementation:**
- ~~`src/pipeline-compose.ts`: Fix intersection to preserve unknown skills (immediate)~~ DONE
- ~~`src/cli.ts`: Add `--todo` flag to `daemon trigger` for deterministic mode~~ DONE
- ~~`src/types.ts`: Add `skipComposition` flag on Job, `todoTitle` on trigger~~ DONE
- ~~`src/job-runner.ts`: When `skipComposition` is true, bypass `composePipeline()` entirely~~ DONE
- ~~New: `src/skill-catalog.ts` — scan available skills, build structured descriptions~~ DONE (10 skills, 15 tests)
- ~~`src/oracle.ts` or `src/prioritize.ts`: Oracle prompt for skill selection given task + catalog~~ DONE (injected into prioritize prompt)
- ~~`src/pipeline-history.ts`: Track per-skill outcomes by task category for learning (Mode 2)~~ DONE: `computeCategoryStats()` + per-category stats in prioritize prompt

**Effort:** M (human: ~1 week / CC: ~1 hour). Both modes complete.
**Depends on:** Nothing
**Added by:** Human on 2026-03-30 (discovered when daemon stripped design skills from P0 mobile vault task)

## ~~P2: Auth Failure Runaway Loop — Continuous Mode Spins on $0 Jobs~~

Fixed by /qa on main, 2026-03-30. Implemented in b3f44aa: auth failures trigger rate limit hold (30-min fallback), MIN_COST_FOR_REENQUEUE ($0.01) prevents $0 spin loops, cross-instance coordination via global budget. 10 tests in job-runner-auth-hold.test.ts.

## P4: Consolidate Lock Modules — Shared Advisory Lock Base

**What:** `budget-lock.ts` (151 lines) and `reflection-lock.ts` (153 lines) are ~98% identical. Same for their doctor checks (`checkStaleBudgetLocks` ~120 lines, `checkReflectionLocks` ~100 lines). Total duplication: ~440 lines across 4 code paths.

**Fix:** Extract a shared `advisory-lock.ts` parameterized by `(lockDirName, defaultTimeoutMs, pollIntervalMs)`. Both `budget-lock.ts` and `reflection-lock.ts` become thin re-export wrappers (~10 lines each). Extract a shared `checkStaleLockDir()` helper in doctor.ts. Net reduction: ~220 lines.

**Why:** If a third lock type appears (e.g., merge-lock already uses the mkdir pattern in worktree.ts), the maintenance burden triples. The eng review decided "Consolidate now" (Decision #1, Option C).

**Effort:** XS (human: ~2 hours / CC: ~10 min)
**Depends on:** Global Budget Locking (COMPLETE)
**Added by:** /qa on 2026-03-30 (ISSUE-002, deferred from eng review Decision #1)

## P3: Browser Cookie Persistence for Daemon — Authenticated Page Testing

**What:** The daemon's `design-review` and `qa` skills can't test authenticated pages because the headless browser has no login session. Currently `/setup-browser-cookies` imports cookies interactively but they don't survive daemon restarts or carry across skill segments (each skill spawns a fresh SDK session).

**Fix:** Add cookie persistence to the daemon lifecycle:
1. **Import** — `daemon start --import-cookies` runs `$B cookie-import-browser` on startup, importing from the user's real browser
2. **Persist** — Export cookies to `.garyclaw/browser-cookies.json` after import
3. **Restore** — Before each browser-dependent skill segment, restore cookies from disk via `$B cookie-set`
4. **Refresh** — Re-import on `SIGHUP` config reload or `daemon start --import-cookies` re-run
5. **Scope** — Only import domains listed in `daemon.json` config (e.g., `"browserCookies": { "domains": ["nihontowatch.com", "localhost:3000"] }`)

**Why:** Discovered on 2026-03-30 when the P0 mobile vault UI/UX task on NihontoWatch couldn't be fully tested by the daemon — vault pages require auth. The daemon could design and implement from code context but couldn't do visual QA or design-review on the live authenticated pages.

**Effort:** S (human: ~3 days / CC: ~25 min)
**Depends on:** Nothing
**Added by:** Human on 2026-03-30 (discovered during NihontoWatch P0 mobile vault deployment)

## ~~P3: Flaky job-runner-post-merge.test.ts Under Parallel Vitest Execution~~ — COMPLETE (2026-03-30)

Completed (detected by artifact reconciliation, job job-1774882223603-160fda).


**What:** `test/job-runner-post-merge.test.ts` intermittently fails (7/12 tests) when run in the full 189-file suite. All 12 tests pass in isolation and when run with related job-runner test files. Root cause: `vi.mock("node:child_process")` contamination across Vitest fork workers when multiple test files mock the same module in the same worker pool.

**Fix options:**
1. **Quick:** Add to `sequentialFiles` in vitest.config.ts to run in its own worker
2. **Better:** Refactor tests to avoid global `vi.mock("node:child_process")` — use per-test dependency injection instead (matches the pattern in newer test files like `job-runner-pr.test.ts`)

**Severity:** Low — flaky, not a real regression. Affects CI reliability but not code correctness.

**Effort:** XS (human: ~1 hour / CC: ~5 min)
**Depends on:** Nothing
**Added by:** /qa on 2026-03-30 (ISSUE-004, deferred — not reproducible on retry)
