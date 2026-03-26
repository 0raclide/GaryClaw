---
status: DRAFT
---
# Design: Creative Oracle — Memory-Backed Autonomous Decision Engine

Generated 2026-03-26
Branch: main

## Vision

The Oracle today is a **picker** — it chooses from options a skill presents, using 6 fixed principles. The Creative Oracle is a **thinker** — it draws on accumulated taste, domain expertise, and decision history to make expert-level decisions, and can propose novel approaches when the given options are insufficient.

The key shift: from multiple-choice test-taker to senior engineer with opinions, domain knowledge, and institutional memory.

### 10x Check

Push code. Go to sleep. The daemon wakes up, and the Oracle doesn't just approve the obvious option — it notices that the proposed approach conflicts with a pattern that failed last week (decision-outcomes), proposes an alternative informed by current SOTA research (domain-expertise), and makes the call in a way that reflects how *you* would have decided (taste). You wake up to changes that feel like they were made by someone who deeply understands your project, your preferences, and the problem domain.

### Platonic Ideal

An Oracle that combines three things no single-turn LLM call can have today:
1. **Your taste** — subjective preferences that make decisions feel like yours
2. **Domain expertise** — deep research on what works in the problem space
3. **Institutional memory** — learned patterns from past decisions and their outcomes

All three injected into a single-turn Opus 4.6 call with 1M context. No RAG, no vector DB, no retrieval latency. Just files in a prompt.

---

## Problem Statement

### Current Oracle Limitations

1. **Stateless** — Every decision starts from zero. The Oracle doesn't know that approach X failed last Tuesday or that pattern Y has been consistently chosen across 50 jobs.

2. **Menu-bound** — Can only pick from options the skill presents. When all options are suboptimal, it picks the least-bad one instead of proposing something better. The `canUseTool` callback already supports free-text "Other" responses, but the Oracle never uses this capability.

3. **No taste** — The 6 Decision Principles are logical rules, but taste is the subjective layer on top. "Prefer flat file structures" and "commit messages should explain why, not what" are opinions that shape every decision but aren't captured anywhere.

4. **No domain knowledge** — When deciding on an agent memory architecture, the Oracle doesn't know what Reflexion is, how Devin handles long-running tasks, or what the current SOTA for decision-making frameworks looks like. It reasons from first principles every time instead of standing on existing research.

### Why This Matters

The Oracle makes 15-30 decisions per skill. Across a 3-skill pipeline, that's 45-90 decisions per job. If each decision is 5% better due to memory, taste, and domain expertise, the compounding effect on job quality is massive. The difference between "automated" and "autonomous" is whether the system gets smarter over time.

---

## Architecture

### Memory Layer

Four files, four knowledge types, four sources:

```
.garyclaw/oracle-memory/
  MEMORY.md              # Project state index (auto-updated, always injected)
  taste.md               # Subjective preferences (human-authored, occasionally refined)
  domain-expertise.md    # SOTA research, competitive landscape (machine-researched)
  decision-outcomes.md   # "Chose X → Y happened" history (auto-generated post-job)
```

| File | Author | When Updated | Size Budget |
|------|--------|-------------|-------------|
| `MEMORY.md` | Oracle + human | Ongoing | ~5K tokens |
| `taste.md` | Human (you) | Manual, occasionally | ~3K tokens |
| `domain-expertise.md` | Research agent | Pre-job or on-demand | ~20K tokens |
| `decision-outcomes.md` | Post-job reflection | After every job | ~10K tokens (rolling window) |

**Total memory injection: ~38K tokens** — 3.8% of the 1M context window. Massive headroom.

### Decision Flow (Enhanced)

```
                          ┌──────────────────────────────┐
                          │   Skill asks AskUserQuestion  │
                          │   question + options[]        │
                          └──────────┬───────────────────┘
                                     │
                          ┌──────────▼───────────────────┐
                          │   Build Oracle Prompt         │
                          │                               │
                          │   = 6 Decision Principles     │
                          │   + taste.md                  │
                          │   + domain-expertise.md       │
                          │   + decision-outcomes.md      │
                          │   + MEMORY.md                 │
                          │   + last 5 decisions (session) │
                          │   + question + options        │
                          └──────────┬───────────────────┘
                                     │
                          ┌──────────▼───────────────────┐
                          │   Single-turn Opus 4.6 call   │
                          │   (no tools, pure reasoning)  │
                          └──────────┬───────────────────┘
                                     │
                          ┌──────────▼───────────────────┐
                          │   Parse response              │
                          │                               │
                          │   Choice from options?        │
                          │     → Return choice           │
                          │                               │
                          │   "Other" with proposal?      │
                          │     → Return via updatedInput │
                          │       free-text answer        │
                          │                               │
                          │   Confidence < threshold?     │
                          │     → Escalate (log + notify) │
                          └───────────────────────────────┘
```

### Oracle Prompt Structure

```
You are the GaryClaw Decision Oracle — an expert autonomous decision-maker.

## Decision Principles
{6 principles}

## Taste (from the project owner)
{taste.md contents}

## Domain Expertise
{domain-expertise.md contents}

## Decision History & Outcomes
{decision-outcomes.md — recent entries}

## Project State
{MEMORY.md contents}

## Recent Decisions This Session
{last 5 decisions for consistency}

## Current Decision
Question: {question}
Options:
1. {option1.label}: {option1.description}
2. {option2.label}: {option2.description}
...

## Instructions
Choose the best option, or propose "Other" if you have a genuinely better approach.
Only choose "Other" when:
- You have specific knowledge (from domain expertise or past outcomes) that none of
  the options account for
- Your confidence in all listed options is below 6
- The "Other" proposal is concrete and actionable, not vague

Respond with JSON:
{
  "choice": "<exact option label OR 'Other'>",
  "otherProposal": "<if Other: concrete description of what to do instead>",
  "confidence": <1-10>,
  "rationale": "<one sentence>",
  "principle": "<which principle>",
  "memoryUsed": ["<which memory files influenced this decision>"]
}
```

### "Other" Generation — When and How

The Oracle can respond with `"choice": "Other"` plus an `otherProposal` field. This maps to the existing `canUseTool` free-text mechanism — the `updatedInput` already accepts arbitrary string answers.

**Guardrails on "Other":**
- Only when confidence on ALL listed options is below 6
- Must cite specific memory (domain expertise or past outcomes) justifying the alternative
- `otherProposal` must be concrete and actionable — no vague "consider alternatives"
- "Other" decisions are always logged with full rationale for audit
- Escalation keywords still trigger escalation regardless of "Other"

This prevents the Oracle from being gratuitously creative. It should pick from options most of the time — "Other" is the exception when memory gives it genuine insight the skill didn't have.

### Post-Job Reflection

After each job completes (success or failure), a multi-turn Opus 4.6 call with Write tool access:

```
## Reflection Prompt

You just completed a GaryClaw job. Review what happened and update your memory.

Job: {job.id}
Skills: {job.skills}
Status: {job.status}
Cost: ${job.costUsd}
Error: {job.error ?? "none"}

Decisions made:
{decisions.jsonl contents}

## Current Memory Files
{contents of all 4 memory files}

## Instructions
1. Review each decision. Was it the right call given the outcome?
2. Identify patterns: decisions that consistently work, approaches that fail
3. Note any new domain knowledge discovered during the job
4. Update decision-outcomes.md with new entries
5. Update MEMORY.md if project state changed
6. Keep files within their size budgets (MEMORY: 5K, outcomes: 10K rolling)
7. Prune outdated entries — memory should be current, not a log
```

**The reflection step has Write access** to the oracle-memory directory only. It can update all four memory files but cannot modify source code or any other project files.

**Rolling window for decision-outcomes.md:** Keep the most recent ~50 decision outcomes. Older entries get summarized into patterns ("approach X works for Y-type decisions") before being pruned. This prevents unbounded growth while preserving institutional knowledge.

### Domain Expertise Research

`domain-expertise.md` is populated by a research step — either a dedicated skill (`/research-domain`) or a pre-job phase. The research agent:

1. Takes a topic description (e.g., "autonomous software agent daemon architectures")
2. Performs web searches for SOTA, papers, competitor analysis
3. Synthesizes findings into structured sections:
   - **Current SOTA** — what approaches lead the field
   - **What works** — proven patterns with evidence
   - **What doesn't** — known failure modes and antipatterns
   - **Competitive landscape** — how comparable tools solve the same problem
   - **Key papers/references** — citations for the Oracle to reason about
4. Writes `domain-expertise.md` (budget: ~20K tokens)

**When to research:**
- On first daemon start for a new project (bootstrap)
- On-demand via `garyclaw research <topic>`
- Automatically when the Oracle encounters 3+ low-confidence decisions in a domain it hasn't researched
- Periodically (e.g., weekly) to refresh stale research

Research is **separate from decision-making** — it runs ahead of time so the Oracle has knowledge available when it needs it. No latency at decision time.

---

## Implementation Plan

### Phase 5a: Memory Infrastructure + Enhanced Oracle Prompt

**New files:**
- `src/oracle-memory.ts` — Read/write oracle memory files, size budget enforcement, rolling window management
- `test/oracle-memory.test.ts` — Memory CRUD, budget enforcement, pruning

**Modified files:**
- `src/oracle.ts` — Inject memory files into prompt, parse "Other" responses, `memoryUsed` field
- `src/types.ts` — `OracleMemory` interface, enhanced `OracleOutput` with `otherProposal`
- `test/oracle.test.ts` — Tests for memory-injected prompts, "Other" parsing

**Deliverable:** Oracle reads memory files and injects them into every decision prompt. "Other" generation supported but memory files are empty (manually seeded or populated in 5b).

### Phase 5b: Post-Job Reflection

**New files:**
- `src/reflection.ts` — Post-job reflection runner, memory file updates via SDK with Write tool
- `test/reflection.test.ts` — Reflection prompt building, memory update parsing

**Modified files:**
- `src/job-runner.ts` — Call reflection after job completion
- `src/orchestrator.ts` — Call reflection after single-skill completion (non-daemon)

**Deliverable:** After every job, the Oracle reflects on decisions and outcomes, updating `decision-outcomes.md` and `MEMORY.md`. Memory accumulates across jobs.

### Phase 5c: Domain Expertise Research

**New files:**
- `src/researcher.ts` — Web search + synthesis agent, writes `domain-expertise.md`
- `test/researcher.test.ts` — Research prompt building, output parsing

**Modified files:**
- `src/cli.ts` — `garyclaw research <topic>` command
- `src/daemon.ts` — Optional pre-job research trigger

**Deliverable:** On-demand or automatic domain research populates `domain-expertise.md` with SOTA analysis. Oracle decisions become domain-informed.

### Phase 5d: Taste Seeding + Documentation

**New files:**
- `.garyclaw/oracle-memory/taste.md` — Initial taste file (human-authored template)
- `.garyclaw/oracle-memory/MEMORY.md` — Initial project state

**Modified files:**
- `src/cli.ts` — `garyclaw oracle init` command (creates memory directory + template files)
- `CLAUDE.md` — Phase 5 documentation

**Deliverable:** CLI command bootstraps oracle memory directory with template files. User fills in `taste.md` with their preferences.

---

## Token Budget Analysis

Oracle prompt composition at steady state:

| Component | Tokens | Source |
|-----------|--------|--------|
| System + principles | ~500 | Static |
| `taste.md` | ~3,000 | Human-authored |
| `domain-expertise.md` | ~20,000 | Research agent |
| `decision-outcomes.md` | ~10,000 | Post-job reflection (rolling) |
| `MEMORY.md` | ~5,000 | Auto-updated |
| Recent decisions (5) | ~1,000 | Session state |
| Question + options | ~500 | Skill |
| **Total** | **~40,000** | **4% of 1M context** |

This leaves 960K tokens of headroom. Even with aggressive memory growth, we're nowhere near the limit. The constraint is quality (keeping memory relevant and pruned), not quantity.

**Cost per decision:** Single-turn Opus 4.6 with ~40K input + ~200 output ≈ $0.006. At 20 decisions per job, that's $0.12 in Oracle costs — negligible vs. the skill execution cost.

**Cost per reflection:** Multi-turn Opus 4.6 with ~60K input + ~2K output ≈ $0.02. Once per job — negligible.

---

## Key Design Decisions

1. **Single-turn decisions, multi-turn reflection.** Decisions stay fast and cheap. Reflection is where you invest compute — it runs once per job and has time to think deeply.

2. **File-based memory, not vector DB.** Files are human-readable, auditable, easy to debug, and work perfectly at <50K tokens. No infrastructure dependencies. Mirrors Claude Code's own memory system.

3. **"Other" is the exception, not the rule.** Guardrails ensure the Oracle picks from options 90%+ of the time. "Other" requires low confidence on all options AND specific memory justification. This prevents gratuitous creativity.

4. **Domain expertise is researched, not hallucinated.** The research step uses actual web search to populate domain knowledge. The Oracle never invents SOTA — it cites what it found.

5. **Rolling window for outcomes.** Recent decisions matter more than old ones. Keep ~50 entries, summarize patterns from older entries before pruning. Memory stays current.

6. **Taste is human-authored.** The Oracle learns domain expertise and decision patterns autonomously, but taste comes from you. It's the one file that stays under human control — your opinions, your preferences, your call.

7. **Memory directory is separate from checkpoints.** `.garyclaw/oracle-memory/` persists across jobs and projects. It's the Oracle's brain, not tied to any single run.

---

## Verification

### Phase 5a
- Oracle prompt includes memory file contents
- "Other" responses parse correctly and route through `canUseTool`
- Empty memory files don't break anything (graceful degradation)
- Memory size budget enforcement works

### Phase 5b
- Reflection runs after job completion
- `decision-outcomes.md` grows with each job
- Rolling window prunes entries beyond ~50
- Reflection has Write access only to oracle-memory directory

### Phase 5c
- `garyclaw research "autonomous agents"` populates domain-expertise.md
- Research uses web search (not hallucination)
- Output is structured and within 20K token budget

### Phase 5d
- `garyclaw oracle init` creates directory + templates
- `taste.md` template has clear instructions for the user
- Existing memory is preserved (init is safe to re-run)

---

## Open Questions

1. **Cross-project memory?** Should domain expertise transfer between projects? An agent daemon expert working on GaryClaw probably has useful knowledge for other agent projects. Could have a global `~/.garyclaw/oracle-memory/` plus per-project overlays.

2. **Taste evolution?** Should the Oracle suggest taste.md updates based on observed decision patterns? "You consistently prefer X over Y — should I add this to taste.md?" Risks: Oracle gaming its own preferences.

3. **Research freshness?** How often should domain expertise be refreshed? Weekly? On-demand only? Stale research is worse than no research if the field moves fast.

4. **Memory conflicts?** When domain expertise says "X is SOTA" but decision outcomes show "X failed for us", which wins? Probably outcomes — local evidence trumps general knowledge. But worth making this explicit in the principles.
