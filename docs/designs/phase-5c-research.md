---
status: ACTIVE
---
# Design: Phase 5c — Domain Expertise Research

Generated 2026-03-26

## Problem

The Oracle makes decisions using taste preferences and past decision outcomes, but has no mechanism to acquire domain expertise. When working on a project using unfamiliar technology (e.g., WebSocket libraries, OAuth 2.1 spec, ARM NEON intrinsics), the Oracle relies on Claude's general training knowledge, which may be outdated or lack implementation-specific nuances.

Domain expertise research fills this gap: the daemon can research topics relevant to the project and persist structured findings in `domain-expertise.md` for future Oracle decisions.

## Solution

### `src/researcher.ts` — Research Agent

A new module that:
1. Accepts a topic string
2. Performs web searches (max 10 per session, 5-minute timeout)
3. Synthesizes findings into structured domain expertise
4. Writes to `domain-expertise.md` with YAML frontmatter for freshness tracking

**Output schema for each research topic:**

```markdown
---
topic: WebSocket libraries for Node.js
last_researched: 2026-03-26T10:00:00Z
search_count: 6
partial: false
---

## Current SOTA
- ws (v8.x) is the standard — fastest, most widely used, zero dependencies
- Socket.IO adds rooms/namespaces/fallback but 3x larger

## What Works
- ws for raw WebSocket: 50K concurrent connections on a single process
- Heartbeat ping/pong every 30s prevents zombie connections
- Binary frames for large payloads (protobuf over WebSocket)

## What Doesn't
- Socket.IO's auto-reconnect conflicts with custom retry logic
- uWebSockets.js faster but abandoned upstream, no TypeScript types
- WebSocket over HTTP/2: spec exists but no production Node.js support

## Key References
- [ws README](https://github.com/websockets/ws)
- [Node.js WebSocket benchmarks 2026](https://example.com/benchmarks)
```

### Research Flow

```
garyclaw research "WebSocket libraries for Node.js"
  │
  ├── Read existing domain-expertise.md (if any)
  ├── Check freshness: if < 14 days old, skip (unless --force)
  │
  ├── Build research prompt with topic + existing knowledge
  ├── Start SDK session with research-specific canUseTool:
  │     - Allow: WebSearch, WebFetch, Read (for existing files)
  │     - Deny: Edit, Write, Bash, Glob, Grep (read-only research)
  │
  ├── SDK researches topic (max 10 searches, 5-min timeout)
  ├── Extract structured findings from SDK output
  │
  ├── Merge with existing domain-expertise.md:
  │     - New topic: append section
  │     - Existing topic: replace section with fresh data
  │     - Respect 20K token budget (truncate oldest topics)
  │
  └── Write updated domain-expertise.md
```

### Freshness Policy

Each topic section has a `last_researched` timestamp in its YAML frontmatter.

**Staleness rules:**
- Default freshness window: 14 days
- Auto-refresh trigger: 3+ low-confidence Oracle decisions (confidence < 6) in the same topic area within a single job
- Manual refresh: `garyclaw research <topic> --force`
- Partial results: On timeout, save whatever was synthesized with `partial: true` in frontmatter. Partial results are usable and count toward freshness (re-research fills gaps, doesn't restart).

### Auto-Research Trigger (Daemon Integration)

When the Oracle makes 3+ low-confidence decisions in a job, the orchestrator can trigger a research session before the next job. This is optional and gated behind a daemon config flag:

```json
{
  "autoResearch": {
    "enabled": true,
    "lowConfidenceThreshold": 6,
    "minDecisionsToTrigger": 3
  }
}
```

For Phase 5c, implement the manual `garyclaw research` command only. The auto-research trigger is a future enhancement noted in TODOS.md.

### Graceful Degradation

When WebSearch is unavailable (no internet, rate limited, tool not available):
1. Log warning: "WebSearch unavailable — skipping research"
2. Return existing domain-expertise.md content unchanged
3. Set `partial: true` with note "WebSearch unavailable"
4. Do NOT fail the job — research is advisory, not blocking

## New Code

### `src/researcher.ts` (~150 lines)

```typescript
export interface ResearchConfig {
  topic: string;
  projectDir: string;
  maxSearches: number;        // default: 10
  timeoutMs: number;          // default: 300_000 (5 min)
  force: boolean;             // ignore freshness, re-research
  oracleMemoryConfig: OracleMemoryConfig;
}

export interface ResearchResult {
  topic: string;
  sectionsFound: number;
  searchesUsed: number;
  partial: boolean;
  freshUntil: string;         // ISO timestamp
}

// Main entry point
export async function runResearch(config: ResearchConfig): Promise<ResearchResult>

// Check if topic needs re-research
export function isTopicStale(
  domainExpertise: string | null,
  topic: string,
  freshnessWindowDays?: number,
): boolean

// Parse domain-expertise.md into topic sections
export function parseDomainSections(content: string): DomainSection[]

// Merge new research into existing domain-expertise.md
export function mergeDomainSections(
  existing: DomainSection[],
  newSection: DomainSection,
  tokenBudget: number,
): string

// Build the research prompt for the SDK
export function buildResearchPrompt(topic: string, existingKnowledge: string | null): string

// Build canUseTool for research (read-only + WebSearch)
export function createResearchCanUseTool(): CanUseToolResult
```

### `src/cli.ts` modifications (~30 lines)

Add `research` command:

```
garyclaw research <topic>              # research a topic
garyclaw research <topic> --force      # ignore freshness, re-research
garyclaw research <topic> --project-dir /path  # specify project
```

### `src/types.ts` additions (~5 lines)

```typescript
export interface DomainSection {
  topic: string;
  lastResearched: string;
  searchCount: number;
  partial: boolean;
  content: string;
}
```

## Test Plan

### `test/researcher.test.ts` (~25 tests)

| Group | Tests | Scenarios |
|-------|-------|-----------|
| `isTopicStale` | 5 | No existing content, topic not found, fresh (< 14 days), stale (> 14 days), custom window |
| `parseDomainSections` | 5 | Empty, single topic, multiple topics, malformed frontmatter, partial flag |
| `mergeDomainSections` | 5 | New topic appended, existing topic replaced, budget enforcement (oldest dropped), empty existing, multiple existing |
| `buildResearchPrompt` | 3 | New topic (no existing), topic with existing knowledge, long topic name |
| `createResearchCanUseTool` | 4 | Allows WebSearch, allows WebFetch, allows Read, denies Edit/Write/Bash |
| `runResearch` | 3 | Mock SDK — successful research, timeout produces partial result, WebSearch unavailable graceful degradation |

## Implementation Order

1. `src/types.ts` — Add `DomainSection` interface
2. `src/researcher.ts` — Core module: parsing, merging, freshness, prompt building, canUseTool
3. `test/researcher.test.ts` — All tests
4. `src/cli.ts` — Add `research` command
5. Update CLAUDE.md — Add researcher to module map, update roadmap status
6. `npm test` — Verify all tests pass

## Verification

1. `npm test` — all existing + ~25 new tests pass
2. `garyclaw research "test topic" --force` runs without error (requires internet)
3. `domain-expertise.md` is created with correct structure
4. Re-running same topic within 14 days shows "topic is fresh, skipping"
5. `--force` flag bypasses freshness check

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 3 | CLEAR | mode: SELECTIVE_EXPANSION, 0 critical gaps |
| Codex Review | `/codex review` | Independent 2nd opinion | 4 | issues_found | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 8 | CLEAR | 7 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

- **UNRESOLVED:** 0 unresolved decisions across all reviews
- **VERDICT:** ENG CLEARED — 7 issues all resolved, 0 critical gaps, 34 tests planned for 100% coverage
