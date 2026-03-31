# TODOS

## P2: Improved Observability — Better Learning Signals for the Self-Improvement Loop

**What:** We track token usage per-turn in `token-monitor.ts`, but the observability picture is incomplete. Key gaps:

1. **Per-skill token consumption** — We know per-skill *cost* (USD) but not per-skill *token breakdown* (input vs output vs cache). A skill that costs $2 because it uses 800K input tokens has a very different optimization path than one that costs $2 because it generates 200K output tokens.
2. **Prompt section token accounting at runtime** — `buildPrioritizePrompt` estimates tokens with a heuristic, but we never measure actual tokens consumed by the SDK for each prompt section. We can't tell if the TODOS.md section or the Oracle context section is the real budget hog.
3. **Oracle token overhead** — Oracle decisions have per-call token costs (input + output) that we don't track separately from the skill's tokens. We know how many decisions per job, but not how many tokens the Oracle consumed vs the skill itself.
4. **Relay efficiency** — When a relay happens, we lose the prior session's accumulated context. We don't measure: how much context was built up before relay, how much the relay prompt recovered, and how much was lost. This is the key signal for tuning relay thresholds.
5. **Token waste from retries** — Segment retries and crash recovery re-spend tokens. We don't attribute these separately, so they inflate per-skill cost metrics and pollute the learning signal.
6. **Codebase summary token ROI** — We inject codebase summary observations into relay prompts but never measure whether they actually reduce re-exploration (fewer duplicate tool calls, fewer repeated failed approaches).

**Why:** The self-improvement loop's quality depends on the quality of its learning signals. Right now the daemon optimizes on USD cost and QA issue count — both are lagging indicators. Token-level observability gives leading indicators: "this prompt section is growing 10% per cycle" or "relay recovery rate dropped from 80% to 60% after adding the new context section." These signals let the daemon make smarter composition, budgeting, and relay decisions.

**Implementation:**
- Extend `OrchestratorEvent` with `token_usage` events carrying `{ skill, segment, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`
- In `sdk-wrapper.ts`: extract per-turn token breakdown from `AssistantMessage.message.usage` (already available, just not surfaced)
- In `pipeline.ts`: accumulate per-skill token totals alongside existing cost tracking
- In `dashboard.ts`: new token efficiency section — tokens per commit, tokens per issue fixed, relay token recovery ratio
- In `reflection.ts`: include token efficiency in post-job reflection so the Oracle can learn from it
- Wire token data into `decision-outcomes.md` so the Oracle sees "last time we included the full skill catalog, it added 3K tokens but the Oracle only referenced it in 2/20 decisions"

**Effort:** M (human: ~1 week / CC: ~45 min)
**Depends on:** Nothing — all data sources already exist in SDK usage objects
**Added by:** Human on 2026-03-31

## P3: Job Runner Modular Decomposition — Extract Subsystems from 1888-Line God Module

**What:** `job-runner.ts` at 1888 lines is the largest module and growing. Extract four logical subsystems into focused modules: merge handling (~200 lines → `src/merge-handler.ts`), rate limit handling (~150 lines → `src/rate-limit.ts`), auto-mark/TODO management (~200 lines → `src/todo-manager.ts`), and pre-assignment/composition (~200 lines → `src/job-assignment.ts`). The job-runner becomes a ~900-line orchestrator that delegates to these modules.

**Why:** Every new feature (PR workflow, auto-fix, rate limiting, cost attribution) adds to job-runner.ts because it's the natural integration point. At 1888 lines, it's approaching the threshold where modifications carry high risk of unintended side effects. Decomposition makes each subsystem independently testable and reduces merge conflicts for parallel daemon instances working on different features.

**Effort:** M (human: ~1 week / CC: ~45 min)
**Depends on:** Nothing
**Added by:** Invention Protocol on 2026-03-30

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
**Added by:** Human on 2026-03-30
