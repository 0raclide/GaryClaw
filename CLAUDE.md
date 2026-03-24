# GaryClaw

**Context-infinite orchestration harness for Claude Code skills.**

GaryClaw solves the #1 pain point of long-running gstack skills (`/qa`, `/design-review`, `/autoplan`): context window exhaustion. These skills are iterative fix loops (find → fix → verify → screenshot → commit → repeat) that consume context rapidly. With autocompact OFF, you hit end-of-context. With autocompact ON, the skill's own instructions get compressed away and quality degrades.

GaryClaw wraps Claude Code in an external harness that monitors context usage, checkpoints state, and automatically relays work across fresh sessions — making skills effectively context-infinite.

---

## Problem Statement

### The Pain
- Gstack skills like `/qa` have 11 phases. By Phase 8 (fix loop), each iteration adds browse screenshots, source reads, edits, commits, and re-verification
- Context fills to 200K tokens within ~15-20 fix iterations
- **Autocompact OFF**: Hard crash at end-of-context. Work lost.
- **Autocompact ON**: Skill instructions (SKILL.md — 1000+ lines) get compressed away. Agent loses its persona, stops following the fix protocol, quality degrades
- **Current workaround**: User manually asks "prepare a handoff document + blob for next agent" — tedious, breaks flow, requires expertise

### Why Hooks Can't Solve This
Claude Code hooks are reactive listeners, not orchestrators:
- Cannot read token counts or context window position
- Cannot programmatically trigger `/compact` or `/clear`
- Cannot start new sessions
- Cannot chain sessions together
- Can only react to events (PreToolUse, PostToolUse, PostCompact, etc.)

### The Insight
Claude Code is a CLI. A CLI can be wrapped. An external harness can do everything hooks can't: monitor context, checkpoint state, kill sessions, start fresh ones, and inject the right prompt to resume.

---

## Architecture Options (Researched 2026-03-24)

### Option A: Agent SDK Harness (Recommended)

Use `@anthropic-ai/claude-agent-sdk` to programmatically control Claude Code.

**Why it wins:**
- First-party, officially supported by Anthropic
- Structured JSON communication (no ANSI parsing, no screen scraping)
- Token usage available in `result.usage.input_tokens` after each turn
- Session resume/fork: `resume: "session-id"`, `forkSession: true`
- Custom tool interception via `canUseTool` callback
- `maxTurns` for bounded phases
- Multi-turn via async generator
- Subagent definitions built in

**Architecture:**
```
GaryClaw Orchestrator (Node.js)
  ├── Phase Runner
  │   ├── Reads skill SKILL.md, splits into phases
  │   ├── Runs each phase as a bounded `query()` call
  │   ├── `maxTurns` per phase prevents runaway context
  │   └── Collects structured results via `result` message type
  ├── Context Monitor
  │   ├── Tracks cumulative token usage from `result.usage`
  │   ├── Triggers checkpoint when approaching threshold
  │   └── Estimates context position from input_tokens + output_tokens
  ├── Checkpoint Manager
  │   ├── Writes phase state to `.garyclaw/checkpoint.json`
  │   ├── Captures: completed phases, discovered issues, fix status, screenshots taken
  │   └── Generates resume prompt from checkpoint
  ├── Session Relay
  │   ├── Kills current session when context is high
  │   ├── Starts fresh session with checkpoint prompt
  │   ├── Uses `resume` or fresh `query()` depending on strategy
  │   └── Re-injects skill instructions (SKILL.md) into new session
  └── Report Aggregator
      ├── Merges results across sessions
      ├── Deduplicates (same issue found in multiple passes)
      └── Produces unified final report
```

**Key SDK features used:**
```typescript
import { query, listSessions } from "@anthropic-ai/claude-agent-sdk";

// Phase-bounded execution
for await (const msg of query({
  prompt: skillPhasePrompt,
  options: {
    maxTurns: 15,           // Bounded context per phase
    cwd: projectDir,
    allowedTools: ["Bash", "Read", "Edit", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    outputFormat: {         // Structured checkpoint output
      type: "json_schema",
      schema: checkpointSchema
    }
  }
})) {
  if (msg.type === "result") {
    checkpoint.tokensSoFar += msg.usage.input_tokens;
    if (checkpoint.tokensSoFar > RELAY_THRESHOLD) {
      // Save checkpoint, start fresh session
    }
  }
}
```

### Option B: CLI Pipe Orchestrator (Simpler)

Chain `claude -p` invocations with bash scripting.

```bash
# Phase 1: QA baseline
RESULT=$(claude -p "Run QA phases 1-6..." --output-format json --max-turns 20)
SESSION_ID=$(echo "$RESULT" | jq -r '.session_id')

# Phase 2: Fix loop (resume)
claude -p "Continue with phase 8 fixes..." --resume "$SESSION_ID" --output-format json --max-turns 10

# Phase 3: Final report
claude -p "Generate final QA report..." --resume "$SESSION_ID" --output-format json
```

**Pros:** Zero dependencies, works today, simple to understand
**Cons:** No real-time monitoring, one-shot per invocation, less control over tool permissions

### Option C: Terminal Automation (tmux + node-pty)

Full terminal control — can type `/compact`, `/context`, parse output.

**Pros:** Can interact with the full interactive TUI, maximum flexibility
**Cons:** Brittle (ANSI parsing), breaks on UI changes, timing-dependent

**Relevant tools if we go this route:**
- `node-pty` (Microsoft, 1.1M weekly downloads) — spawn pseudo-terminal
- `@xterm/headless` (20K stars) — parse terminal buffer into screen state
- `strip-ansi` (261M weekly downloads) — strip ANSI codes
- `tmux send-keys` / `capture-pane` — send commands, read output
- `zjctl` (Zellij) — has `wait-idle` for better timing

### Decision: Option A (Agent SDK)
The SDK provides everything we need with structured data, no parsing fragility, and first-party support. Terminal automation is a fallback if we discover SDK gaps.

---

## Existing Art

| Project | Stars | What it does | Relevant to us? |
|---------|-------|-------------|-----------------|
| ComposioHQ/agent-orchestrator | 5,300 | Parallel Claude instances in tmux + git worktrees | Architecture patterns, but different goal (parallel tasks vs context relay) |
| wshobson/agents | — | 112 specialized agents + orchestrators | Plugin library, not terminal control |
| tmux-claude-mcp-server | — | MCP interface for tmux Claude management | tmux-based, less robust than SDK |
| agent-deck | — | TUI for managing multiple AI agents | UI layer, not orchestration |

None of these solve our specific problem: **context-aware relay for long-running iterative skills**.

---

## Research Log

### 2026-03-24: Initial Research

**Claude Code Hooks (25 events):** PreToolUse, PostToolUse, SessionStart, Stop, PreCompact, PostCompact, etc. Hooks CAN intercept tool calls (`canUseTool`), inject `additionalContext`, and modify tool parameters. Hooks CANNOT read token counts, trigger /compact, start sessions, or chain sessions. Reactive only.

**Agent SDK (`@anthropic-ai/claude-agent-sdk` v2.1.81):**
- `query()` async generator streams typed `SDKMessage` union
- `result.usage.input_tokens` / `output_tokens` — token counts per query
- `resume: "session-id"` / `forkSession: true` — session management
- `canUseTool` callback — intercept any tool call programmatically
- `maxTurns` / `maxBudgetUsd` — bounded execution
- `listSessions()` / `getSessionMessages()` — session introspection
- Custom subagent definitions via `agents` option
- Structured output via `outputFormat: { type: "json_schema" }`
- `permissionMode: "bypassPermissions"` — fully autonomous
- `--bare` mode — fast, no hooks/plugins/settings discovery

**Terminal Control:**
- `node-pty` (Microsoft, 1.1M/week): Pseudo-terminal spawning. Raw ANSI output.
- `@xterm/headless` (xterm.js, 20K stars): Full VT100 parser, virtual screen buffer.
- `strip-ansi` (261M/week): ANSI stripping. Node 18.3+ has `util.stripVTControlCharacters()`.
- tmux: `send-keys` + `capture-pane` + control mode (`-CC`). Battle-tested.
- zjctl (Zellij): `wait-idle` for timing, but 4 stars (very early).

---

## MVP Scope

### Phase 1: Proof of Concept
1. SDK harness that runs a single gstack skill phase
2. Monitors token usage from `result.usage`
3. Checkpoints state to `.garyclaw/checkpoint.json`
4. Resumes in a fresh session with checkpoint prompt

### Phase 2: Full Relay
1. Auto-splits skill SKILL.md into phases
2. Runs phases sequentially with bounded `maxTurns`
3. Automatic relay when context crosses threshold
4. Merges results across sessions into unified report

### Phase 3: Smart Relay
1. Context prediction (estimate when we'll hit the wall based on phase type)
2. Optimal relay timing (don't relay mid-fix — wait for commit)
3. Skill-specific checkpoint schemas (QA issues, design findings, etc.)
4. Progress UI (how many phases done, estimated remaining)

---

## Tech Stack

- **Runtime:** Node.js / TypeScript (matches gstack ecosystem)
- **Core dependency:** `@anthropic-ai/claude-agent-sdk`
- **Build:** None initially (ts-node or bun for dev)
- **Tests:** Vitest (matches nihontowatch patterns)

---

## Open Questions

1. **Token usage tracking:** SDK gives per-query usage, not cumulative context window position. Can we reliably estimate context fullness from cumulative input+output tokens?
2. **Skill phase boundaries:** Skills aren't currently structured with explicit phase markers that a harness could parse. Do we need to modify SKILL.md format?
3. **Browse binary:** Gstack skills use `$B` (browse binary) for screenshots. Does the SDK support passing environment variables that the spawned Claude session inherits?
4. **Checkpoint fidelity:** What state is needed to resume a QA fix loop? Issue list, fix status, file paths, screenshot paths, git state?
5. **Session resume vs fresh start:** Is `resume` (which carries compressed history) or a fresh `query()` with a checkpoint prompt (clean context) better for relay?

---

## Name Origin

Gary (Garry Tan, gstack creator) + Claw (grip/control mechanism). GaryClaw grabs the terminal and doesn't let go.
