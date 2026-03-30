# GaryClaw

**A learning development daemon that gets smarter every run.**

Push code. Go to sleep. GaryClaw runs QA, remembers what failed last Tuesday, applies your taste preferences, draws on researched domain knowledge, and makes decisions a senior engineer would respect. You wake up to results that feel like *your* work, not automation output.

GaryClaw wraps Claude Code in an external harness that monitors context usage, checkpoints state, and automatically relays work across fresh sessions — making skills effectively context-infinite. On top of that foundation, it adds autonomous decision-making (Oracle with 7 principles + memory), a persistent background daemon with parallel instances, and a self-improvement loop that prioritizes its own backlog, designs solutions, implements them, reviews the implementation, and fixes bugs — all without human intervention.

---

## Current Status

**Phase 1a: COMPLETE** (2026-03-25) — Core relay engine, 8 source modules
**Phase 1b: COMPLETE** (2026-03-25) — AskUserQuestion UX polish, live progress, decision audit log
**Phase 2: COMPLETE** (2026-03-25) — Decision Oracle, autonomous mode, replay command
**Phase 3: COMPLETE** (2026-03-25) — Skill Chaining, pipeline runner, context handoff, pipeline resume
**Structured Issue Extraction: COMPLETE** (2026-03-25) — Real-time + git log hybrid extraction
**Phase 4a: COMPLETE** (2026-03-25) — Daemon Mode MVP: lifecycle, IPC, job queue, git poll, notifications
**Phase 5a: COMPLETE** (2026-03-26) — Oracle Memory Infrastructure + Enhanced Oracle Prompt
**Phase 5b: COMPLETE** (2026-03-26) — Post-Job Reflection + Quality Tracking
**Phase 5c: COMPLETE** (2026-03-26) — Domain Expertise Research: researcher module, CLI command, freshness tracking
**Phase 6: COMPLETE** (2026-03-26) — Parallel Daemon Instances: registry, global budget, cross-instance dedup, reflection lock
**Git Worktree Isolation: COMPLETE** (2026-03-26) — Worktree per named instance, branch strategy, fast-forward merge on stop
**Dogfood Dashboard: COMPLETE** (2026-03-27) — Health score, job/oracle/budget stats, auto-regeneration after every job
**Auto-Research Trigger: COMPLETE** (2026-03-27) — Post-job low-confidence analysis, keyword clustering, auto-enqueue research
**Codebase Summary Persistence: COMPLETE** (2026-03-27) — Observation extraction, dedup, relay prompt injection across relay boundaries
**Adaptive maxTurns: COMPLETE** (2026-03-28) — Per-segment turn prediction from growth rate + heavy tool lookahead, browse-heavy gets 3-8 turns, edit-heavy gets full max
**Dogfood Bootstrap: COMPLETE** (2026-03-28) — Cold-start bootstrap skill, codebase analysis, CLAUDE.md/TODOS.md generation for external repos
**Pipeline Resume After Crash: COMPLETE** (2026-03-29) — Re-queue interrupted jobs, retry limit (3 crashes = abandon), pipeline resume from last completed skill, dashboard crash recovery stats
**Oracle Decision Batching: COMPLETE** (2026-03-29) — Multi-question batching into single API call, 50-70% latency reduction, per-question escalation, fallback chain parsing
**Bootstrap Quality Gate: COMPLETE** (2026-03-29) — Self-healing quality gate after bootstrap: analyzeBootstrapQuality check, QA pre-scan + enriched re-bootstrap on score < 50, retry cap, fail-open, dashboard enrichment stats
**TODO State Tracking: COMPLETE** (2026-03-29) — Persistent lifecycle state per TODO item, artifact detection (design docs, branches, commits), reconciliation with self-healing, pipeline skill trimming, doctor check #7
**Oracle Session Reuse: COMPLETE** (2026-03-29) — Stateful queryFn with SDK resume, buildResumePrompt strips 43K prefix, MAX_REUSE=25 reset, batch bypass, graceful fallback, observability events
**Adaptive Pipeline Composition: COMPLETE** (2026-03-29) — Static lookup table maps (effort, priority, hasDesignDoc) to minimal skill sequences, 4x throughput on XS/S items
**Oracle-Driven Pipeline Composition: COMPLETE** (2026-03-29) — Prioritize skill recommends pipeline, job-runner parses + overrides static table after 10+ outcomes, reflection writes pipeline outcomes to decision-outcomes.md, learning loop closes through existing oracle memory
**Daemon Fleet Command: COMPLETE** (2026-03-30) — `daemon start --parallel N` launches 2-10 workers with budget pre-validation, staggered starts, auto-cleanup. IPC pipelineProgress enrichment. Fleet table display via `daemon status --all`.
**Global Budget Locking: COMPLETE** (2026-03-30) — Budget lock prevents lost updates in parallel instances via mkdir-based advisory lock on global-budget.json writes. Doctor check #8 detects stale budget locks.
**GitHub PR Workflow: COMPLETE** (2026-03-30) — Optional `merge.strategy: "pr"` creates structured GitHub PRs instead of direct merge. PR body includes pipeline summary, oracle decisions, test results. Auto-merge via `gh pr merge --auto`. Fallback to direct merge when `gh` unavailable. New "pr-created" TODO state. Dashboard PR stats.
- 40 source modules, 193 test files, 3114 tests
- All 5 spikes passed (canUseTool, token tracking, env passthrough, relay prompt sizing, oracle session reuse)

---

## Usage

```bash
# Run a single skill
npx tsx src/cli.ts run qa --project-dir /path/to/project

# Run fully autonomous (Decision Oracle makes all decisions)
npx tsx src/cli.ts run qa --autonomous

# Run a skill pipeline (sequential execution with context passing)
npx tsx src/cli.ts run qa design-review ship
npx tsx src/cli.ts run /qa /design-review /ship   # slashes stripped automatically

# Review then implement (implement reads design doc + review context)
npx tsx src/cli.ts run plan-ceo-review plan-eng-review implement --autonomous

# Just implement from design doc (no review step)
npx tsx src/cli.ts run implement --autonomous

# Prioritize next backlog item (writes .garyclaw/priority.md)
npx tsx src/cli.ts run prioritize --autonomous

# Full autonomous loop: prioritize → implement → QA
npx tsx src/cli.ts run prioritize implement qa --autonomous

# Bootstrap a new repo (generates CLAUDE.md + TODOS.md from codebase analysis)
npx tsx src/cli.ts run bootstrap --autonomous --project-dir /path/to/target

# Full dogfood pipeline: bootstrap → prioritize → implement → QA
npx tsx src/cli.ts run bootstrap prioritize implement qa --autonomous --project-dir /path/to/target

# Dogfood + self-evaluation (appends improvement candidates to GaryClaw's TODOS.md)
npx tsx src/cli.ts run bootstrap prioritize implement qa evaluate --autonomous --project-dir /path/to/target

# Resume from last checkpoint or pipeline
npx tsx src/cli.ts resume --checkpoint-dir .garyclaw

# Replay decision timeline
npx tsx src/cli.ts replay

# Oracle memory management
npx tsx src/cli.ts oracle init                   # create memory dirs + templates

# Daemon mode (background process, supports parallel instances)
npx tsx src/cli.ts daemon start                    # start default daemon instance
npx tsx src/cli.ts daemon start --name review-bot  # start named parallel instance
npx tsx src/cli.ts daemon start --parallel 5       # launch 5 parallel workers (auto-cleanup + budget check)
npx tsx src/cli.ts daemon status                   # show default instance status
npx tsx src/cli.ts daemon status --all             # show all instances
npx tsx src/cli.ts daemon list                     # alias for status --all
npx tsx src/cli.ts daemon trigger qa design-review # enqueue to default instance
npx tsx src/cli.ts daemon trigger --name review-bot design-review  # enqueue to named instance
npx tsx src/cli.ts daemon log --tail 100           # view default daemon log
npx tsx src/cli.ts daemon log --name review-bot    # view named instance log
npx tsx src/cli.ts daemon stop                     # stop default instance
npx tsx src/cli.ts daemon stop --name review-bot   # stop named instance (merges branch)
npx tsx src/cli.ts daemon stop --name review-bot --cleanup  # stop + remove worktree/branch
npx tsx src/cli.ts daemon stop --all               # stop all instances

# Domain expertise research
npx tsx src/cli.ts research "WebSocket libraries"  # research a topic
npx tsx src/cli.ts research "OAuth 2.1" --force    # re-research ignoring freshness

# Dogfood dashboard
npx tsx src/cli.ts dashboard                       # print health score + job/oracle/budget stats

# Options
npx tsx src/cli.ts run qa \
  --max-turns 15 \         # turns per segment (default: 15)
  --threshold 0.85 \       # relay at 85% context (default: 0.85)
  --max-sessions 10 \      # max relay sessions (default: 10)
  --autonomous \           # use Decision Oracle
  --no-memory \            # disable Oracle memory injection
  --no-adaptive            # disable adaptive maxTurns (use fixed value)

# Run tests
npm test
```

---

## Architecture

```
CLI (args, readline, display, daemon subcommands, --name/--all)
  → Daemon Registry (instance discovery, global budget, cross-instance dedup)
  → Daemon (persistent background process, PID file, IPC, per-instance dirs)
  |   → Job Runner (FIFO queue, budget enforcement, state persistence, global budget)
  |   |   → Auto-Research Trigger (post-job low-confidence analysis, keyword clustering, research enqueue)
  |   → Git Poller (HEAD change detection, debounce)
  |   → Notifier (macOS notifications, job summaries, instance labels)
  |   → Reflection Lock (advisory file lock for concurrent oracle-memory writes)
  |
  → Pipeline (multi-skill sequential execution, context handoff, git HEAD tracking)
      → Orchestrator (main loop per skill: sessions × segments)
          → sdk-wrapper.startSegment()  →  SDK query() generator
          → token-monitor (per-turn context tracking)
          → ask-handler (canUseTool callback for AskUserQuestion)
          → issue-extractor (real-time + git log issue extraction)
          → checkpoint (save state, generate relay prompt)
          → relay (git stash, build fresh segment)
          → report (merge cross-session results)
```

### Module Map

| Module | What |
|--------|------|
| `src/types.ts` | All shared interfaces — zero imports |
| `src/token-monitor.ts` | `recordTurnUsage`, `shouldRelay`, `computeGrowthRate`, `computeAdaptiveMaxTurns`, `HEAVY_TOOLS`, `HEAVY_TOOL_GROWTH_MULTIPLIER` |
| `src/checkpoint.ts` | Atomic write (2-rotation), tiered relay prompt generation |
| `src/ask-handler.ts` | `canUseTool` callback intercepting AskUserQuestion, oracle decision batching |
| `src/sdk-wrapper.ts` | SDK isolation layer: `startSegment`, `extractTurnUsage`, `buildSdkEnv` |
| `src/relay.ts` | Git stash + fresh relay segment + stash pop |
| `src/report.ts` | Merge issues/findings/decisions, markdown report |
| `src/oracle.ts` | Decision Oracle — 7 Principles, confidence scoring, escalation, memory injection, batch decisions, shared prompt prefix |
| `src/issue-extractor.ts` | Hybrid issue extraction from SDK stream + git log |
| `src/pipeline.ts` | Sequential skill chaining, context handoff, pipeline state, git HEAD tracking, text accumulation for post-skill analysis |
| `src/orchestrator.ts` | Two-level loop (sessions × segments), deferred relay |
| `src/daemon.ts` | Daemon process: PID, IPC server, pollers, signal handling, instance-aware |
| `src/daemon-ipc.ts` | Unix socket IPC: `createIPCServer`, `sendIPCRequest` |
| `src/daemon-registry.ts` | Multi-instance coordination: discovery, global budget, cross-instance dedup |
| `src/job-runner.ts` | FIFO job queue, budget enforcement, state persistence, global budget |
| `src/triggers.ts` | Git poll trigger with HEAD change detection + debounce |
| `src/notifier.ts` | macOS notifications via osascript, job summary files, instance labels |
| `src/reflection-lock.ts` | Advisory file lock (mkdir-based) for concurrent oracle-memory writes |
| `src/budget-lock.ts` | Advisory file lock (mkdir-based) for concurrent global-budget.json writes |
| `src/safe-json.ts` | Shared atomic JSON/text I/O — `safeReadJSON`, `safeWriteJSON`, corruption recovery |
| `src/oracle-memory.ts` | Two-layer oracle memory: read/write taste, domain expertise, outcomes, metrics |
| `src/reflection.ts` | Post-job reflection: decision outcomes, reopened detection, quality metrics |
| `src/researcher.ts` | Domain expertise research: web search, freshness tracking, section merge |
| `src/bootstrap.ts` | Bootstrap skill: codebase analysis, CLAUDE.md/TODOS.md generation for cold-start repos, enriched re-bootstrap prompt |
| `src/implement.ts` | Implement skill: design doc discovery, review context, prompt builder |
| `src/prioritize.ts` | Prioritize skill: TODOS.md parsing, overnight goal, oracle context, scoring prompt |
| `src/worktree.ts` | Git worktree isolation: create, remove, merge, list worktrees for parallel instances, PR creation via gh CLI |
| `src/dashboard.ts` | Dogfood dashboard: job/oracle/budget aggregation, health score, markdown formatting |
| `src/auto-research.ts` | Auto-research trigger: keyword extraction, topic grouping, freshness-aware enqueue |
| `src/codebase-summary.ts` | Codebase summary persistence: observation extraction, dedup, token budget, relay formatting |
| `src/doctor.ts` | Self-diagnostic command: 8 subsystem checks, --fix/--json flags, stale PID detection, orphaned TODO state, stale budget locks |
| `src/evaluate.ts` | Dogfood campaign evaluator: bootstrap quality, oracle performance, pipeline health, improvement extraction, post-evaluate deterministic analysis |
| `src/failure-taxonomy.ts` | 10-category failure classification, failures.jsonl persistence, notification integration |
| `src/pid-utils.ts` | PID liveness check, process-name verification, stale PID detection |
| `src/file-conflict.ts` | File-level conflict prevention: predicted file extraction, dependency expansion, overlap detection for parallel instances |
| `src/pipeline-compose.ts` | Adaptive pipeline composition: static lookup table mapping (effort, priority, hasDesignDoc) to minimal skill sequences, intersection with requestedSkills (unknown skills pass through) |
| `src/pipeline-history.ts` | Pipeline outcome history: JSONL I/O, skip-risk scoring with exponential decay, circuit breaker for Oracle composition, failure rate computation |
| `src/skill-catalog.ts` | Static skill registry with structured metadata (name, description, useWhen, produces, cost, mode), formatSkillCatalogForPrompt for oracle injection |
| `src/todo-state.ts` | TODO lifecycle state tracking: slugify, state I/O, Levenshtein fallback, artifact detection, reconciliation, pipeline skill trimming |
| `src/cli.ts` | `garyclaw run/resume/replay/research/oracle/daemon/dashboard`, multi-skill, daemon subcommands, `--name`/`--all`/`--cleanup` |

### Key Design Decisions

- **Agent SDK (Approach A)** — structured JSON, `canUseTool`, token tracking via `@anthropic-ai/claude-agent-sdk`
- **Fresh sessions for relay** (not resume) — resume carries compressed history consuming context. Fresh session + checkpoint prompt starts at ~17K tokens.
- **Per-turn monitoring with deferred relay** — check `AssistantMessage.message.usage` every turn, only act at segment boundary (never interrupt mid-tool-call)
- **Token formula:** `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` ≈ context size
- **Context window:** `modelUsage.contextWindow` = 1,000,000
- **Strip ANTHROPIC_API_KEY** from env so SDK uses Claude Max login (not API billing)
- **Git stash with `--include-untracked`** for relay — new files must be included
- **7 Decision Principles** — P7 "Local evidence trumps general knowledge" added in Phase 5a
- **Two-layer oracle memory** — global `~/.garyclaw/oracle-memory/` + per-project `.garyclaw/oracle-memory/`. decision-outcomes.md per-project only.
- **Circuit breaker** — accuracy < 60% with 10+ decisions disables memory injection + notifies
- **Prompt injection sanitization** — strip known patterns before memory injection into Oracle prompt
- **Parallel daemon instances** — each instance gets own subdir under `.garyclaw/daemons/{name}/`, shared global budget at `.garyclaw/global-budget.json`
- **Cross-instance dedup** — scans all instance `daemon-state.json` files before local dedup
- **Reflection lock** — `mkdir`-based advisory lock prevents concurrent reflection writes to oracle-memory
- **Git HEAD tracking in pipelines** — detects commits between skills and injects context into handoff prompt
- **Git worktree isolation** — named daemon instances get their own worktree + branch (`garyclaw/{name}`), default instance uses main repo directly
- **Fast-forward only merge** — on daemon stop, attempt `--ff-only` merge to base branch; if diverged, leave branch for manual merge
- **Auto-research trigger** — post-job keyword extraction from low-confidence decisions, topic grouping by 2+ shared keywords, freshness-aware dedup, gated behind `autoResearch.enabled` (default: false)
- **Adaptive maxTurns** — per-segment turn prediction from `computeGrowthRate()` + heavy tool lookahead, browse-heavy gets 3-8 turns, edit-heavy gets full max. User's `--max-turns` is ceiling. Fresh monitor per relay session naturally falls back to configured default. `HEAVY_TOOLS` (WebFetch/WebSearch/Screenshot) trigger 2.5x growth rate multiplier for next segment. `--no-adaptive` disables.
- **Pipeline resume after crash** — On daemon restart, `running` jobs re-queued with `retryCount` instead of marked failed. Jobs exceeding 2 retries abandoned. Multi-skill jobs with `pipeline.json` call `resumePipeline()` to skip completed skills. Single-skill jobs retry from scratch. `priorSkillCostUsd` tracks pre-crash spending for dashboard reporting. Recovery notification sent on resume.
- **Bootstrap quality gate** — After bootstrap in a pipeline, `analyzeBootstrapQuality()` checks score. If < `BOOTSTRAP_QUALITY_THRESHOLD` (50), runs QA pre-scan (maxRelaySessions:1) → `buildEnrichedBootstrapPrompt()` → re-bootstrap. Capped at 1 enrichment retry via `bootstrapEnriched` flag on PipelineState. Fail-open on scoring errors. Opt-out via `bootstrapQualityGate: false`. Dashboard tracks enrichment count + avg score delta.
- **Sleep-resilient cron poller** — `lastCheckedAt` scan on wake (floored to minute boundary), single-fire cap (latest match only), O(minutes-slept) per tick. Recovery logging: gaps > 2 min produce "Cron recovered after N min, M window(s) missed" detail for daemon log observability. Catches missed cron windows during macOS sleep. No persistence across daemon restarts (catch-up only for windows missed while poller was running). Clock backward jump is safe (empty scan range).
- **Oracle decision batching** — `askOracleBatch()` sends multiple questions in one API call via `buildBatchOraclePrompt()`. Single questions delegate to `askOracle()` (zero overhead). Batch response parsed as JSON array with fallback chain: array → individual JSON objects → fallback choices. Per-question escalation/taste detection applied post-parse. Ask-handler uses batching when `askOracleBatch` is provided AND `questions.length > 1`; otherwise serial fallback. Decision history snapshot prevents mutable reference bugs.
- **Oracle session reuse** — `createSdkOracleQueryFn()` is stateful: first call creates a fresh SDK session with full 43K prompt, subsequent calls resume with just the question (~700 tokens via `buildResumePrompt()`). `ORACLE_QUESTION_MARKER` shared constant prevents marker drift. `MAX_REUSE=25` resets session to bound context growth. Batch calls (`ORACLE_BATCH_MARKER`) bypass session reuse. Graceful fallback: resume failure → single cold-start retry. `OracleSessionEvent` callback for observability. Per-skill scope (orchestrator creates fresh queryFn per skill).
- **Adaptive pipeline composition** — `composePipeline()` in `pipeline-compose.ts` maps `(effort, priority, hasDesignDoc)` to minimal skill sequences via static lookup table. XS items → `implement + qa` ($0.50 vs $3-4). Intersection with `requestedSkills` ensures composition can only remove known skills (those in `FULL_PIPELINE`), never add. Unknown skills (gstack skills like `design-review`, `bootstrap`, etc.) pass through untouched. Wired into job-runner between pre-assignment and todo-state trimming. `pipeline_composed` event for observability. `composedFrom` on Job for dashboard tracking. Fail-open on errors.
- **Oracle-driven pipeline composition** — Prioritize prompt outputs `### Recommended Pipeline` section. `parsePipelineRecommendation()` in job-runner parses it. Cold-start gate: `countPipelineOutcomes()` requires 10+ pipeline outcome entries in decision-outcomes.md before oracle overrides static table. `buildPipelineOutcome()` in reflection writes human-readable outcome lines (success/acceptable/failure based on QA issue count). `compositionMethod` on Job tracks "static" vs "oracle". Learning loop: composition → QA outcome → reflection → decision-outcomes.md → next prioritize reads outcomes.
- **Daemon fleet command** — `daemon start --parallel N` creates `worker-1` through `worker-N` instances. Auto-cleanup via `runAutoCleanup()` extracted from doctor.ts runs before any fork (stale PIDs, orphaned worktrees, stuck locks, dead budget entries, orphaned TODO state). Budget pre-validation: `N * perJobCostLimitUsd` must fit within remaining daily budget. Staggered 1s delay between forks prevents git worktree race. PID file verification polls up to 3s per instance. IPC status enriched with `PipelineProgress` (current skill, skill index, claimed TODO, elapsed time, commit count). Commit count cached every 10s via async `getWorktreeCommitCount()`. Fleet table in `displayAllInstances()` queries running instances via parallel IPC with disk fallback for stopped instances. `--parallel` mutually exclusive with `--name`.
- **GitHub PR workflow** — `merge.strategy: "pr"` in DaemonConfig routes post-job merge to `createPullRequest()` in worktree.ts instead of `mergeWorktreeBranch()`. Pre-merge tests still run in worktree before pushing. Branch rebased onto baseBranch, pushed with `--force-with-lease`, PR created via `gh pr create` with structured body (pipeline summary, oracle decisions, test results, issues). `gh pr merge --auto --squash` enables GitHub auto-merge (best-effort — non-fatal if repo setting disabled). Falls back to direct merge when `gh` CLI unavailable. New TODO state `"pr-created"` between `qa-complete` and `merged`. PR body hard-capped at 60K chars (GitHub limit 65536). `notifyPrCreated()` sends macOS notification. Dashboard tracks PRs created via merge-audit.jsonl pattern matching. Config options: `prAutoMerge`, `prMergeMethod`, `prLabels`, `prReviewers`, `prDraft`. Named instances only (default instance has no branch to PR from).

---

## Orchestrator Loop

```
1. verifyAuth()
2. for sessionIndex in 0..maxRelaySessions:
3.   for segmentIndex in 0..∞:
3a.    adaptiveMaxTurns = computeAdaptiveMaxTurns(monitor, threshold, configuredMax)
4.     segment = startSegment(prompt, maxTurns=adaptiveMaxTurns, ...)
5.     for msg in segment:
6.       if assistant → recordTurnUsage → check shouldRelay → set flag
7.       if result → setContextWindow, recordCost
8.     if relay flag → writeCheckpoint → prepareRelay → break to new session
9.     if success → done
10.    if maxTurns → resume same session with "Continue."
11. buildReport() from accumulated checkpoints
```

---

## Test Strategy

All unit tests use synthetic data — **no SDK calls**. `sdk-wrapper.ts` is the isolation boundary.

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `test/token-monitor.test.ts` | 24 | recordTurnUsage, shouldRelay, growthRate, edge cases |
| `test/adaptive-turns.test.ts` | 28 | computeAdaptiveMaxTurns: fallback, growth prediction, heavy tools, clamping, relay, HEAVY_TOOLS constant, reason string contract |
| `test/checkpoint.test.ts` | 35 | write/read/rotation, relay prompt tiering, token budget, codebaseSummary validation + relay |
| `test/ask-handler.test.ts` | 29 | Multi-question, multi-select, decision audit log, timeout→deny, otherProposal, memory passing |
| `test/ask-handler-batch.test.ts` | 11 | Batch wiring: multi-question batching, decision log, escalation per-question, serial fallback, human mode unaffected |
| `test/ask-handler-batch.regression-1.test.ts` | 4 | Guard clause: batchResults length mismatch, fallback low-confidence escalation, empty array, escalated log |
| `test/ask-handler-batch.regression-2.test.ts` | 3 | onWarn threading: config.onWarn passed to askOracleBatch, undefined when absent, single-question bypass |
| `test/oracle.test.ts` | 38 | Oracle decisions, confidence, escalation, error handling, 7 principles, memory injection, Other |
| `test/oracle-prompt-prefix.test.ts` | 11 | buildOraclePromptPrefix: preamble, principles, memory injection, recent decisions, projectContext truncation |
| `test/oracle-batch.test.ts` | 32 | askOracleBatch: single delegation, multi-question batching, batch prompt, parseBatchOracleResponse, fallback chain, otherProposal |
| `test/oracle-batch-warn.test.ts` | 11 | parseBatchOracleResponse onWarn callback: happy path, 4 fallback paths, console.warn default, askOracleBatch threading |
| `test/oracle-session-reuse.test.ts` | 16 | buildResumePrompt, ORACLE_QUESTION_MARKER, ORACLE_BATCH_MARKER, MAX_REUSE, OracleSessionEvent, formatEvent oracle_session |
| `test/oracle-session-state.test.ts` | 20 | OracleSessionState: prepareCall, handleSuccess, handleError, batch reset, MAX_REUSE, resume fallback, cold-start error propagation |
| `test/oracle-session-state.regression-1.test.ts` | 5 | SessionAction union narrowing: handleError discriminants, non-Error wrapping, all 3 variants discriminable |
| `test/oracle-extended.test.ts` | 32 | Extended oracle edge cases, principle matching, response parsing |
| `test/sdk-wrapper.test.ts` | 17 | env stripping, usage extraction, result parsing |
| `test/sdk-wrapper-verifyauth.regression-1.test.ts` | 9 | verifyAuth error handling regression |
| `test/report.test.ts` | 13 | merge/dedup, markdown formatting |
| `test/relay.test.ts` | 9 | git stash/pop, relay segment construction |
| `test/relay-extended.test.ts` | 5 | relay edge cases, stash failure handling |
| `test/pipeline.test.ts` | 27 | state persistence, context handoff, pipeline report, validation |
| `test/pipeline-extended.test.ts` | 10 | pipeline edge cases, resume, error propagation |
| `test/pipeline-failure.test.ts` | 9 | pipeline failure modes, skill crash handling |
| `test/pipeline-compose.test.ts` | 59 | composePipeline: all effort/priority rules, intersection logic, edge cases, invariants, savings |
| `test/pipeline-compose-oracle.test.ts` | 22 | parsePipelineRecommendation: arrow variants, missing/malformed, whitespace, embedding; oracle override logic: intersection, threshold, compositionMethod |
| `test/pipeline-history.test.ts` | 51 | readPipelineOutcomes, appendPipelineOutcome, truncatePipelineOutcomes, MAX_PIPELINE_OUTCOMES cap, computeSkipRiskScores, shouldUseOracleComposition, computeFailureRates, decay weighting, circuit breaker, computeCategoryStats |
| `test/pipeline-compose-oracle.regression-1.test.ts` | 4 | Oracle override same-length different-skills: set-membership check, identical no-op, length diff, empty |
| `test/skill-catalog.test.ts` | 15 | SKILL_CATALOG: completeness, required fields, cost bounds, mode values, formatSkillCatalogForPrompt output |
| `test/pipeline-implement.test.ts` | 4 | implement dispatch, buildImplementPrompt integration |
| `test/bootstrap.test.ts` | 52 | walkFileTree, detectTechStack, filePriority, safeReadFile, findCiConfig, findTestDir, buildFileTreeString, truncateToTokenBudget, analyzeCodebase, buildBootstrapPrompt |
| `test/pipeline-bootstrap.test.ts` | 4 | bootstrap skill dispatch, idempotency, pipeline chaining |
| `test/pipeline-bootstrap-gate.test.ts` | 12 | Quality gate trigger, skip when score >= 50, enrichment flow, retry cap, event emission, fail-open, config flag |
| `test/bootstrap-enriched.test.ts` | 10 | buildEnrichedBootstrapPrompt: QA findings, missing CLAUDE.md, truncation, token budget |
| `test/dashboard-enrichment.test.ts` | 9 | Bootstrap enrichment stats: aggregation, formatting, zero/positive/negative delta |
| `test/evaluate.test.ts` | 72 | scoreTokenEfficiency, extractDependencies, computeFrameworkCoverage, detectSections, analyzeBootstrapQuality, analyzeOraclePerformance, analyzePipelineHealth, extractObviousImprovements, parseClaudeImprovements, deduplicateImprovements, formatEvaluationReport, formatDuration, formatImprovementCandidates, writeEvaluationReport, buildEvaluatePrompt |
| `test/evaluate.regression-1.test.ts` | 6 | buildEvaluatePrompt error boundary interface completeness |
| `test/evaluate.regression-2.test.ts` | 3 | buildEvaluatePrompt improvement-candidates.md prompt instruction |
| `test/evaluate.regression-3.test.ts` | 3 | analyzePipelineHealth duration fallback |
| `test/evaluate.regression-4.test.ts` | 4 | parseClaudeImprovements last-valid-match with zero qualifying items |
| `test/pipeline-evaluate.test.ts` | 6 | evaluate skill dispatch, previous skills context, standalone, events, full pipeline, callback wrapping |
| `test/pipeline-evaluate-wiring.test.ts` | 18 | createTextAccumulatingCallbacks, runPostEvaluateAnalysis, default evaluation helpers, last-valid-match relay split |
| `test/implement.test.ts` | 48 | findDesignDoc, loadDesignDoc, extractImplementationOrder, validateImplementationOrder, formatReviewContext, buildImplementPrompt |
| `test/implement-loaddesigndoc.regression-1.test.ts` | 7 | loadDesignDoc regression: absolute/relative paths, missing files |
| `test/issue-extractor.test.ts` | 38 | commit parsing, IssueTracker, extractAllToolUse, severity inference |
| `test/daemon-ipc.test.ts` | 10 | Request/response over socket, malformed input, timeout |
| `test/daemon-ipc.regression-1.test.ts` | 3 | IPC server connection safeguards: timeout constant, buffer cap constant, sane bounds |
| `test/notifier.test.ts` | 28 | Notification formatting, summary generation, graceful failure, instance labels |
| `test/job-runner.test.ts` | 48 | FIFO queue, dedup, budget, state persistence, job lifecycle, global budget, cross-instance dedup, adaptive_turns event collection |
| `test/job-runner-extended.test.ts` | 17 | Extended job runner: budget edge cases, concurrent enqueue |
| `test/job-runner.regression-2.test.ts` | 3 | Job runner regression: dedup with completed jobs |
| `test/job-runner.regression-3.test.ts` | 3 | Job runner regression: "adaptive disabled" reason classification |
| `test/job-runner-resume.test.ts` | 27 | Crash recovery: re-queue on restart, retry limit, pipeline resume wiring, single-skill retry, priorSkillCostUsd, notification, failure taxonomy, dashboard stats |
| `test/triggers.test.ts` | 66 | Git poll HEAD detection, debounce, interval, branch filtering, trigger patterns, log on null HEAD, self-commit filtering |
| `test/daemon.test.ts` | 55 | Config validation, PID lifecycle, IPC handler, logger, config fallback, instances request, autoResearch validation, merge config |
| `test/daemon-extended.test.ts` | 46 | Extended daemon: shutdown, poller lifecycle, IPC edge cases |
| `test/daemon-lifecycle.test.ts` | 14 | Daemon start/stop lifecycle, signal handling |
| `test/daemon-registry.test.ts` | 52 | Instance discovery, global budget, cross-instance dedup, migration, budget lock integration |
| `test/reflection-lock.test.ts` | 12 | Acquire/release, reentrant, stale recovery, timeout |
| `test/budget-lock.test.ts` | 12 | Acquire/release, reentrant, stale recovery, timeout |
| `test/safe-json.test.ts` | 21 | Atomic write/read, corruption recovery, .bak rename, validation |
| `test/safe-json-extended.test.ts` | 13 | Extended safe-json: concurrent writes, large files, encoding |
| `test/safe-json.regression-1.test.ts` | 5 | ENOENT retry on rename during parallel cold-start I/O |
| `test/oracle-memory.test.ts` | 47 | Two-layer resolution, sanitization, metrics, circuit breaker, outcomes |
| `test/reflection.test.ts` | 46 | Levenshtein, reopened detection, outcome mapping, reflection runner, sandboxing |
| `test/reflection-pipeline-outcome.test.ts` | 19 | buildPipelineOutcome: success/acceptable/failure, skipped skills, compositionMethod; countPipelineOutcomes: null/empty/positive/mixed |
| `test/reflection.regression-1.test.ts` | 4 | Reflection regression: edge cases in outcome mapping |
| `test/researcher.test.ts` | 35 | isTopicStale, parseDomainSections, mergeDomainSections, buildResearchPrompt, canUseTool, runResearch |
| `test/prioritize.test.ts` | 80 | parseTodoItems, loadOvernightGoal, loadOracleContext, formatPipelineContext, buildPrioritizePrompt, aggregateFailurePatterns, getDecisionQualityTrends, measureRecentImpact, per-category stats injection |
| `test/prioritize-review-findings.test.ts` | 11 | loadUnresolvedReviewFindings: flat/instance layouts, action keywords, skip filters, review skill gating, job dir limit, error handling |
| `test/worktree.test.ts` | 28 | createWorktree, removeWorktree, mergeWorktreeBranch, listWorktrees, getWorktreePath, resolveBaseBranch, stash/pop, rebase merge |
| `test/dashboard.test.ts` | 54 | aggregateJobStats, aggregateOracleStats, aggregateBudgetStats, aggregateAdaptiveTurnsStats, computeHealthScore, formatDashboard, buildDashboard, formatDuration |
| `test/auto-research.test.ts` | 33 | extractTopicKeywords, groupDecisionsByTopic, getResearchTopics, defaults |
| `test/codebase-summary.test.ts` | 51 | extractObservations, extractFailedApproaches, deduplicateObservations, truncateToTokenBudget, buildCodebaseSummary, formatCodebaseSummaryForRelay |
| `test/auto-research.regression-1.test.ts` | 19 | isTopicGroupFresh direct tests, seed-keyword clustering, 3-char acronym preservation |
| `test/job-runner-auto-research.regression-1.test.ts` | 13 | collectAllDecisions, auto-research integration: enqueue, budget block, pipeline subdirs |
| `test/orchestrator-research.regression-1.test.ts` | 8 | Research skill dispatch: events, errors, config passthrough, disambiguation |
| `test/doctor.test.ts` | 59 | 8 subsystem checks, --fix/--json flags, stale PID detection, lock recovery, orphaned TODO state, stale budget locks |
| `test/failure-taxonomy.test.ts` | 71 | 10 failure categories, table-driven classification, failures.jsonl, notification integration |
| `test/pid-utils.test.ts` | 20 | PID liveness check, process-name verification, stale detection |
| `test/orchestrator.test.ts` | 47 | auth, success, maxTurns, errors, abort, relay, adaptive turns, heavy tool tracking, --no-adaptive config, codebase summary extraction |
| `test/orchestrator-helpers.test.ts` | 38 | orchestrator helper functions, prompt building |
| `test/orchestrator-helpers.regression-1.test.ts` | 6 | orchestrator helpers regression |
| `test/orchestrator.regression-1.test.ts` | 4 | Multi-tool heavy detection: non-first block, middle position, no false positive |
| `test/cli.test.ts` | 88 | CLI arg parsing, subcommands, daemon commands, --name/--all, --no-adaptive, adaptive_turns event, pipeline_oracle_adjustment event |
| `test/cli-main.test.ts` | 25 | CLI main entry point, error handling |
| `test/cli.regression-1.test.ts` | 2 | CLI regression: edge cases in arg parsing |
| `test/cli-evaluate-hook.regression-1.test.ts` | 7 | CLI evaluate hook: append candidates, skip same project, skip missing, error handling |
| `test/checkpoint.regression-1.test.ts` | 5 | Checkpoint regression: edge cases in relay prompt generation |
| `test/oracle.regression-1.test.ts` | 9 | Oracle regression: edge cases in decision parsing |
| `test/oracle.regression-3.test.ts` | 7 | Oracle regression: extractOracleFields DRY helper |
| `test/oracle-memory.regression-1.test.ts` | 8 | Oracle memory regression: layer resolution edge cases |
| `test/oracle-memory.regression-2.test.ts` | 4 | Oracle memory regression: sanitization edge cases |
| `test/oracle-memory.regression-3.test.ts` | 6 | Oracle memory regression: metrics edge cases |
| `test/codebase-summary.regression-1.test.ts` | 16 | Codebase summary regression: observation extraction edge cases |
| `test/codebase-summary.regression-2.test.ts` | 4 | Codebase summary regression: dedup edge cases |
| `test/codebase-summary.regression-3.test.ts` | 6 | Codebase summary regression: token budget edge cases |
| `test/worktree.regression-1.test.ts` | 16 | Worktree regression: branch and path resolution edge cases |
| `test/worktree.regression-2.test.ts` | 10 | Worktree regression: merge and cleanup edge cases |
| `test/dashboard.regression-1.test.ts` | 13 | Dashboard regression: health score edge cases |
| `test/dashboard.regression-2.test.ts` | 3 | Dashboard regression: budget config edge cases |
| `test/auto-research.regression-2.test.ts` | 14 | Auto-research regression: freshness and clustering edge cases |
| `test/pid-utils.regression-1.test.ts` | 13 | PID utils regression: process-name verification edge cases |
| `test/step-tracking.test.ts` | 45 | Step tracking: progress tracking, step lifecycle, event emission |
| `test/step-tracking.regression-1.test.ts` | 13 | Step tracking regression: edge cases in step state transitions |
| `test/qa-regressions.regression-1.test.ts` | 9 | QA regression: issue extraction edge cases |
| `test/qa-regressions.regression-2.test.ts` | 10 | QA regression: report formatting edge cases |
| `test/bootstrap.regression-1.test.ts` | 14 | Bootstrap regression: walkFileTree permission errors, detectTechStack edge cases, safeReadFile edge cases, budget edge cases |
| `test/file-conflict.test.ts` | 30 | extractPredictedFiles, expandWithDependencies, hasFileOverlap, DEFAULT_FILE_DEPS validation |
| `test/daemon-registry-file-conflict.test.ts` | 7 | getClaimedFiles: cross-instance scanning, self-exclusion, status filtering, aggregation |
| `test/job-runner-file-conflict.test.ts` | 8 | File conflict integration: skip conflicting items, fall-through, fail-open, custom dep map, idle on all blocked |
| `test/todo-state.test.ts` | 66 | slugify, state I/O, Levenshtein fallback, artifact detection, reconciliation truth table, getStartSkill, findNextSkill, skillToTodoState |
| `test/todo-state-automark.test.ts` | 12 | markTodoCompleteInFile: heading match, strikethrough, case sensitivity, no-match safety |
| `test/types-warn.test.ts` | 3 | resolveWarnFn: callback passthrough, console.warn fallback, undefined handling |
| `test/job-runner-todo-state.test.ts` | 10 | TODO state integration: skip complete, trim pipeline, design doc passthrough, fail-open, single-skill bypass |
| `test/job-runner-todo-state.regression-2.test.ts` | 5 | Default instance qa-complete → complete promotion, no-promote for merged, auto-mark TODOS.md, worktree guard, fail-open |
| `test/job-runner-todo-state.regression-3.test.ts` | 3 | pr-created auto-mark guard: no TODOS.md mark for pr-created, state preserved, merged still marks |
| `test/auto-research.regression-3.test.ts` | 7 | Auto-research regression: extractTopicKeywords numeric-only token filtering |
| `test/cli-todo-flag.test.ts` | 6 | parseArgs --todo flag: daemon trigger passthrough, position variants, --name combo, undefined when absent |
| `test/cli.regression-2.test.ts` | 5 | CLI regression: formatEvent missing bootstrap_quality_check/recheck cases |
| `test/cli.regression-3.test.ts` | 3 | CLI regression: formatEvent pipeline_oracle_adjustment kept_skipped variant |
| `test/daemon-ipc-todo.test.ts` | 4 | buildIPCHandler todoTitle passthrough: skipComposition, claimedTodoTitle, designDoc combo, absent |
| `test/daemon-merge-config.test.ts` | 31 | Daemon merge config validation |
| `test/daemon-registry-file-conflict.regression-1.test.ts` | 2 | Daemon registry regression: getClaimedFiles duplicate file entries per instance |
| `test/daemon-registry.regression-1.test.ts` | 8 | Daemon registry regression: getClaimedTodoTitles cross-instance coordination |
| `test/daemon-registry.regression-2.test.ts` | 7 | Daemon registry regression: getCompletedTodoTitles todo-state/ directory scan |
| `test/daemon-registry-rate-limit.test.ts` | 5 | Cross-instance rate limit coordination: setGlobalRateLimitHold, readGlobalBudget |
| `test/daemon-registry-rate-limit.regression-1.test.ts` | 3 | clearGlobalRateLimitHold: clear expired hold, no-op, preserve byInstance |
| `test/dashboard-merge.test.ts` | 18 | Dashboard merge health: aggregation, health score reweighting |
| `test/dashboard.regression-3.test.ts` | 4 | Dashboard regression: formatDashboard crash recovery row format |
| `test/dashboard.regression-4.test.ts` | 4 | Dashboard regression: computeHealthScore/formatDashboard crash on undefined mergeHealth |
| `test/dashboard-composition.test.ts` | 10 | aggregateCompositionStats: zero jobs, single composed, multiple composed, avg calculation, savings math |
| `test/dashboard-composition-intelligence.test.ts` | 9 | aggregateCompositionIntelligence: oracle active/tripped, skip-risk scores, failure rates, empty outcomes |
| `test/dashboard-rate-limit.test.ts` | 5 | Dashboard rate limit display: rate_limited job aggregation, formatting |
| `test/dashboard-post-merge.test.ts` | 11 | Dashboard post-merge: revert aggregation, health score reweighting with reverts, revert rate formatting |
| `test/doctor.regression-1.test.ts` | 10 | Doctor regression: checkOrphanedTodoState coverage |
| `test/doctor-injection.test.ts` | 11 | Doctor injection: hasInjectionPatterns via checkOracleMemory, all 8 patterns, false positives, corrupt metrics, circuit breaker, --fix |
| `test/evaluate-claims.test.ts` | 26 | Claim verification: extractClaudeMdClaims, verifyClaudeMdClaims |
| `test/evaluate-claims.regression-1.test.ts` | 5 | Evaluate claims regression: double-counting, no-claims fallback, P1-P5 mismatch |
| `test/evaluate-claims.regression-2.test.ts` | 13 | Evaluate claims regression: per-feature test-count verification, PostgreSQL indirect deps via Supabase/Prisma/Drizzle, NihontoWatch fixture integration |
| `test/evaluate-semantic-validation.test.ts` | 43 | Semantic bootstrap validation: extractCommandClaims, extractTestDirectoryClaims, command + test_directory claim verification |
| `test/evaluate.regression-5.test.ts` | 4 | Evaluate regression: stale improvement-candidates.md duplicate TODOs |
| `test/job-runner-auto-mark.test.ts` | 9 | Job runner auto-mark: catchUpCompletedTodos marks TODOS.md headings for merged items |
| `test/job-runner-cross-cycle-dedup.test.ts` | 4 | Job runner cross-cycle dedup: pre-assignment skips completed TODOs |
| `test/job-runner-merge.test.ts` | 10 | Job runner merge integration: auto-merge with validation config |
| `test/job-runner-rate-limit.test.ts` | 17 | Job runner rate limit: isRateLimitError detection, parseRateLimitResetTime parsing, RATE_LIMIT_FALLBACK_MS |
| `test/job-runner-rate-limit-wiring.test.ts` | 11 | Rate limit wiring: time-gate in processNext, error handler detection, rate_limited dedup, cross-instance coordination |
| `test/job-runner-rate-limit.regression-1.test.ts` | 1 | Job runner rate limit regression: costUsd reset on re-queue after hold expiry |
| `test/job-runner-resume.regression-1.test.ts` | 2 | Job runner resume regression: abandoned job FailureRecord retryable flag |
| `test/job-runner-resume.regression-2.test.ts` | 2 | Job runner resume regression: rate_limited crash recovery, costUsd reset |
| `test/job-runner-auth-hold.test.ts` | 10 | Auth failure hold: rate_limited on auth error, 30-min fallback, global budget propagation, MIN_COST_FOR_REENQUEUE spin loop prevention |
| `test/job-runner.regression-4.test.ts` | 7 | Job runner regression: parsePriorityPickTitle edge cases |
| `test/job-runner.regression-5.test.ts` | 4 | Job runner regression: backward compat missing config.merge |
| `test/job-runner-skip-composition.test.ts` | 3 | skipComposition bypass: flag preservation, original skills retention, composedFrom not set |
| `test/job-runner.regression-6.test.ts` | 2 | Job runner regression: 'continuous' trigger source validity on Job.triggeredBy |
| `test/job-runner.regression-7.test.ts` | 2 | Job runner regression: 'daemon-crash' must be valid FailureCategory |
| `test/job-runner.regression-8.test.ts` | 2 | Job runner regression: readTodoState import resolves and round-trips state |
| `test/job-runner-task-category.test.ts` | 35 | parseTaskCategory, parseEffort, parsePriority, VALID_TASK_CATEGORIES, VALID_EFFORTS edge cases |
| `test/job-runner-continuous-requeue.regression-1.test.ts` | 3 | Continuous re-enqueue uses composedFrom original skills, not trimmed set |
| `test/job-runner-post-merge.regression-1.test.ts` | 3 | Post-merge verification regression: git rev-parse failure, HEAD re-read failure, bug TODO markdown format |
| `test/job-runner-post-merge.regression-2.test.ts` | 3 | Post-merge verification regression: branchName() sanitization in bug TODO body |
| `test/job-runner-post-merge.test.ts` | 12 | Post-merge verification: verifyPostMerge wiring, smart skip, force override, revert flow, HEAD-moved, default instance skip, error swallowing |
| `test/job-runner-preassign.regression-1.test.ts` | 3 | Job runner pre-assignment regression: strikethrough TDZ, state file filtering |
| `test/merge-audit.test.ts` | 11 | Merge audit log: append, read, truncation, JSONL format |
| `test/notifier.regression-1.test.ts` | 5 | Notifier regression: notifyJobResumed message format with notifications enabled |
| `test/notifier.regression-2.test.ts` | 7 | Notifier regression: notifyMergeBlocked formatting, gating, instance labels |
| `test/notifier.regression-3.test.ts` | 7 | Notifier regression: notifyRateLimitHold/Resume formatting, gating, instance labels |
| `test/notifier-rate-limit.test.ts` | 8 | Rate limit notification tests: hold/resume formatting, gating, sendNotification mock |
| `test/notifier-post-merge.test.ts` | 8 | Notifier post-merge: notifyMergeReverted formatting, gating, instance labels, long SHA slicing |
| `test/oracle.regression-2.test.ts` | 3 | Oracle regression: createSdkOracleQueryFn type cast fix |
| `test/pipeline-evaluate-wiring.regression-1.test.ts` | 4 | Pipeline evaluate wiring regression: runPostEvaluateAnalysis crash safety |
| `test/pipeline-todo-state.regression-1.test.ts` | 6 | Pipeline regression: writeTodoState wiring after skill completion |
| `test/triggers-self-commit.test.ts` | 14 | Self-commit filtering: git poller skips daemon-generated commits |
| `test/triggers-self-commit.regression-1.test.ts` | 5 | Triggers regression: getCommitEmails >100 cap returns empty |
| `test/worktree-stash-merge.test.ts` | 7 | Worktree stash-merge: stash/pop around merge for dirty working trees |
| `test/worktree-validation.test.ts` | 13 | Worktree validation gate: test gate pass/fail/timeout, skip flag |
| `test/worktree-validation.regression-1.test.ts` | 5 | Worktree validation regression: stdout+stderr capture, dynamic lock timeout |
| `test/worktree-warn.test.ts` | 5 | Worktree warn routing: listWorktrees onWarn, mergeWorktreeBranch stash pop onWarn |
| `test/worktree.regression-3.test.ts` | 8 | Worktree regression: merge lock acquire/release edge cases |
| `test/worktree-post-merge.test.ts` | 14 | verifyPostMerge integration: pass/revert/HEAD-moved, test output capture, truncation, revert SHA, conflict handling |
| `test/doctor-auto-cleanup.test.ts` | 9 | runAutoCleanup: stale PIDs, locks, budget, TODO state, running guard, fail-open |
| `test/cli-parallel.test.ts` | 11 | `--parallel N` flag parsing: valid N, out of range, mutually exclusive with --name, worker naming |
| `test/daemon-ipc-progress.test.ts` | 10 | pipelineProgress in IPC status, getWorktreeCommitCount, backward compat, fallback |
| `test/cli-fleet-display.test.ts` | 15 | Fleet table formatting, PipelineProgress interface, formatUptime, truncation, formatElapsed, CLI commands, IPC fallback |
| `test/cli-fleet-display.regression-1.test.ts` | 4 | Fleet display column-safe color injection: status word in instance name, TODO title, multiple columns |
| `test/cli-fleet-display.regression-2.test.ts` | 6 | Fleet display skill column truncation: long skill names, padEnd alignment, short names unchanged |
| `test/daemon-ipc-progress.regression-1.test.ts` | 3 | Commit count cache timestamp ordering, getWorktreeCommitCount edge cases |
| `test/cli-parallel.regression-1.test.ts` | 3 | --parallel + --name mutual exclusivity: both specified, parallel-only, name-only |
| `test/cli-parallel-instances.test.ts` | 9 | startParallelInstances: N-launch, budget insufficient, missing config, skip running, fork failure, cleanup ordering, exact budget, config fallback, mixed fleet |
| `test/job-runner-pr.test.ts` | 10 | PR strategy routing, PR creation, TODO state advancement to pr-created, fallback to direct merge, notification |
| `test/job-runner-pr.regression-1.test.ts` | 4 | PR fallback post-merge verification, rebase conflict failure record, smart-skip bypass |
| `test/todo-state-pr.test.ts` | 4 | TODO state pr-created lifecycle: position between qa-complete and merged, getStartSkill skip |
| `test/worktree-pr.test.ts` | 26 | createPullRequest via mocked gh, buildPrBody formatting, truncation, isGhAvailable, malformed URL guard, edge cases |
| `test/dashboard-pr-stats.test.ts` | 7 | Dashboard PR stats: aggregation and formatting of PR-created merge audit entries |

---

## Phased Roadmap

### Phase 1a: Core Relay — COMPLETE
SDK harness, token tracking, checkpoint/relay, report generation. Solves context exhaustion.

### Phase 1b: AskUserQuestion UX Polish — COMPLETE
Multi-question/multi-select handling, "Other" free text, ANSI-colored CLI, live progress feed (assistant text + tool calls), decision audit log (`.garyclaw/decisions.jsonl`), cost tracking display.

### Phase 2: Decision Oracle — COMPLETE
Auto-decisions via `--autonomous` mode using 6 Decision Principles. Confidence scoring (1-10), security/destructive escalation, `garyclaw replay` command, escalated.jsonl audit trail.

### Phase 3: Skill Chaining — COMPLETE
`garyclaw run /qa /design-review /ship` — sequential pipeline with context passing. Pipeline state in `.garyclaw/pipeline.json`, per-skill checkpoints in subdirectories, context handoff with issues/findings/decisions summary, pipeline resume from last completed skill.

### Structured Issue Extraction — COMPLETE
Hybrid extraction from SDK message stream (git commit tool_use blocks) + post-hoc git log verification. `IssueTracker` class, `parseCommitMessage()`, severity inference, file path association. Real-time `issue_extracted` events in CLI. See `docs/designs/structured-issue-extraction.md`.

### Phase 4a: Daemon Mode MVP — COMPLETE
Persistent background daemon: `garyclaw daemon start/stop/status/trigger/log`. FIFO job queue with budget enforcement and dedup. Git poll trigger with HEAD change detection and debounce. macOS notifications via osascript. Unix domain socket IPC. Job state persistence in `.garyclaw/daemon-state.json`. Always autonomous mode. See `src/daemon.ts`.

### Phase 5a: Oracle Memory Infrastructure — COMPLETE
Two-layer memory (global + per-project), `safe-json.ts` shared I/O, `oracle-memory.ts` read/write with budget enforcement, 7th Decision Principle ("Local evidence trumps general knowledge"), oracle prompt memory injection, `otherProposal` response parsing, `--no-memory` CLI flag, `garyclaw oracle init` command, circuit breaker (accuracy < 60% disables memory), prompt injection sanitization.

### Phase 5b: Post-Job Reflection + Quality Tracking — COMPLETE
`src/reflection.ts` — post-job reflection runner, Levenshtein-based reopened issue detection (normalized distance < 0.3), decision outcome mapping (fixed→success, skipped→neutral, reopened→failure), rolling decision-outcomes.md, metrics accumulation, sandboxed canUseTool for Write-only to oracle-memory dirs, path traversal prevention. Wired into orchestrator post-completion (autonomous + memory enabled).

### Phase 5c: Domain Expertise Research — COMPLETE
`src/researcher.ts` — domain expertise research via web search, freshness tracking (14-day default window), structured output with YAML frontmatter per topic, `parseDomainSections`/`mergeDomainSections` for section management, token budget enforcement (oldest topics dropped), read-only `canUseTool` (WebSearch/WebFetch/Read only), graceful degradation when WebSearch unavailable, `garyclaw research <topic> [--force]` CLI command.

### Phase 6: Parallel Daemon Instances — COMPLETE
Multiple daemon instances running in parallel on the same project. Each instance gets own subdirectory under `.garyclaw/daemons/{name}/` with isolated PID, socket, log, and state files. Shared global budget at `.garyclaw/global-budget.json` with per-instance attribution. Cross-instance dedup prevents duplicate jobs across instances. Advisory reflection lock (mkdir-based) prevents concurrent oracle-memory corruption. Pipeline git HEAD tracking detects commits between skills. CLI gains `--name`, `--all`, and `daemon list`. Backward-compatible migration from flat layout. See `src/daemon-registry.ts`.

### Git Worktree Isolation — COMPLETE
Each named daemon instance operates in its own git worktree with a dedicated branch (`garyclaw/{name}`). Default instance uses the main repo directly (backward-compatible). On daemon stop, fast-forward merge attempted; if diverged, branch left for manual merge. `--cleanup` flag removes worktree + branch. `daemon list` shows worktree paths. See `src/worktree.ts`.

### Auto-Research Trigger — COMPLETE
Post-job analysis of low-confidence Oracle decisions. Keyword extraction from decision questions, topic grouping by 2+ shared keywords, freshness-aware filtering against domain-expertise.md. When 3+ low-confidence decisions cluster around a topic, auto-enqueue a research job. Gated behind `autoResearch.enabled` config flag (default: false). Research jobs go through normal FIFO queue with budget/dedup. See `src/auto-research.ts`.

### Dogfood Bootstrap — COMPLETE
`src/bootstrap.ts` — cold-start bootstrap skill for external repos. `analyzeCodebase()` gathers file listings and key file contents within a 50K token budget using a tiered strategy (config files → README → file tree → sampled source). `buildBootstrapPrompt()` assembles the analysis into a prompt with idempotency gates (skips CLAUDE.md/TODOS.md generation if files already exist). Integrated into pipeline.ts for `garyclaw run bootstrap prioritize implement qa --autonomous --project-dir <target>`.

### Phase 4b: Scheduling (DEFERRED)
Cron triggers, config hot-reload via SIGHUP.

### Phase 4c: Hardening (DEFERRED)
Log rotation, job cancellation, AbortSignal in orchestrator, stale PID cleanup.

---

## Authentication

Strip `ANTHROPIC_API_KEY` from env passed to SDK — uses Claude Max login instead. Setup: just be logged into `claude` CLI.

---

## Tech Stack

- **Runtime:** Node.js / TypeScript (ESM)
- **Core dependency:** `@anthropic-ai/claude-agent-sdk` 0.2.83
- **Tests:** Vitest
- **Dev:** tsx (TypeScript execution)

---

## Spike Results (2026-03-25)

All 5 spikes passed — see `src/spikes/` for runnable proof-of-concept scripts.

1. **canUseTool:** AskUserQuestion interception via `updatedInput` with pre-filled answers works
2. **Token tracking:** Per-turn usage on `AssistantMessage.message.usage`. `modelUsage.contextWindow` = 1,000,000
3. **Env passthrough:** Custom env vars + `$B` browse binary pass through to spawned sessions
4. **Relay prompt size:** 30-issue relay = ~1,880 tokens (19% of 10K budget)
5. **Oracle session reuse:** Stateful queryFn with SDK resume, `buildResumePrompt` strips 43K prefix, MAX_REUSE=25 reset

---

## Name Origin

Gary (Garry Tan, gstack creator) + Claw (grip/control mechanism). GaryClaw grabs the terminal and doesn't let go.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
