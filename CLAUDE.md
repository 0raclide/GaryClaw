# GaryClaw

**Context-infinite orchestration harness for Claude Code skills.**

GaryClaw solves the #1 pain point of long-running gstack skills (`/qa`, `/design-review`, `/autoplan`): context window exhaustion. These skills are iterative fix loops (find → fix → verify → screenshot → commit → repeat) that consume context rapidly. With autocompact OFF, you hit end-of-context. With autocompact ON, the skill's own instructions get compressed away and quality degrades.

GaryClaw wraps Claude Code in an external harness that monitors context usage, checkpoints state, and automatically relays work across fresh sessions — making skills effectively context-infinite.

---

## Current Status

**Phase 1a: COMPLETE** (2026-03-25) — Core relay engine, 8 source modules
**Phase 1b: COMPLETE** (2026-03-25) — AskUserQuestion UX polish, live progress, decision audit log
**Phase 2: COMPLETE** (2026-03-25) — Decision Oracle, autonomous mode, replay command
- 113 passing tests across 7 test files
- All 4 spikes passed (canUseTool, token tracking, env passthrough, relay prompt sizing)

**Next:** E2E test with real /qa skill → Phase 3 (Skill Chaining)

---

## Usage

```bash
# Run a skill with human-in-the-loop decisions
npx tsx src/cli.ts run qa --project-dir /path/to/project

# Run fully autonomous (Decision Oracle makes all decisions)
npx tsx src/cli.ts run qa --autonomous

# Resume from last checkpoint
npx tsx src/cli.ts resume --checkpoint-dir .garyclaw

# Replay decision timeline
npx tsx src/cli.ts replay

# Options
npx tsx src/cli.ts run qa \
  --max-turns 15 \         # turns per segment (default: 15)
  --threshold 0.85 \       # relay at 85% context (default: 0.85)
  --max-sessions 10 \      # max relay sessions (default: 10)
  --autonomous             # use Decision Oracle

# Run tests
npm test
```

---

## Architecture

```
CLI (args, readline, display)
  → Orchestrator (main loop: sessions × segments)
      → sdk-wrapper.startSegment()  →  SDK query() generator
      → token-monitor (per-turn context tracking)
      → ask-handler (canUseTool callback for AskUserQuestion)
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
| `src/orchestrator.ts` | Two-level loop (sessions × segments), deferred relay |
| `src/cli.ts` | `garyclaw run/resume/replay`, `--autonomous` mode |

### Key Design Decisions

- **Agent SDK (Approach A)** — structured JSON, `canUseTool`, token tracking via `@anthropic-ai/claude-agent-sdk`
- **Fresh sessions for relay** (not resume) — resume carries compressed history consuming context. Fresh session + checkpoint prompt starts at ~17K tokens.
- **Per-turn monitoring with deferred relay** — check `AssistantMessage.message.usage` every turn, only act at segment boundary (never interrupt mid-tool-call)
- **Token formula:** `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` ≈ context size
- **Context window:** `modelUsage.contextWindow` = 1,000,000
- **Strip ANTHROPIC_API_KEY** from env so SDK uses Claude Max login (not API billing)
- **Git stash with `--include-untracked`** for relay — new files must be included

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
| `test/ask-handler.test.ts` | 16 | Multi-question, multi-select, decision audit log, timeout→deny |
| `test/oracle.test.ts` | 16 | Oracle decisions, confidence, escalation, error handling |
| `test/sdk-wrapper.test.ts` | 12 | env stripping, usage extraction, result parsing |
| `test/report.test.ts` | 13 | merge/dedup, markdown formatting |
| `test/relay.test.ts` | 7 | git stash/pop, relay segment construction |

---

## Phased Roadmap

### Phase 1a: Core Relay — COMPLETE
SDK harness, token tracking, checkpoint/relay, report generation. Solves context exhaustion.

### Phase 1b: AskUserQuestion UX Polish — COMPLETE
Multi-question/multi-select handling, "Other" free text, ANSI-colored CLI, live progress feed (assistant text + tool calls), decision audit log (`.garyclaw/decisions.jsonl`), cost tracking display.

### Phase 2: Decision Oracle — COMPLETE
Auto-decisions via `--autonomous` mode using 6 Decision Principles. Confidence scoring (1-10), security/destructive escalation, `garyclaw replay` command, escalated.jsonl audit trail.

### Phase 3: Skill Chaining
`garyclaw run /qa /design-review /ship` — sequential pipeline with context passing.

### Phase 4: Daemon Mode (DEFERRED)
Persistent background process with triggers/scheduling. See TODOS.md.

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
