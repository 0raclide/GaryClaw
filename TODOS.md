# TODOS

## P2: Daemon Hardening (Phase 4b)

**What:** Remaining hardening for the daemon: log rotation (size-based, 10MB threshold), job state pruning (retainDays, max 10 per cycle), stale PID cleanup on startup.

**Why:** Phase 4a daemon MVP is complete and working — runs jobs, enforces budgets, sends notifications. But log files grow unbounded, completed job state accumulates, and stale PID files from crashes aren't cleaned up.

**Pros:** Production-readiness for long-running daemon instances.

**Cons:** Low urgency — the daemon works fine for short sessions. Only matters for always-on deployment.

**Context:** Phase 4a completed 2026-03-25 (daemon lifecycle, IPC, job queue, git poll, notifications). Hardening fixes completed 2026-03-26 (shell injection, AbortSignal, per-job cost enforcement, checkpoint quadratic fix, orchestrator tests, eng review follow-ups). Cron scheduling deferred indefinitely — `/loop` is sufficient.

**Effort:** S (human: ~3 days / CC: ~30 min)
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
**Depends on:** Phase 5b (quality metrics), Phase 4b (cron baseline)
**Added by:** /plan-ceo-review on 2026-03-26

## P3: Oracle Decision Batching (Latency Optimization)

**What:** Batch nearby Oracle decisions into a single API call when multiple AskUserQuestions fire within the same segment. Currently each decision is a separate 40K-token API call (~2-5s). Batching could reduce total Oracle latency by 50-70%.

**Why:** At 20 decisions per job × 2-5s each = 40-100 seconds of serial Oracle overhead. Currently ~3-5% of typical job time. Acceptable now but worth optimizing as job frequency increases with daemon mode.

**Pros:** Faster jobs. Lower Oracle cost per decision. Smoother daemon throughput.

**Cons:** Batching changes the decision-by-decision audit trail. Requires buffering AskUserQuestions and responding in bulk, which may not work if later questions depend on earlier answers.

**Context:** Identified by outside voice during CEO review (2026-03-26). The latency is documented but not addressed in the current plan. Future optimization after the Oracle memory system is validated.

**Effort:** S (human: ~3 days / CC: ~30 min)
**Depends on:** Phase 5a (memory Oracle working)
**Added by:** /plan-ceo-review on 2026-03-26
