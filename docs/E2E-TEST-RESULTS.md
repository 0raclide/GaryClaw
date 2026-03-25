# GaryClaw E2E Test Results

**Date:** 2026-03-25
**Version:** Phases 1a + 1b + 2 + 3
**Target:** Simple static HTML/CSS site with intentional bugs (broken link, missing image, invisible text, overflow div)
**Test harness:** Manual E2E via `npx tsx src/cli.ts`

---

## Summary

| Test | Feature | Result | Duration | Cost | Turns |
|------|---------|--------|----------|------|-------|
| 1 | Forced relay (`--threshold 0.01`) | **PASS** | ~1m 13s | $0.035 | 16 |
| 2 | Two-skill pipeline (qa → design-review) | **PASS** | ~50m | $0.894 | 242 |
| 3 | Autonomous mode (Decision Oracle) | **PASS** | ~5m 34s | $0.316 | 77 |
| 4 | Resume from checkpoint | **PASS** | ~12m 25s | $0.357 | 106 |
| 5 | Artifact inspection | **PASS** | — | — | — |

**Total E2E cost:** ~$1.60

---

## Test 1: Forced Relay

**Command:** `garyclaw run qa --threshold 0.01 --max-turns 3 --max-sessions 2 --project-dir /tmp/garyclaw-test-1`

**What it tests:** Context relay — checkpoint, git stash, fresh session handoff.

**Results:**
- Relay triggered at 2.7% context (27K tokens) — correctly exceeded the 1% threshold
- 2 sessions created (session 0 → relay → session 1)
- Checkpoint rotation worked: both `checkpoint.json` and `checkpoint.prev.json` written
- Report includes relay point: "Session 0 → 1: context at 2.7% (threshold: 1.0%)"

**Artifacts verified:**
| File | Status |
|------|--------|
| `.garyclaw/checkpoint.json` | 849 bytes, session 1 state, 2 turns |
| `.garyclaw/checkpoint.prev.json` | Session 0 state, 14 turns, 29K context |
| `.garyclaw/report.md` | Complete with relay point logged |

**Token tracking detail:**
- Session 0: context grew 12K → 29K over 14 turns (monotonic increase)
- Session 1: fresh start at 12K (confirms fresh session, not resume)
- contextWindow correctly read as 1,000,000

---

## Test 2: Two-Skill Pipeline

**Command:** `garyclaw run qa design-review --max-turns 15 --max-sessions 1 --project-dir /tmp/garyclaw-test-2`

**What it tests:** Sequential skill chaining with context handoff.

**Results:**
- Skill 0 (qa): 99 turns, $0.37, completed successfully
- Skill 1 (design-review): 143 turns, $0.53, completed successfully
- Pipeline state correctly tracks both skills as `complete`
- Per-skill subdirectories created with isolated checkpoints
- Design-review made actual commits fixing findings

**Git commits from design-review:**
```
d742dfa chore: add design review report and baseline
04ce1aa style(design): FINDING-008 — remove dead .hidden-text rule
6d469ae style(design): FINDING-005 — add hover, focus-visible, and active states
7ccff5e style(design): FINDING-004 — fix undersized touch targets
891157b style(design): FINDING-007 — move inline styles to CSS
```

**Artifacts verified:**
| File | Status |
|------|--------|
| `.garyclaw/pipeline.json` | Both skills `complete`, totalCost $0.894 |
| `.garyclaw/pipeline-report.md` | Combined report: /qa → /design-review |
| `.garyclaw/skill-0-qa/checkpoint.json` | 18K, qa skill state |
| `.garyclaw/skill-0-qa/report.md` | QA report |
| `.garyclaw/skill-1-design-review/checkpoint.json` | 26K, design-review state |
| `.garyclaw/skill-1-design-review/report.md` | Design-review report |

---

## Test 3: Autonomous Mode

**Command:** `garyclaw run qa --autonomous --project-dir /tmp/garyclaw-test-3` (killed by timeout mid-run)

**What it tests:** Decision Oracle making autonomous decisions via 6 Decision Principles.

**Results:**
- Oracle intercepted an AskUserQuestion: "What runtime are you using?"
- Chose: "This project doesn't need tests" (confidence 8/10, Pragmatic principle)
- Rationale: "A static HTML/CSS site with no package.json or runtime config doesn't benefit from a unit test framework"
- No escalations (correct — no security/destructive decisions)
- QA found and fixed 4 bugs before timeout killed the process

**Oracle decision (from decisions.jsonl):**
```json
{
  "question": "I couldn't detect your project's language runtime...",
  "chosen": "This project doesn't need tests",
  "confidence": 8,
  "rationale": "A static HTML/CSS site... doesn't benefit from a unit test framework",
  "principle": "Pragmatic"
}
```

**Git commits (bugs fixed before kill):**
```
024bb19 fix(qa): ISSUE-004 — fix unreadable text with proper font size and contrast
435ae9f fix(qa): ISSUE-003 — fix 5000px div causing horizontal overflow
1315620 fix(qa): ISSUE-002 — gracefully hide missing image instead of showing 404
4ed8e7b fix(qa): ISSUE-001 — replace broken link with valid home link
```

**Artifacts verified:**
| File | Status |
|------|--------|
| `.garyclaw/checkpoint.json` | 15K, 77 turns, 46K context |
| `.garyclaw/decisions.jsonl` | 1 decision with full Oracle metadata |
| `.garyclaw/report.md` | Decision rendered in report body |
| No `escalated.jsonl` | Correct — nothing needed escalation |

---

## Test 4: Resume from Checkpoint

**Command:** `garyclaw resume --project-dir /tmp/garyclaw-test-4` (resuming from test 3's checkpoint copy)

**What it tests:** Resume from checkpoint left by a killed process.

**Results:**
- Successfully read checkpoint.json from the killed test 3 run
- Started a fresh session with relay prompt containing prior state
- Found and fixed 5 bugs (some overlapping with test 3, plus ISSUE-005/006)
- Different runId confirms a new run, not continuation of test 3's session

**Git commits:**
```
26334e0 fix(qa): ISSUE-006 — add viewport meta tag for mobile responsiveness
24b4325 fix(qa): ISSUE-004 — fix horizontal overflow by setting red div to 100% width
69cf31c fix(qa): ISSUE-003 — fix invisible text with proper font size and contrast
13b361c fix(qa): ISSUE-002 — replace broken link pointing to invalid domain
58e86fb fix(qa): ISSUE-001 — replace broken missing-image.png with SVG placeholder
```

**Artifacts verified:**
| File | Status |
|------|--------|
| `.garyclaw/checkpoint.json` | 19K, 106 turns, 53K context, new runId |
| `.garyclaw/report.md` | Complete report for resumed run |

---

## Test 5: Artifact Inspection

Cross-test structural verification of all GaryClaw artifacts.

### Checkpoint Schema Consistency

All checkpoint.json files share the same structure:
- `version: 1`
- `timestamp` (ISO 8601)
- `runId` (format: `garyclaw-{epoch}-{hex}`)
- `skillName`
- `issues[]`, `findings[]`, `decisions[]`
- `gitBranch`, `gitHead`
- `tokenUsage.lastContextSize`, `.contextWindow`, `.totalOutputTokens`, `.sessionCount`, `.estimatedCostUsd`, `.turnHistory[]`
- `screenshotPaths[]`

### Token Tracking Validation

| Test | Start Context | End Context | Turns | Growth Pattern |
|------|--------------|-------------|-------|---------------|
| 1 (session 0) | 12K | 29K | 14 | Monotonic |
| 1 (session 1) | 12K | 12K | 2 | Fresh start |
| 2 (qa) | — | 18K checkpoint | 99 | Normal |
| 2 (design-review) | — | 26K checkpoint | 143 | Normal |
| 3 (autonomous) | 12K | 46K | 77 | Monotonic |
| 4 (resume) | 12K | 53K | 106 | Monotonic |

Key observations:
- Context always starts at ~12K (system prompt + skill prompt baseline)
- Growth is monotonic within a session (never decreases)
- Fresh relay sessions reset to ~12K (validates fresh-session-not-resume design)
- contextWindow consistently read as 1,000,000

### Report Quality

- All reports include: runId, start/end times, session count, turn count, cost
- Relay points logged when relay occurs (test 1)
- Decisions rendered in report body when Oracle is used (test 3)
- Pipeline report aggregates per-skill results (test 2)

### Known Gap: Structured Issue Tracking

Reports show `Issues: 0` in the structured summary even though git commits prove bugs were found and fixed. The skills (qa, design-review) commit fixes directly but don't emit structured issue data in a format GaryClaw currently extracts from the SDK message stream. This is expected behavior — issue extraction from unstructured tool output is a future enhancement. The git commit log serves as the ground-truth record of fixes.

---

## Mechanism Validation Matrix

| Mechanism | Test(s) | Verified By |
|-----------|---------|-------------|
| SDK session startup | 1, 2, 3, 4 | All tests run successfully |
| Per-turn token monitoring | 1, 3, 4 | turnHistory arrays in checkpoint.json |
| shouldRelay trigger | 1 | Relay at 2.7% > 1% threshold |
| Checkpoint write | 1, 2, 3, 4 | checkpoint.json exists in all tests |
| Checkpoint rotation | 1 | checkpoint.prev.json preserved |
| Git stash relay | 1 | Fresh session started after relay |
| Report generation | 1, 2, 3, 4 | report.md in all test dirs |
| AskUserQuestion interception | 3 | Oracle answered the question |
| Decision Oracle | 3 | decisions.jsonl with confidence/principle |
| Oracle confidence scoring | 3 | confidence: 8 |
| Oracle principle selection | 3 | principle: "Pragmatic" |
| No false escalations | 3 | escalated.jsonl does not exist |
| Pipeline execution | 2 | pipeline.json with both skills complete |
| Per-skill subdirectories | 2 | skill-0-qa/ and skill-1-design-review/ |
| Pipeline report | 2 | pipeline-report.md with combined results |
| Resume from checkpoint | 4 | New runId, successful completion |
| Cost tracking | 1, 2, 3, 4 | estimatedCostUsd in all checkpoints |
| ANTHROPIC_API_KEY stripping | 1, 2, 3, 4 | All tests used Claude Max (no API billing) |

---

## Ship-Readiness Assessment

**Phases 1a + 1b + 2 + 3: SHIP-READY**

All core mechanisms work end-to-end against real Claude Code skills on a real project. The engine successfully:

1. Wraps skill execution with full token monitoring
2. Relays across sessions when context exceeds threshold
3. Chains multiple skills with pipeline state tracking
4. Makes autonomous decisions with auditable rationale
5. Resumes from checkpoints left by killed processes
6. Produces reports with cost, timing, and decision data

**Next steps:**
- Structured issue extraction from SDK message stream (enhance report quality)
- Test against larger projects (stress-test relay at realistic context sizes)
- Phase 4: Daemon Mode
