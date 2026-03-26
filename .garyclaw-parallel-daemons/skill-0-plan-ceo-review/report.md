# GaryClaw Run Report — plan-ceo-review

**Run ID:** garyclaw-1774483347823-1ba37d
**Start:** 2026-03-26T00:02:27.823Z
**End:** 2026-03-26T00:34:57.889Z
**Sessions:** 1 | **Turns:** 203 | **Cost:** $2.367

## Issues Summary

| Status | Count |
|--------|-------|
| Open | 0 |
| Fixed | 0 |
| Skipped/Deferred | 0 |
| **Total** | **0** |

## Decisions (32)

- **Q:** GaryClaw on main branch. You have three pieces of work in flight: Phase 4b (cron scheduling), the Creative Oracle design (memory-backed decisions), and Parallel Daemons (multi-instance support). What should this CEO review focus on? If you pick a single design, I'll deep-dive it. If you pick 'all three,' I'll review them as a unified roadmap.
  **A:** All three as roadmap (Recommended) (confidence: 9/10) [Choose completeness]
- **Q:** Three ways to sequence this work. Think of it like building a race car: Approach A builds the engine first (scheduling + parallelism = infrastructure), Approach B builds the brain first (Oracle memory = intelligence), Approach C builds everything together as one integrated system. Which approach fits your priorities?
  **A:** B) Brain-First (Recommended) (confidence: 8/10) [Choose completeness]
- **Q:** GaryClaw on main, reviewing the 3-phase roadmap (Oracle → Scheduling → Parallel). What review posture do you want? You already have detailed draft designs — this is about whether to push scope further or lock in what you have.

RECOMMENDATION: Choose SELECTIVE EXPANSION — the drafts are solid, but I spotted expansion opportunities worth surfacing (cross-project memory, Oracle self-improvement, taste inference). You cherry-pick what's worth adding. Completeness: EXPANSION=9/10, SELECTIVE=8/10, HOLD=7/10, REDUCTION=5/10.
  **A:** SELECTIVE EXPANSION (Recommended) (confidence: 9/10) [Choose completeness]
- **Q:** EXPANSION 1: Cross-project memory sharing. Right now, the Creative Oracle's memory lives in `.garyclaw/oracle-memory/` per project. But domain expertise about 'autonomous agent architectures' learned in GaryClaw would be valuable in other agent projects. This would add a global `~/.garyclaw/oracle-memory/` layer that any project can read, with per-project overrides. 

Effort: S (human: ~3 days / CC: ~30 min). Risk: Low — additive, no breaking changes. Already called out as Open Question #1 in the Creative Oracle design.
  **A:** A) Add to scope (confidence: 9/10) [Choose completeness]
- **Q:** EXPANSION 2: Taste inference from decision patterns. The Oracle observes your decisions over time — after 50+ decisions, it notices patterns like 'you consistently choose the explicit approach over the clever one' or 'you always pick the complete option.' It suggests updates to taste.md: 'I noticed you prefer X over Y — should I add this to your taste profile?' You approve or reject each suggestion.

This is Open Question #2 in the Creative Oracle design. The risk noted there is 'Oracle gaming its own preferences' — but with human approval on every taste update, that risk is mitigated.

Effort: S (human: ~3 days / CC: ~30 min). Risk: Low — suggestions are human-gated, never auto-applied.
  **A:** A) Add to scope (confidence: 9/10) [Boil lakes]
- **Q:** EXPANSION 3: Decision quality tracking. After each job, compare Oracle decisions against outcomes — did the chosen approach actually work? Track a rolling 'decision accuracy' metric: decisions that led to successful fixes vs. ones that needed revision. Display in `daemon status` and notification summaries. Over time, this gives you a trust score for the Oracle.

This is the missing feedback loop — reflection (5b) updates memory, but nothing measures whether the memory is actually making decisions *better*.

Effort: S (human: ~2 days / CC: ~20 min). Risk: Low — read-only metrics, no behavior changes.
  **A:** A) Add to scope (confidence: 8/10) [Boil lakes]
- **Q:** EXPANSION 4: Memory-informed scheduling. Once the Oracle has memory, it can suggest *when* to run skills. Example: 'QA finds 3x more bugs after large commits — I should trigger QA after commits touching 5+ files, not on every push.' The daemon learns optimal trigger patterns from job outcomes rather than relying on static cron rules.

This would make Phase 4b's cron triggers a fallback rather than the primary scheduling mechanism.

Effort: M (human: ~1 week / CC: ~1 hour). Risk: Medium — requires enough job history to learn from, cold-start problem.
  **A:** B) Defer to TODOS.md (confidence: 8/10) [Pragmatic]
- **Q:** EXPANSION 5: Memory conflict resolution protocol. Open Question #4 in the Creative Oracle design: when domain expertise says 'X is SOTA' but decision-outcomes shows 'X failed for us,' which wins? Rather than leaving this ambiguous, codify it as a 7th Decision Principle: 'Local evidence trumps general knowledge — if we tried X and it failed, prefer alternatives even if X is theoretically SOTA.'

This resolves the ambiguity before it causes a bad decision at 2am.

Effort: XS (human: ~2 hours / CC: ~10 min). Risk: None — it's a principle addition, not a code change.
  **A:** A) Add to scope (confidence: 9/10) [Boil lakes]
- **Q:** EXPANSION 6: Research freshness policy. Open Question #3 in the Creative Oracle design: how often should domain-expertise.md be refreshed? Rather than leaving it vague, codify a staleness check: domain-expertise.md has a `last_researched` timestamp. If older than 14 days AND the Oracle encounters a low-confidence decision in that domain, trigger an automatic refresh before the next job. Otherwise, manual via `garyclaw research <topic>`.

This prevents both 'stale knowledge' and 'unnecessary re-research.'

Effort: XS (human: ~2 hours / CC: ~10 min). Risk: None — simple timestamp check.
  **A:** A) Add to scope (confidence: 9/10) [Boil lakes]
- **Q:** GAP 1: If memory files have permission errors (EACCES) or disk is full (ENOSPC), the Oracle and Reflection will crash with unhandled exceptions. These are rare but real in daemon mode (long-running process, disk fills up overnight). The fix is a try/catch around all file I/O in oracle-memory.ts that degrades gracefully: log the error, continue without memory.

RECOMMENDATION: Choose A — this is a daemon running unattended at 2am. Silent crashes are the #1 thing to prevent. 5 lines of try/catch. Completeness: A=9/10, B=4/10.
  **A:** A) Fix in plan (Recommended) (confidence: 9/10) [Choose completeness]
- **Q:** GAP 2: If a cron expression in daemon.json is invalid (e.g., `"*/5 * * * * *"` with 6 fields or `"bad"` string), CronTrigger will throw a parse error at daemon startup, killing the entire daemon — including valid git poll triggers that were working fine.

RECOMMENDATION: Choose A — one bad cron expression shouldn't take down the whole daemon. Validate at config load time, skip invalid triggers with a warning. Completeness: A=9/10, B=5/10.
  **A:** A) Validate + skip (Recommended) (confidence: 9/10) [Choose completeness]
- **Q:** SECURITY: Prompt injection via memory files. The reflection step writes to decision-outcomes.md based on job output. If a malicious repo tricks a skill into producing output containing prompt injection payloads, those payloads persist in memory and get injected into every future Oracle call. Similarly, domain-expertise.md is synthesized from web search results which could contain adversarial content.

This is a real but low-likelihood attack vector — the attacker would need to control either the repo being analyzed or the web search results.

RECOMMENDATION: Choose A — simple sanitization of memory file content before injection into the Oracle prompt. Strip known prompt injection patterns (e.g., 'ignore previous instructions'). Low effort, meaningful defense-in-depth. Completeness: A=8/10, B=6/10.
  **A:** A) Add sanitization (Recommended) (confidence: 7/10) [Choose completeness]
- **Q:** Two minor edge cases in the cross-instance and config reload flows:

1. If a daemon instance crashes and leaves behind a corrupt `daemon-state.json`, `isSkillSetActive()` will throw when scanning that file — blocking dedup checks for all instances.

2. If `daemon.json` is corrupt when SIGHUP triggers a config reload, the daemon should keep the old config rather than crashing.

Both fixes are trivial try/catch patterns. No real alternatives here — I'll add both to the plan as error handling requirements.

RECOMMENDATION: Acknowledge and move on — these are obvious fixes, not decisions.
  **A:** Acknowledged (Recommended) (confidence: 10/10) [Choose completeness]
- **Q:** DRY VIOLATION: The corruption recovery pattern (read JSON → parse fails → rename to .bak → try rotation) exists in `checkpoint.ts` and will be duplicated in `oracle-memory.ts`. Both modules need atomic write + corrupt recovery + rotation.

Extract a shared `src/safe-json.ts` utility with `safeReadJSON()` and `safeWriteJSON()` that both modules import. ~30 lines, eliminates the duplication.

RECOMMENDATION: Choose A — DRY is a stated engineering preference. Two copies of the same file corruption logic will drift. Completeness: A=9/10, B=5/10.
  **A:** A) Extract shared utility (Recommended) (confidence: 9/10) [DRY]
- **Q:** Two observability gaps in the Oracle memory system:

1. If the Oracle falls back to no-memory mode (file corrupt, permissions error), nobody is notified. The daemon logs it, but logs aren't actively monitored. A macOS notification would surface this immediately.

2. `daemon status` should show Oracle health: memory file ages, decision accuracy score, last reflection timestamp. Without this, you can't tell if the Oracle is learning or stale.

Both are small additions to existing notification and status infrastructure.

RECOMMENDATION: Choose A — the whole point of the Creative Oracle is that it gets smarter. If it silently degrades to stateless mode, you lose the value without knowing it. Completeness: A=9/10, B=6/10.
  **A:** A) Add both (Recommended) (confidence: 9/10) [Choose completeness]
- **Q:** All review sections are complete. Want an outside voice? A different AI system can give a brutally honest, independent challenge of this plan — logical gaps, feasibility risks, and blind spots that are hard to catch from inside the review. Takes about 2 minutes.

RECOMMENDATION: Choose A — an independent second opinion catches structural blind spots. Two different AI models agreeing on a plan is stronger signal than one model's thorough review. Completeness: A=9/10, B=7/10.
  **A:** A) Get the outside voice (Recommended) (confidence: 8/10) [Choose completeness]
- **Q:** CROSS-MODEL TENSION 1: The outside voice argues that reflection (5b) is an LLM grading its own homework with no ground truth. The 'reopened issue' heuristic is a proxy, and if reflection writes bad lessons, they compound. This is the plan's biggest structural risk.

Proposed fix: Add a human-reviewable quality dashboard. After each reflection, surface a one-line summary in the daemon notification: 'Oracle accuracy: 78% (15/19 decisions confirmed by outcomes). 2 new patterns learned.' If accuracy drops below 60%, auto-disable memory injection and notify. This gives you a kill switch AND ground truth via human review.

Worth investigating further?
  **A:** A) Add to plan (Recommended) (confidence: 8/10) [Choose completeness]
- **Q:** CROSS-MODEL TENSION 2: The outside voice argues that committing to 5 Oracle sub-phases (5a-5e) before shipping simple cron (4b) delays immediate value for speculative value. The review endorsed Brain-First sequencing.

Compromise: Ship 5a + 5b (memory + reflection) first. Validate that reflection actually improves decision quality over 10+ jobs. THEN decide whether 5c (research), 5d (taste seeding), 5e (taste inference) are worth building. Cron (4b) can ship in parallel since it's independent.

This preserves the Brain-First thesis while adding a validation gate.
  **A:** A) Add validation gate (Recommended) (confidence: 8/10) [Pragmatic]
- **Q:** CROSS-MODEL TENSION 3: The review missed this entirely. When Parallel Daemons ships, two daemon instances can run reflection simultaneously, both writing to the same `decision-outcomes.md` and `MEMORY.md`. Last-writer-wins means one instance's reflection insights get silently overwritten.

Fix: Add a file-level lock for reflection writes (same atomic-rename pattern used for global budget), or serialize reflection through a single shared queue. Since reflection runs once per job (not frequently), a simple lock file is sufficient.

This MUST be addressed before Parallel Daemons ships.
  **A:** A) Add to plan (Recommended) (confidence: 9/10) [Choose completeness]
- **Q:** The outside voice raised a valid point: there's no `--no-memory` flag to disable Oracle memory at runtime. If memory files start causing worse decisions, you have to manually delete files. A simple `--no-memory` flag on `garyclaw run` and a `disable_memory` field in daemon.json would serve as a kill switch.

RECOMMENDATION: Choose A — this is the escape hatch for the core risk (bad reflection data compounding). Combined with the auto-disable circuit breaker at <60% accuracy, this gives you both manual and automatic kill switches. Completeness: A=9/10, B=5/10.
  **A:** A) Add --no-memory flag (Recommended) (confidence: 9/10) [Choose completeness]
- **Q:** The outside voice notes that Oracle latency (40K input × 20 decisions = 40-100 seconds of serial overhead per job) is never discussed. The plan analyzes dollar cost but not time cost.

At 20 decisions per job, each taking 2-5 seconds, that's 40-100 seconds of Oracle overhead. For a job that takes 30+ minutes, this is <5% overhead — probably acceptable. But it should be documented, and decisions could potentially be batched or parallelized in the future.

RECOMMENDATION: Choose A — document the latency expectation. No code change needed now, but acknowledge it in the plan.
  **A:** A) Document latency (Recommended) (confidence: 7/10) [Choose completeness]
- **Q:** TODO 1: Memory-informed adaptive scheduling (deferred from cherry-pick ceremony). The Oracle learns optimal trigger patterns from job outcomes — e.g., 'QA finds 3x more bugs after large commits, trigger after 5+ file changes.' Requires 50+ jobs of history.

Effort: M (human: ~1 week / CC: ~1 hour). Priority: P3. Depends on: Phase 5b (quality metrics) + Phase 4b (cron baseline).
  **A:** A) Add to TODOS.md (Recommended) (confidence: 9/10) [Bias toward action]
- **Q:** TODO 2: Oracle decision batching for latency optimization. The outside voice identified ~40-100s of serial Oracle overhead per job (20 decisions × 2-5s each). A future optimization: batch nearby decisions into a single Oracle call when multiple AskUserQuestions fire within the same segment. Could reduce latency by 50-70%.

Effort: S (human: ~3 days / CC: ~30 min). Priority: P3. Depends on: Phase 5a (memory Oracle working first).
  **A:** A) Add to TODOS.md (Recommended) (confidence: 8/10) [Bias toward action]
- **Q:** TODO 3: Cross-project memory scoping. The outside voice flagged that global `decision-outcomes.md` can poison unrelated projects — a failure in project A becomes a negative signal for project B where the approach is perfectly valid. Fix: scope `decision-outcomes.md` to per-project only. Only `domain-expertise.md` (general knowledge) and `taste.md` (personal preferences) go in the global layer.

Effort: XS (human: ~1 day / CC: ~15 min). Priority: P2. Depends on: Phase 5a (memory layer design).
  **A:** A) Add to plan now (Recommended) (confidence: 9/10) [Boil lakes]
- **Q:** CEO review complete (CLEAR, 0 unresolved). The eng review is the required shipping gate and is currently 1 commit stale. This CEO review expanded scope significantly (Creative Oracle, validation gate, circuit breaker, reflection lock, safe-json.ts, etc.) — a fresh eng review is strongly recommended to validate the architecture before implementation.

No UI scope was detected, so design review is not needed.

What's next?
  **A:** A) Run /plan-eng-review (Recommended) (confidence: 9/10) [Choose completeness]
- **Q:** The vision from this review produced 5 accepted scope expansions and a comprehensive Brain-First Roadmap CEO plan. Want to promote it to a design doc in the repo?

The CEO plan is currently at `~/.gstack/projects/0raclide-GaryClaw/ceo-plans/2026-03-26-brain-first-roadmap.md` (local). Promoting it to `docs/designs/` makes it visible to anyone reading the repo.
  **A:** A) Promote to docs/designs/ (Recommended) (confidence: 9/10) [Choose completeness]
- **Q:** GaryClaw on main, eng review of Brain-First Roadmap. Architecture issue: the plan says to use a custom 'file-level lock' for reflection writes, but doesn't specify the mechanism. `proper-lockfile` is the standard Node.js library for inter-process file locking (uses atomic mkdir, handles staleness, works on network filesystems). Rolling a custom lock is unnecessary complexity.

RECOMMENDATION: Choose A — this is a 'boring by default' decision. Use the proven library instead of spending an innovation token on file locking. Completeness: A=9/10, B=6/10.
  **A:** A) Use proper-lockfile (Recommended) (confidence: 9/10) [Explicit over clever]
- **Q:** GaryClaw eng review. Architecture issue: Phase 4b needs a cron expression parser. The plan says 'CronTrigger alongside GitPollTrigger' but doesn't specify whether to use a library or roll a custom parser.

Two standard options: `node-cron` (most popular, simple API, validates expressions) or `croner` (newer, used by PM2/Uptime Kuma, supports timezone, slightly better performance). Both are small, well-maintained, and avoid rolling a custom cron parser.

RECOMMENDATION: Choose A — `croner` is more modern, supports timezones (useful for 'run QA at 2am local'), and is actively maintained with better TypeScript support. 'Boring by default' — use the standard library. Completeness: A=9/10, B=8/10.
  **A:** A) croner (Recommended) (confidence: 9/10) [Explicit over clever]
- **Q:** GaryClaw eng review, code quality. The plan's memory files (taste.md, domain-expertise.md, decision-outcomes.md, MEMORY.md) use markdown format, but `metrics.json` uses JSON. This creates two serialization patterns in the same directory: markdown files read as raw text for prompt injection, JSON files parsed structurally.

The memory file integrity section says 'On JSON parse error, rename to .bak' — but the markdown files can't have JSON parse errors (they're plain text). The corruption recovery logic needs to be format-aware.

This isn't a bug, but it should be explicitly documented in `oracle-memory.ts`: markdown files → read as string (can't corrupt), JSON files → read with safe-json.ts (can corrupt). Prevents future confusion.

RECOMMENDATION: Choose A — explicit over clever. 3 lines of comments prevent a future engineer from applying JSON recovery to a markdown file.
  **A:** A) Document explicitly (Recommended) (confidence: 9/10) [Explicit over clever]
- **Q:** GaryClaw eng review, test coverage. The plan is missing test specifications for 6 areas that the CEO review added (safe-json.ts, cron triggers, SIGHUP reload, circuit breaker, sanitization, researcher edge cases). These are all new code paths with error handling that needs verification.

I'll add test specs for all 6 to the plan. This is a lake worth boiling — test writing is the cheapest category (human: ~1 day / CC: ~15 min for all 6 combined). No question needed — just confirming I'll spec these out.

Estimated additional tests: ~45 across the 6 new test areas.
  **A:** A) Add all test specs (Recommended) (confidence: 9/10) [Boil lakes]
- **Q:** All eng review sections complete. The CEO review already ran an outside voice that produced 10 findings and 3 cross-model tensions, all resolved. Running another outside voice on the same plan would likely produce diminishing returns.

RECOMMENDATION: Choose B — the CEO review's outside voice already challenged this plan thoroughly. A second outside voice on the same plan would be redundant. Completeness: A=7/10, B=8/10 (higher because the CEO review already did this).
  **A:** B) Skip (Recommended) (confidence: 9/10) [DRY]
- **Q:** GaryClaw on main. Both CEO and Eng reviews are CLEAR for the Brain-First Roadmap. No design review needed (no UI scope). The plan is ready to implement.

Key decisions locked in:
• Sequence: 5a (Memory) → 5b (Reflection) → VALIDATION GATE → 4b (Cron) in parallel → 5c/5d/5e → Parallel Daemons
• Libraries: proper-lockfile for reflection locking, croner for cron scheduling
• 53 new test specs across 6 test files
• Circuit breaker at 60% accuracy, --no-memory kill switch
• safe-json.ts DRY extraction

What's next?
  **A:** B) Run /ship (confidence: 9/10) [Bias toward action]

---
*Generated by GaryClaw*