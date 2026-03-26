---
status: ACTIVE
---
# Design: Git Worktree Isolation for Parallel Daemons

Generated 2026-03-26

## Problem

Parallel daemon instances share a single git working directory. When two instances modify files simultaneously — one implementing a feature while another fixes QA bugs — they corrupt each other's work. The git index is a shared mutable resource: concurrent `git add` + `git commit` sequences produce merge conflicts, lost writes, or corrupted index state.

This makes parallel daemons useful only in a read-write/read-only split (one builder, one reviewer). The full value of parallel daemons — two builders working on different features simultaneously — is blocked.

## Solution

Each named daemon instance operates in its own **git worktree** — a first-class git feature designed for exactly this use case. Worktrees share the repository's object store and ref database but have independent working directories, staging areas, and HEAD pointers. Commits made in one worktree are immediately visible to others through shared refs.

```
my-project/                          # Main worktree (default instance)
  .garyclaw/
    worktrees/
      builder/                       # Instance "builder" worktree
        .garyclaw-instance → ../../  # Symlink back to parent .garyclaw
      reviewer/                      # Instance "reviewer" worktree
        .garyclaw-instance → ../../
    daemons/
      default/                       # Uses main worktree
      builder/                       # Uses builder worktree
      reviewer/                      # Uses reviewer worktree
```

### Lifecycle

```
daemon start --name builder
  │
  ├── 1. Create branch: garyclaw/builder (from current HEAD)
  ├── 2. Create worktree: git worktree add .garyclaw/worktrees/builder garyclaw/builder
  ├── 3. Set instance projectDir → .garyclaw/worktrees/builder/
  ├── 4. Start daemon process (jobs run in worktree, not main repo)
  │
  │   [instance runs jobs, makes commits on garyclaw/builder branch]
  │
  ├── 5. Job completes → branch has N commits ahead of main
  ├── 6. Merge strategy: fast-forward to main if clean, else leave branch for review
  │
daemon stop --name builder
  │
  ├── 7. Graceful shutdown (existing behavior)
  ├── 8. Optionally prune worktree: git worktree remove .garyclaw/worktrees/builder
  └── 9. Branch remains for manual review if not merged
```

### Branch Strategy

Each instance works on a dedicated branch named `garyclaw/{instance-name}`:

- `garyclaw/builder` — commits from the builder instance
- `garyclaw/reviewer` — commits from the reviewer instance (if it makes any)
- `main` (or whatever the base branch is) — untouched during parallel work

**Why branches, not detached HEAD:** Branches are visible in `git log --all`, can be pushed to remotes, and can be reviewed as PRs. Detached HEAD commits are easily lost.

**Branch creation:** On instance start, create from current HEAD of the base branch. If the branch already exists (from a previous run), reset it to current HEAD to start fresh. This prevents stale branches from accumulating drift.

**Merge after job completion:** After each job (not each skill — the full pipeline), attempt a fast-forward merge to the base branch:

```
1. git checkout main                    (in main worktree, not instance worktree)
2. git merge --ff-only garyclaw/builder
3. If fast-forward succeeds → clean merge, branch is now part of main
4. If fast-forward fails → branch has diverged (another instance committed to main)
   → Leave branch unmerged, notify user: "builder branch has N commits, needs manual merge"
   → The branch is NOT deleted — user can review and merge manually
```

Fast-forward-only is critical: it guarantees that merging never creates merge commits, never resolves conflicts automatically (which could be wrong), and never rewrites history. If it can't fast-forward, it stops and asks the human.

### The Default Instance

The `default` instance (no `--name` flag) does NOT use a worktree. It works directly on the main working directory, exactly like today. This preserves backward compatibility:

```
garyclaw daemon start              # default: works on main repo directly
garyclaw daemon start --name bot   # named: gets a worktree
```

This is the right trade-off: single-instance users see zero behavior change. Multi-instance users explicitly opt into worktree isolation by using `--name`.

### What the SDK Session Sees

The key change: when an instance has a worktree, `GaryClawConfig.projectDir` points to the **worktree path**, not the original repo. The SDK session's `cwd` is set to the worktree. From Claude's perspective inside the session, it's working in a normal git repo — `git status`, `git commit`, `git log` all work normally. The worktree is transparent.

```typescript
// In job-runner.ts buildGaryClawConfig():
const projectDir = instance.worktreePath ?? config.projectDir;
```

### Conflict Between Instances

Two instances can NEVER conflict on files because they have separate working directories. But they CAN create divergent branches:

```
main:     A ── B
                ├── C ── D          (garyclaw/builder)
                └── E ── F          (garyclaw/reviewer)
```

In this case:
1. Builder finishes first → fast-forward merge to main succeeds: `main = A-B-C-D`
2. Reviewer finishes → fast-forward merge FAILS (main has moved past B)
3. Reviewer's branch `garyclaw/reviewer` is left for manual merge
4. Notification: "reviewer branch E-F needs rebase onto main"

This is the same workflow as two developers working on feature branches — a solved problem.

### Worktree + Relay Interaction

GaryClaw's relay mechanism uses `git stash` to save in-progress work during context handoff. In a worktree, `git stash` is worktree-specific (since git 2.38). Each instance's stash is independent. No changes needed to the relay system.

### Worktree + Checkpoint Interaction

Checkpoints are written to the instance's checkpoint directory (`.garyclaw/daemons/{name}/`), not to the worktree. The worktree only contains the project's source code. No changes needed to the checkpoint system.

### Worktree + Oracle Memory Interaction

Oracle memory files live in `.garyclaw/oracle-memory/` in the main repo directory, NOT in the worktree. All instances share oracle memory (with the reflection lock preventing concurrent writes). The `OracleMemoryConfig.projectDir` should point to the main repo's `.garyclaw/`, not the worktree's.

## New Code

### `src/worktree.ts` (~120 lines)

All git worktree operations isolated in one module. Uses `execFileSync` exclusively (no shell injection).

```typescript
export interface WorktreeInfo {
  path: string;           // Absolute path to worktree directory
  branch: string;         // Branch name (e.g., "garyclaw/builder")
  head: string;           // Current HEAD SHA
}

// Create a worktree for a daemon instance.
// Branch is created from baseBranch HEAD. If branch exists, reset to baseBranch HEAD.
export function createWorktree(
  repoDir: string,
  instanceName: string,
  baseBranch: string,
): WorktreeInfo

// Remove a worktree and optionally delete its branch.
export function removeWorktree(
  repoDir: string,
  instanceName: string,
  deleteBranch?: boolean,
): void

// Attempt fast-forward merge of instance branch into base branch.
// Returns { merged: true } or { merged: false, reason: string }.
export function mergeWorktreeBranch(
  repoDir: string,
  instanceName: string,
  baseBranch: string,
): { merged: boolean; reason?: string; commitCount?: number }

// List all active worktrees for this repo.
export function listWorktrees(repoDir: string): WorktreeInfo[]

// Get the worktree path for an instance (null if no worktree).
export function getWorktreePath(repoDir: string, instanceName: string): string | null

// Resolve the base branch (main, master, or current branch).
export function resolveBaseBranch(repoDir: string): string

// Internal: worktree directory path convention
export function worktreeDir(repoDir: string, instanceName: string): string
// Returns: {repoDir}/.garyclaw/worktrees/{instanceName}
```

### Modified files

#### `src/daemon.ts` (~25 lines changed)

In `startDaemon()`:
- After resolving instance name, if name !== "default", call `createWorktree()`
- Store worktree path on the daemon context
- Pass worktree path through to job runner config
- On shutdown, attempt `mergeWorktreeBranch()` and notify on result
- Do NOT auto-remove the worktree on stop (user may want to inspect)

#### `src/job-runner.ts` (~5 lines changed)

In `buildGaryClawConfig()`:
- If instance has a worktree path, use it as `projectDir`
- Oracle memory config still points to main repo's `.garyclaw/`

#### `src/cli.ts` (~20 lines changed)

- `daemon start --name X` — shows worktree path in startup output
- `daemon stop --name X` — shows merge result (merged / needs manual merge)
- `daemon stop --name X --cleanup` — removes worktree + branch after stop
- `daemon list` — shows worktree path and branch for each instance

#### `src/types.ts` (~3 lines)

- Add `worktreePath?: string` to `DaemonConfig` or the daemon context

### `test/worktree.test.ts` (~25 tests)

| Group | Tests | Scenarios |
|-------|-------|-----------|
| `createWorktree` | 5 | Fresh create, branch already exists (reset), worktree already exists, invalid repo, base branch detection |
| `removeWorktree` | 4 | Clean remove, remove with branch delete, remove nonexistent (no-op), remove with uncommitted changes |
| `mergeWorktreeBranch` | 6 | Fast-forward success, diverged (fails), no commits (no-op), branch doesn't exist, merge after multiple commits, already up to date |
| `listWorktrees` | 3 | No worktrees, one worktree, multiple worktrees |
| `getWorktreePath` | 3 | Exists, doesn't exist, default instance returns null |
| `resolveBaseBranch` | 4 | main exists, master exists, neither (uses current), detached HEAD |

## Implementation Order

1. `src/worktree.ts` — core module with all git worktree operations
2. `test/worktree.test.ts` — full test coverage (these tests need a real git repo, use temp dirs with `git init`)
3. `src/types.ts` — add `worktreePath` field
4. `src/daemon.ts` — create worktree on named instance start, merge on stop
5. `src/job-runner.ts` — use worktree path as projectDir for named instances
6. `src/cli.ts` — show worktree info in start/stop/list output
7. `npm test` — verify all tests pass
8. CLAUDE.md — update docs

## Verification

1. `npm test` — all existing + ~25 new tests pass
2. Manual test: two parallel instances
   ```bash
   garyclaw daemon start --name builder
   garyclaw daemon start --name reviewer
   garyclaw daemon trigger --name builder implement qa --design-doc docs/designs/some-feature.md
   garyclaw daemon trigger --name reviewer plan-eng-review
   garyclaw daemon list   # shows both with worktree paths
   # Wait for both to complete
   garyclaw daemon stop --name reviewer
   garyclaw daemon stop --name builder  # shows "merged 5 commits to main"
   ```
3. Verify git log shows commits from both instances merged cleanly
4. Verify no file conflicts occurred during parallel execution

## What This Does NOT Solve

- **Semantic conflicts.** Two instances could both modify the same function on different branches. Git won't detect this as a conflict if the edits are on different lines. The eng-review + QA pipeline catches these after merge.
- **Dependency conflicts.** If builder adds a new dependency and reviewer removes an old one, the merged package.json could be inconsistent. Again, QA catches this post-merge.
- **Auto-rebase.** When fast-forward fails, we don't automatically rebase. The user decides. This is intentional — automatic rebasing of AI-generated code could silently break things.

These are all "merge review" problems that humans deal with daily. The worktree system gives parallel daemons the same workflow that parallel developers already use.
