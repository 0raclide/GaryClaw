---
status: DRAFT
---
# Design: `/implement` — Autonomous Feature Builder

Generated 2026-03-26

## Problem

GaryClaw pipelines can review and QA code autonomously, but cannot implement new features. When a pipeline runs `plan-ceo-review → plan-eng-review → qa`, the `/qa` skill finds and fixes bugs in existing code — it doesn't build new modules from a design doc.

**Observed in production (2026-03-26):** A pipeline with context handoff from two reviews (42 decisions, 9 architecture issues resolved) handed off to `/qa`. Instead of implementing the parallel daemons design, `/qa` scanned for bugs and fixed a `maxJobsPerDay` counting bug. Correct behavior for QA — wrong skill for the job.

The missing piece: a skill that takes a reviewed design doc and builds it.

## Solution

`implement` is a built-in GaryClaw skill (not a gstack skill) that constructs a purpose-built prompt from the pipeline's context handoff. When the pipeline encounters `implement` as a skill name, it:

1. Reads the design doc(s) from the project
2. Incorporates review findings from previous pipeline skills
3. Constructs an implementation prompt with strict rules
4. Executes via the standard orchestrator (gets relay, checkpointing, Oracle for free)

## Why Not a gstack Skill?

gstack skills are generic — `/qa` works on any project. `/implement` is GaryClaw-specific:
- It needs to understand GaryClaw's design doc format and implementation order conventions
- It needs the full review context from the pipeline handoff (issues, decisions, findings)
- It must follow the exact implementation order from the design doc, not improvise
- It should commit one module at a time with tests, matching the project's existing commit style

A prompt constructed at runtime from actual context is more precise than a static SKILL.md.

## Architecture

```
Pipeline: plan-ceo-review → plan-eng-review → implement
                                                  │
                                    ┌──────────────┘
                                    ▼
                        buildImplementPrompt()
                          │
                          ├── Read design doc(s) from docs/designs/
                          ├── Inject review decisions + findings
                          ├── Extract implementation order
                          ├── Add commit rules + test rules
                          │
                          ▼
                    runSkillWithPrompt()
                          │
                          ▼
                    Standard orchestrator
                    (relay, checkpoint, Oracle)
```

### Integration Point

`src/pipeline.ts` line 228-242 — the skill dispatch in `executePipelineFrom()`. Currently:

```typescript
if (prevEntry?.report) {
  const handoffPrompt = buildContextHandoff(prevEntry.skillName, prevEntry.report, skillName);
  await runSkillWithPrompt(skillConfig, callbacks, handoffPrompt);
} else {
  await runSkill(skillConfig, callbacks);
}
```

For `implement`, replace the standard handoff with a richer implementation prompt:

```typescript
if (skillName === "implement") {
  const implPrompt = await buildImplementPrompt(config, prevEntries, state);
  await runSkillWithPrompt(skillConfig, callbacks, implPrompt);
} else if (prevEntry?.report) {
  const handoffPrompt = buildContextHandoff(...);
  await runSkillWithPrompt(skillConfig, callbacks, handoffPrompt);
} else {
  await runSkill(skillConfig, callbacks);
}
```

## The Implementation Prompt

```markdown
You are implementing a reviewed and approved design. Your job is to write the code,
write the tests, and commit each module atomically.

## Design Document
{contents of the most recently modified docs/designs/*.md file}

## Review Findings
{all decisions from CEO + Eng review, formatted as context}

## Architecture Decisions
{key decisions extracted from review — e.g., "Use advisory locking, not file locking"}

## Implementation Order
{extracted from the design doc's "Implementation order" section}

## Rules

1. **Follow the implementation order exactly.** Step 1 first, then step 2, etc.
2. **Types first.** If step 1 is types.ts, start there. All interfaces must compile
   before any module that uses them.
3. **One commit per step.** Each step in the implementation order gets one atomic commit.
   Write the source module + its test file together, then commit both.
4. **Run tests after every commit.** `npm test` must pass before moving to the next step.
   If tests fail, fix them before proceeding.
5. **Commit message format:** `Phase N — description` matching the project's existing style.
6. **Do not modify code outside the design doc's scope.** If you find a bug unrelated to
   the implementation, note it but don't fix it.
7. **Use existing patterns.** Look at how existing modules are structured (types.ts for
   interfaces, dependency injection for testability, vi.fn() for mocks).
8. **Test strategy:** All tests synthetic — mock external dependencies. Follow the pattern
   in existing test files (e.g., test/job-runner.test.ts for dependency injection mocking).
```

### Design Doc Discovery

The prompt needs to find the right design doc. Strategy:

1. Check if any `docs/designs/*.md` file was modified in the last N commits (from the review skills)
2. If multiple, use the one most recently modified
3. If none, look for a design doc referenced in the review decisions
4. Fallback: use the context handoff summary as the implementation spec

### Implementation Order Extraction

Most design docs have an "Implementation order" section with numbered steps. Parse it:

```typescript
function extractImplementationOrder(designDoc: string): string[] {
  // Find the "Implementation order" section
  const match = designDoc.match(/## Implementation [Oo]rder\n([\s\S]*?)(?=\n## |$)/);
  if (!match) return [];
  // Extract numbered items
  return match[1]
    .split("\n")
    .filter(line => /^\d+\./.test(line.trim()))
    .map(line => line.trim());
}
```

## New Code

### `src/implement.ts` (~100 lines)

```typescript
// Build the implementation prompt from design doc + review context
export async function buildImplementPrompt(
  config: GaryClawConfig,
  previousSkills: PipelineSkillEntry[],
  projectDir: string,
): Promise<string>

// Find the most relevant design doc
export function findDesignDoc(projectDir: string): { path: string; content: string } | null

// Extract implementation order from design doc
export function extractImplementationOrder(designDoc: string): string[]

// Format review decisions for the prompt
export function formatReviewContext(skills: PipelineSkillEntry[]): string
```

### Modified: `src/pipeline.ts` (~15 lines changed)

- Import `buildImplementPrompt` from `./implement.js`
- In `executePipelineFrom()`, detect `skillName === "implement"` and use the implementation prompt
- Pass all previous skill entries (not just the last one) so the prompt gets full review context

### New: `test/implement.test.ts` (~25 tests)

| Group | Tests | Scenarios |
|-------|-------|-----------|
| `findDesignDoc` | 5 | No docs dir, empty dir, single doc, multiple docs (most recent wins), non-md files ignored |
| `extractImplementationOrder` | 6 | Standard format, no section, empty section, mixed content, numbered vs bulleted |
| `formatReviewContext` | 5 | No previous skills, one review, two reviews, decisions + findings + issues |
| `buildImplementPrompt` | 9 | Full pipeline context, missing design doc fallback, implementation order injection, review context injection, commit rules present |

## Usage

```bash
# Review then implement
garyclaw run plan-ceo-review plan-eng-review implement --autonomous

# Daemon trigger
garyclaw daemon trigger plan-ceo-review plan-eng-review implement

# Just implement (skip reviews, use existing design doc)
garyclaw run implement --autonomous
```

When `implement` is the first skill (no review context), it still works — it finds the design doc and implements it, just without review guidance.

## What `/implement` Does NOT Do

- **Create PRs** — that's `/ship`'s job. Pipeline: `review → implement → ship`
- **Fix bugs** — that's `/qa`'s job
- **Write design docs** — that's the human's job (or CEO review's output)
- **Make scope decisions** — it follows the design doc exactly. Scope was decided in reviews.

## Verification

1. `npm test` — all existing + ~25 new tests pass
2. Create a small test design doc with 3 implementation steps
3. Run `garyclaw run implement --autonomous --checkpoint-dir .garyclaw-test-impl`
4. Verify: 3 atomic commits created, tests pass after each, code matches design doc
5. Run full pipeline: `garyclaw run plan-ceo-review plan-eng-review implement --autonomous`
6. Verify: review context appears in implement's decisions.jsonl

## Future: Smart Implementation

Once the Creative Oracle ships, `/implement` gets smarter for free:
- Oracle memory includes past implementation patterns (`decision-outcomes.md`)
- Domain expertise informs implementation choices
- Taste preferences guide code style decisions
- If the Oracle chooses "Other" during implementation, it can propose a better approach than what the design doc specified (with justification from memory)

## Files to Create
- `src/implement.ts`
- `test/implement.test.ts`

## Files to Modify
- `src/pipeline.ts` — detect `implement` skill, build implementation prompt
- `src/cli.ts` — document `implement` in usage/help text
- `CLAUDE.md` — add implement to module map and usage docs
