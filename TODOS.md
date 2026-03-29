# TODOS

## P2: Pre-Merge Validation Gate (Reimplement from Design Doc)

**What:** Run tests in the worktree after rebase but before ff-only merge. Test failure blocks merge (retryable error). Merge audit JSONL log tracks all attempts. Dashboard merge health as 5th signal. Previously built by worker-2 overnight but could not be merged due to conflicts with Workers 5+1 on main. Design doc preserved.

**Why:** Every auto-merge overnight failed with "Working tree has uncommitted changes." This is the #1 reliability blocker for parallel daemon operation. Without a test gate, broken code lands on main and triggers $30-60 of wasted QA cascades.

**Design doc:** `docs/designs/pre-merge-validation-gate.md` (complete architecture, interfaces, test strategy)

**Effort:** S (human: ~2 days / CC: ~20 min — reimplementation from existing design, not greenfield)
**Depends on:** Nothing
**Added by:** Session 3 overnight parallel run — worker-2 built it but branch conflicted on merge (2026-03-29)

## P2: File-Level Conflict Prevention for Parallel Instances

**What:** When parallel daemon instances claim TODO items, also analyze which source files each item is likely to modify (from the design doc or TODO description). Prevent two instances from claiming items that touch the same files. Currently, parallel workers all branch from the same commit and independently modify the same core files (oracle.ts, types.ts, evaluate.ts, dashboard.ts), making only the first-to-merge succeed. The rest conflict.

**Why:** On 2026-03-29, 5 parallel workers built 5 features overnight ($49.60). Only 2 could be merged cleanly — the other 3 conflicted because they all modified oracle.ts and types.ts independently. That's ~$30 of work that needed reimplementation.

**Implementation notes:**
- In `processNext()` pre-assignment: after picking a TODO, scan its description/design-doc for file paths mentioned
- Build a `claimedFiles` set (union of all files claimed by running instances)
- Skip TODO items whose likely-modified files overlap with `claimedFiles`
- Heuristic: extract paths from `**Implementation notes:**` and `**Files:**` sections in TODO descriptions
- Fallback: if no files detectable, allow the claim (don't block work over missing metadata)

**Effort:** S (human: ~2 days / CC: ~20 min)
**Depends on:** Nothing
**Added by:** human observation on 2026-03-29

## P3: Semantic Validation for Bootstrap (Reimplement from Design Doc)

**What:** Five pure-TS validators that check CLAUDE.md claims against reality: validateFileReferences, validateTechStackClaims, validateTestClaims, validateCommands, validateTodosFormat. Runs in <100ms. Feeds correction prompts when bootstrap quality gate triggers re-bootstrap. Previously built by worker-4 overnight but could not be merged.

**Why:** Bootstrap can hallucinate file paths, wrong test frameworks, non-existent commands. Downstream skills (implement, QA) waste tokens working from incorrect assumptions. Semantic validation catches these before the pipeline continues.

**Design doc:** `docs/designs/evaluate-bootstrap-quality.md` + `docs/designs/todos-format-validation.md`

**Effort:** S (human: ~2 days / CC: ~20 min)
**Depends on:** Nothing
**Added by:** Session 3 overnight parallel run — worker-4 built it but branch conflicted (2026-03-29)

## P2: Fix Auto-Merge Dirty Working Tree + Cross-Cycle Dedup

**What:** Two related fixes that prevented overnight auto-merges from landing and caused duplicate rebuilds:

**Fix 1 — Dirty working tree blocks merge:** `mergeWorktreeBranch()` checks `git diff --quiet` on the main repo (not the worktree) before merging. This fails when `.garyclaw/` artifacts, daemon state files, or uncommitted session changes exist on main. Three-part fix:
- Add `.garyclaw/` to `.gitignore` in each worktree on creation (prevents daemon artifacts from showing as dirty)
- Before merge: `git stash --include-untracked` in repoDir, merge, then `git stash pop`
- Scope the dirty check to `git diff --quiet -- ':!.garyclaw'` (exclude .garyclaw dir from the check entirely)

**Fix 2 — Cross-cycle dedup (don't rebuild completed work):** When a feature builds successfully but merge fails, the next cron cycle re-assigns the same TODO and rebuilds from scratch. On 2026-03-29, workers rebuilt the same features 2-3 times each ($30 wasted). Fix: before pre-assigning a TODO, scan for existing `garyclaw/*` branches that match the claimed title (fuzzy match via normalized Levenshtein < 0.3). If a branch exists with commits ahead of main, skip the TODO — the work exists but just needs merge conflict resolution, not reimplementation.

**Implementation notes:**
- Fix 1 in `src/worktree.ts` `mergeWorktreeBranch()`: add stash/pop around the rebase+merge block, or exclude `.garyclaw` from the diff check
- Fix 1 in `src/worktree.ts` `createWorktree()`: ensure `.garyclaw/` is in the worktree's `.gitignore`
- Fix 2 in `src/job-runner.ts` `processNext()` pre-assignment: call `listWorktrees()` or scan `git branch --list 'garyclaw/*'`, check each branch for commits ahead of main, fuzzy-match branch name against TODO title
- Fix 2 alternative: scan `daemon-state.json` across all instances for completed jobs with `claimedTodoTitle` matching — if found and branch exists, skip

**Why:** On 2026-03-29 overnight, every auto-merge failed (dirty working tree) and every cron cycle rebuilt the same features (no cross-cycle dedup). Combined: 5 workers × 4 cycles × $3-4/run = $49 spent, but $30 was duplicate work on already-built features that couldn't merge.

**Effort:** S (human: ~2 days / CC: ~15 min)
**Depends on:** Nothing
**Added by:** human observation on 2026-03-29

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

## P3: Evaluate Bootstrap Output Quality After First Dogfood Run

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

## P2: Self-Commit Filtering in Git Poller

**What:** The git poller should ignore commits made by the daemon itself. When HEAD changes, run `git log --format=%ce {oldHead}..{newHead}` and skip the trigger if every commit has `committer_email === "garyclaw-daemon@local"`. This requires the daemon to set `GIT_COMMITTER_EMAIL=garyclaw-daemon@local` in the env passed to `buildSdkEnv()` (already verified in spike: "Verify GIT_COMMITTER_EMAIL Propagation Through SDK" — COMPLETE 2026-03-27), and the poller to check committer identity before firing.

**Why:** The daemon's biggest dollar waste. Every pipeline run triggers a QA cascade: implement commits code → poller detects HEAD change → fires QA → QA commits fixes → poller detects again → fires more QA. On 2026-03-28, the daemon ran 8 QA passes (~$6) chasing its own commits when 2-3 would have sufficed. This happens on every cron cycle. At 12 cycles/day, that's $30-60/day wasted.

**Pros:** Saves $3-5 per pipeline run. Eliminates the self-triggering cascade entirely. The GIT_COMMITTER_EMAIL approach is already spiked and verified. The git poller already has the old/new HEAD values — just needs to check the committer before calling onTrigger.

**Cons:** Daemon commits become invisible to the git poller. If a daemon commit introduces a regression, QA won't auto-trigger from the poll. Mitigation: the pipeline already includes QA as the final skill, so regressions are caught in-pipeline. External commits (human pushes) still trigger QA normally.

**Implementation notes:**
- In `src/sdk-wrapper.ts` `buildSdkEnv()`: add `GIT_COMMITTER_EMAIL: "garyclaw-daemon@local"` to the env object
- In `src/triggers.ts` `getGitHead()`: add a new export `getCommitAuthors(projectDir, oldHead, newHead): string[]` that returns committer emails via `git log --format=%ce {old}..{new}`
- In `src/triggers.ts` `createGitPoller` poll function: after detecting HEAD change, call `getCommitAuthors()` and skip trigger if all are `garyclaw-daemon@local`
- Add `committerEmail` to `GitPollerDeps` for testability (injectable like `getHead`)

**Effort:** XS (human: ~30 min / CC: ~5 min)
**Depends on:** Nothing (GIT_COMMITTER_EMAIL spike already passed)
**Added by:** human observation on 2026-03-28

## P2: Sleep-Resilient Cron Poller

**What:** The cron poller currently checks every 60s: "does the current minute match the cron expression?" If macOS sleeps through a matching minute, the trigger is permanently lost. Fix: track `lastCheckedAt` timestamp and on each tick, check if *any* matching minute occurred between `lastCheckedAt` and now. When the laptop wakes after hours of sleep, the poller catches up immediately and fires the missed trigger.

**Why:** The self-improvement pipeline runs on `0 */2 * * *` (every 2 hours). macOS sleep regularly causes missed triggers overnight — observed on 2026-03-27 when the cron poller missed triggers during sleep. Each missed trigger = one lost improvement cycle. Over a night of sleep (8h), that's 3-4 missed cycles, which means 3-4 features/fixes that could have been built but weren't.

**Pros:** Makes overnight autonomous operation reliable. The daemon becomes truly "start and forget" instead of "check in every few hours." Simple change to `createCronPoller` — replace the "does current minute match?" check with a "did any minute since lastCheckedAt match?" scan.

**Cons:** After a long sleep, the catch-up fire is delayed until the next 60s tick. Could fire multiple triggers if multiple cron windows were missed — but the job dedup will collapse them. One edge case: if the laptop sleeps for 24+ hours, firing all missed triggers at once could be expensive. Mitigation: cap catch-up to 1 trigger (fire at most once per wake, regardless of how many windows were missed).

**Implementation notes:**
- In `src/triggers.ts` `createCronPoller`: add `let lastCheckedAt = Date.now()` state
- On each `check()` tick: scan every minute from `lastCheckedAt` to `now` against the cron schedule. If any match and `lastFiredMinute` doesn't cover it, fire once and update `lastCheckedAt = Date.now()`
- Cap catch-up: if multiple windows were missed, fire only once (the most recent match)
- Add `lastCheckedAt` to `CronPollerDeps` for testability

**Effort:** S (human: ~2 days / CC: ~15 min)
**Depends on:** Nothing
**Added by:** human observation on 2026-03-28

## ~~P2: Pipeline Resume After Daemon Crash~~ ✅ COMPLETE (2026-03-29)

Shipped in 5 commits on `garyclaw/overnight-3`: retry logic in `job-runner.ts` (re-queue with `retryCount`, abandon after 3 crashes), `resumePipeline` wiring for multi-skill jobs with `pipeline.json`, `priorSkillCostUsd` for dashboard cost tracking, crash recovery stats in `formatDashboard`, and `notifyJobResumed` for recovery notifications. 27 tests in `job-runner-resume.test.ts` + 11 regression tests from QA review.

## P3: Oracle Session Reuse (Latency Optimization — Approach A)

**What:** Maintain a persistent Oracle conversation per ask-handler instance. First decision sends full 43K context (principles + memory + history), subsequent decisions resume with just ~1K (the new question). Expected 50% latency reduction across ALL Oracle calls, not just multi-question batches.

**Why:** Oracle batching (COMPLETE) only helps when multiple questions arrive in the same AskUserQuestion call. In practice, most questions arrive individually (1 per tool call). Session reuse would give 50% reduction on ALL Oracle calls by amortizing the 43K prompt across the session.

**Approach:** SDK resume with `maxTurns:1` Oracle-style queries. First call builds full prompt, subsequent calls resume the same conversation with just the new question. Requires a spike to verify SDK resume works with single-turn Oracle queries.

**Pros:** 50% latency reduction on every Oracle call. Compounds with batching (batching helps multi-question, session reuse helps single-question).

**Cons:** Requires spike to verify SDK resume behavior. Session state management adds complexity. If the session context grows unbounded, may need periodic reset.

**Context:** Recommended by /plan-eng-review on 2026-03-29 as the primary optimization. Batching was the secondary optimization (now COMPLETE). Session reuse is the bigger win because it applies to all calls.

**Effort:** S (human: ~3 days / CC: ~30 min)
**Depends on:** Oracle batching (COMPLETE), spike to verify SDK resume with maxTurns:1
**Added by:** /plan-eng-review on 2026-03-29

## P5: Route parseBatchOracleResponse console.warn Through Callbacks

**What:** 4 `console.warn` calls in `parseBatchOracleResponse` (oracle.ts:468-490) use stderr for fallback path observability. The rest of GaryClaw routes diagnostics through event callbacks. In daemon mode, stderr warnings are invisible... they don't appear in the daemon log, decision audit trail, or dashboard.

**Why:** When batch parsing falls back (array length mismatch, JSON parse failure, individual object fallback), operators have zero visibility. These are exactly the situations you'd want to know about.

**Implementation:** Add an optional `onWarn?: (msg: string) => void` callback to `parseBatchOracleResponse`, or return warnings alongside results for the caller to emit via the existing event system. The 4 `console.warn` calls become `onWarn?.()` calls.

**Effort:** XS (human: ~30 min / CC: ~5 min)
**Depends on:** Nothing
**Added by:** /plan-eng-review recommendation on 2026-03-29, written by /qa on 2026-03-29

## ~~P4: Extract Shared Oracle Prompt Prefix (DRY Fix)~~ — COMPLETE

**Completed:** 2026-03-29. Prompt prefix extracted in commit e878ab4 (`buildOraclePromptPrefix`). Field extraction helper extracted in commit 314ee5d (`extractOracleFields`). Both `buildOraclePrompt`/`buildBatchOraclePrompt` and `parseOracleResponse`/`parseBatchOracleResponse` now share single implementations.

**Added by:** /plan-eng-review on 2026-03-29
