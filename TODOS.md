# TODOS

## P2: Daemon Mode (Phase 4)

**What:** Persistent background process that watches for triggers (new commits, deploy events, schedules) and auto-runs skills.

**Why:** The 10x vision — "push code, go to sleep, wake up to results." Transforms GaryClaw from a tool you invoke into a tool that works for you.

**Pros:** Maximum autonomy. Enables the full "tireless junior engineer" vision.

**Cons:** Significant complexity — daemon lifecycle, process manager, trigger system, scheduling, resource management, cost limits.

**Context:** Accepted as deferred scope during CEO review (2026-03-25, SCOPE EXPANSION mode). Requires Phases 1-3 completed first. Architecture is designed to support it — the Orchestrator → Session Runner → Checkpoint Manager pipeline is reusable. Key design questions: what trigger system? (file watcher, git hooks, cron) What resource limits? (max concurrent skills, cost ceiling per day)

**Effort:** L (human: ~2 weeks / CC: ~4 hours)
**Depends on:** Phase 1 (relay), Phase 2 (oracle), Phase 3 (chaining)
**Added by:** /plan-ceo-review on 2026-03-25

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
