# GaryClaw

**Context-infinite orchestration harness for Claude Code skills.**

GaryClaw solves the #1 pain point of long-running gstack skills (`/qa`, `/design-review`, `/autoplan`): context window exhaustion. These skills are iterative fix loops (find → fix → verify → screenshot → commit → repeat) that consume context rapidly. With autocompact OFF, you hit end-of-context. With autocompact ON, the skill's own instructions get compressed away and quality degrades.

GaryClaw wraps Claude Code in an external harness that monitors context usage, checkpoints state, and automatically relays work across fresh sessions — making skills effectively context-infinite.

---

## Current Status

**Phase 1a: COMPLETE** (2026-03-25) — Core relay engine, 8 source modules
**Phase 1b: COMPLETE** (2026-03-25) — AskUserQuestion UX polish, live progress, decision audit log
**Phase 2: COMPLETE** (2026-03-25) — Decision Oracle, autonomous mode, replay command
**Phase 3: COMPLETE** (2026-03-25) — Skill Chaining, pipeline runner, context handoff, pipeline resume
**Structured Issue Extraction: COMPLETE** (2026-03-25) — Real-time + git log hybrid extraction
**Phase 4a: COMPLETE** (2026-03-25) — Daemon Mode MVP: lifecycle, IPC, job queue, git poll, notifications
**Phase 5a: COMPLETE** (2026-03-26) — Oracle Memory Infrastructure + Enhanced Oracle Prompt
- 18 source modules + CLI
- All 4 spikes passed (canUseTool, token tracking, env passthrough, relay prompt sizing)

**Next:** Phase 5b (Post-Job Reflection + Quality Tracking)

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

# Resume from last checkpoint or pipeline
npx tsx src/cli.ts resume --checkpoint-dir .garyclaw

# Replay decision timeline
npx tsx src/cli.ts replay

# Oracle memory management
npx tsx src/cli.ts oracle init                   # create memory dirs + templates

# Daemon mode (background process)
npx tsx src/cli.ts daemon start                    # start daemon (reads .garyclaw/daemon.json)
npx tsx src/cli.ts daemon status                   # show running status
npx tsx src/cli.ts daemon trigger qa design-review # enqueue skills
npx tsx src/cli.ts daemon log --tail 100           # view daemon log
npx tsx src/cli.ts daemon stop                     # graceful shutdown

# Options
npx tsx src/cli.ts run qa \
  --max-turns 15 \         # turns per segment (default: 15)
  --threshold 0.85 \       # relay at 85% context (default: 0.85)
  --max-sessions 10 \      # max relay sessions (default: 10)
  --autonomous \           # use Decision Oracle
  --no-memory              # disable Oracle memory injection

# Run tests
npm test
```

---

## Architecture

```
CLI (args, readline, display, daemon subcommands)
  → Daemon (persistent background process, PID file, IPC)
  |   → Job Runner (FIFO queue, budget enforcement, state persistence)
  |   → Git Poller (HEAD change detection, debounce)
  |   → Notifier (macOS notifications, job summaries)
  |
  → Pipeline (multi-skill sequential execution, context handoff)
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
| `src/token-monitor.ts` | `recordTurnUsage`, `shouldRelay`, `computeGrowthRate` |
| `src/checkpoint.ts` | Atomic write (2-rotation), tiered relay prompt generation |
| `src/ask-handler.ts` | `canUseTool` callback intercepting AskUserQuestion |
| `src/sdk-wrapper.ts` | SDK isolation layer: `startSegment`, `extractTurnUsage`, `buildSdkEnv` |
| `src/relay.ts` | Git stash + fresh relay segment + stash pop |
| `src/report.ts` | Merge issues/findings/decisions, markdown report |
| `src/oracle.ts` | Decision Oracle — 6 Principles, confidence scoring, escalation |
| `src/issue-extractor.ts` | Hybrid issue extraction from SDK stream + git log |
| `src/pipeline.ts` | Sequential skill chaining, context handoff, pipeline state |
| `src/orchestrator.ts` | Two-level loop (sessions × segments), deferred relay |
| `src/daemon.ts` | Daemon process: PID, IPC server, pollers, signal handling |
| `src/daemon-ipc.ts` | Unix socket IPC: `createIPCServer`, `sendIPCRequest` |
| `src/job-runner.ts` | FIFO job queue, budget enforcement, state persistence |
| `src/triggers.ts` | Git poll trigger with HEAD change detection + debounce |
| `src/notifier.ts` | macOS notifications via osascript, job summary files |
| `src/safe-json.ts` | Shared atomic JSON/text I/O — `safeReadJSON`, `safeWriteJSON`, corruption recovery |
| `src/oracle-memory.ts` | Two-layer oracle memory: read/write taste, domain expertise, outcomes, metrics |
| `src/cli.ts` | `garyclaw run/resume/replay/oracle/daemon`, multi-skill, daemon subcommands |

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

---

## Orchestrator Loop

```
1. verifyAuth()
2. for sessionIndex in 0..maxRelaySessions:
3.   for segmentIndex in 0..∞:
4.     segment = startSegment(prompt, maxTurns=15, ...)
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
| `test/checkpoint.test.ts` | 25 | write/read/rotation, relay prompt tiering, token budget |
| `test/ask-handler.test.ts` | 26 | Multi-question, multi-select, decision audit log, timeout→deny, otherProposal, memory passing |
| `test/oracle.test.ts` | 33 | Oracle decisions, confidence, escalation, error handling, 7 principles, memory injection, Other |
| `test/sdk-wrapper.test.ts` | 12 | env stripping, usage extraction, result parsing |
| `test/report.test.ts` | 13 | merge/dedup, markdown formatting |
| `test/relay.test.ts` | 7 | git stash/pop, relay segment construction |
| `test/pipeline.test.ts` | 27 | state persistence, context handoff, pipeline report, validation |
| `test/issue-extractor.test.ts` | 38 | commit parsing, IssueTracker, extractAllToolUse, severity inference |
| `test/daemon-ipc.test.ts` | 10 | Request/response over socket, malformed input, timeout |
| `test/notifier.test.ts` | 15 | Notification formatting, summary generation, graceful failure |
| `test/job-runner.test.ts` | 20 | FIFO queue, dedup, budget, state persistence, job lifecycle |
| `test/triggers.test.ts` | 15 | Git poll HEAD detection, debounce, interval, branch filtering |
| `test/daemon.test.ts` | 12 | Config validation, PID lifecycle, IPC handler, logger |
| `test/safe-json.test.ts` | 21 | Atomic write/read, corruption recovery, .bak rename, validation |
| `test/oracle-memory.test.ts` | 47 | Two-layer resolution, sanitization, metrics, circuit breaker, outcomes |

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

### Phase 5b: Post-Job Reflection + Quality Tracking (NEXT)
`src/reflection.ts` — post-job reflection runner, decision outcomes tracking, reopened issue detection.

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

All 4 spikes passed — see `src/spikes/` for runnable proof-of-concept scripts.

1. **canUseTool:** AskUserQuestion interception via `updatedInput` with pre-filled answers works
2. **Token tracking:** Per-turn usage on `AssistantMessage.message.usage`. `modelUsage.contextWindow` = 1,000,000
3. **Env passthrough:** Custom env vars + `$B` browse binary pass through to spawned sessions
4. **Relay prompt size:** 30-issue relay = ~1,880 tokens (19% of 10K budget)

---

## Name Origin

Gary (Garry Tan, gstack creator) + Claw (grip/control mechanism). GaryClaw grabs the terminal and doesn't let go.
