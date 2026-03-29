/**
 * TODO State Tracking — persistent lifecycle state for TODO items.
 *
 * Tracks which pipeline stage each TODO item has reached, so parallel
 * daemon instances never re-run completed stages. State files live at
 * `.garyclaw/todo-state/{slug}.json` and survive instance cleanup.
 *
 * Three layers of truth:
 * 1. State files (System B) — written after each skill completion
 * 2. Artifact detection (System A) — git branches, design docs, commits on main
 * 3. Reconciliation — merges B + A with self-healing rules
 */

import { join } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import { normalizedLevenshtein } from "./reflection.js";
import { execFileSync } from "node:child_process";
import { safeReadJSON, safeWriteJSON, safeReadText, safeWriteText } from "./safe-json.js";
import { readPidFile, isPidAlive } from "./pid-utils.js";

// ── Types ────────────────────────────────────────────────────────

export type TodoLifecycleState =
  | "open"
  | "designed"
  | "implemented"
  | "reviewed"
  | "qa-complete"
  | "merged"
  | "complete";

export interface TodoState {
  title: string;           // Original title for Levenshtein matching
  slug: string;            // Deterministic slug
  state: TodoLifecycleState;
  designDocPath?: string;  // Path to design doc in docs/designs/
  branch?: string;         // Branch with implementation code
  instanceName?: string;   // Last instance that worked on this
  lastJobId?: string;      // Last job ID that advanced the state
  updatedAt: string;       // ISO timestamp
}

export interface DetectedArtifacts {
  designDoc?: string;        // Path if found in docs/designs/
  branchExists: boolean;     // Branch garyclaw/* or matching slug
  branchCommitCount: number; // Commits ahead of main
  commitsOnMain: boolean;    // Matching commits merged to main
}

// ── Constants ────────────────────────────────────────────────────

const TODO_STATE_DIR = "todo-state";
const MAX_SLUG_LENGTH = 80;
const LEVENSHTEIN_THRESHOLD = 0.3;
const STALE_HOURS = 2;

const STOPWORDS = new Set([
  "the", "a", "an", "for", "and", "or", "in", "of", "to", "with",
]);

const LIFECYCLE_ORDER: TodoLifecycleState[] = [
  "open", "designed", "implemented", "reviewed", "qa-complete", "merged", "complete",
];

/** Maps skill names to the lifecycle state they produce on completion. */
export const SKILL_TO_STATE: Record<string, TodoLifecycleState> = {
  "office-hours": "designed",
  "implement":    "implemented",
  "plan-eng-review": "reviewed",
  "qa":           "qa-complete",
};

/**
 * Pipeline lifecycle order for findNextSkill().
 * Maps skill names to their position in the canonical pipeline.
 */
export const PIPELINE_LIFECYCLE_ORDER = [
  "prioritize", "office-hours", "implement", "plan-eng-review", "qa",
];

// ── Slugify ──────────────────────────────────────────────────────

/**
 * Pure, deterministic slug generation from a TODO title.
 *
 * Rules:
 * 1. Lowercase
 * 2. Replace non-alphanumeric with hyphens
 * 3. Collapse multiple hyphens
 * 4. Trim leading/trailing hyphens
 * 5. Truncate to 80 chars (at word boundary)
 */
export function slugify(title: string): string {
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (slug.length > MAX_SLUG_LENGTH) {
    // Truncate at word boundary (last hyphen before limit)
    const truncated = slug.slice(0, MAX_SLUG_LENGTH);
    const lastHyphen = truncated.lastIndexOf("-");
    slug = lastHyphen > 0 ? truncated.slice(0, lastHyphen) : truncated;
  }

  return slug;
}

// ── State file I/O ───────────────────────────────────────────────

function stateDir(checkpointDir: string): string {
  return join(checkpointDir, TODO_STATE_DIR);
}

function statePath(checkpointDir: string, slug: string): string {
  return join(stateDir(checkpointDir), `${slug}.json`);
}

function validateTodoState(data: unknown): data is TodoState {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.title === "string" &&
    typeof d.slug === "string" &&
    typeof d.state === "string" &&
    LIFECYCLE_ORDER.includes(d.state as TodoLifecycleState) &&
    typeof d.updatedAt === "string"
  );
}

/**
 * Read a TODO state file by slug. Returns null if missing or corrupt.
 */
export function readTodoState(checkpointDir: string, slug: string): TodoState | null {
  return safeReadJSON<TodoState>(statePath(checkpointDir, slug), validateTodoState);
}

/**
 * Write a TODO state file atomically.
 */
export function writeTodoState(checkpointDir: string, slug: string, state: TodoState): void {
  safeWriteJSON(statePath(checkpointDir, slug), state);
}

// ── Find state by title ──────────────────────────────────────────

/**
 * Find a TODO state by title. Tries exact slug match first,
 * then falls back to Levenshtein matching across all state files.
 */
export function findTodoState(checkpointDir: string, title: string): TodoState | null {
  // 1. Exact slug match
  const slug = slugify(title);
  const exact = readTodoState(checkpointDir, slug);
  if (exact) return exact;

  // 2. Levenshtein fallback: scan all state files
  const dir = stateDir(checkpointDir);
  if (!existsSync(dir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(dir).filter(f => f.endsWith(".json"));
  } catch {
    return null;
  }

  let bestMatch: TodoState | null = null;
  let bestDistance = Infinity;

  for (const file of entries) {
    const filePath = join(dir, file);
    const state = safeReadJSON<TodoState>(filePath, validateTodoState);
    if (!state) continue;

    const distance = normalizedLevenshtein(title, state.title);
    if (distance < LEVENSHTEIN_THRESHOLD && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = state;
    }
  }

  return bestMatch;
}

// ── Artifact detection ───────────────────────────────────────────

/**
 * Extract non-stopword keywords from a title for fuzzy matching.
 */
function extractKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Detect artifacts (design docs, branches, commits) for a TODO item.
 * Scans git state and docs/designs/ to infer how far along the item is.
 */
export function detectArtifacts(
  projectDir: string,
  title: string,
  slug: string,
): DetectedArtifacts {
  const result: DetectedArtifacts = {
    branchExists: false,
    branchCommitCount: 0,
    commitsOnMain: false,
  };

  const keywords = extractKeywords(title);

  // 1. Design docs in docs/designs/
  try {
    const designDir = join(projectDir, "docs", "designs");
    if (existsSync(designDir)) {
      const files = readdirSync(designDir).filter(f => f.endsWith(".md"));

      // Tier 1: slug substring match in filename
      const slugMatch = files.find(f => f.includes(slug) || slug.includes(f.replace(".md", "")));
      if (slugMatch) {
        result.designDoc = join("docs", "designs", slugMatch);
      } else {
        // Tier 2: >= 2 non-stopword title keywords in first 5 lines
        for (const file of files) {
          try {
            const filePath = join(designDir, file);
            const content = execFileSync("head", ["-5", filePath], {
              encoding: "utf-8",
              timeout: 5000,
            }).toLowerCase();
            const matchCount = keywords.filter(kw => content.includes(kw)).length;
            if (matchCount >= 2) {
              result.designDoc = join("docs", "designs", file);
              break;
            }
          } catch { /* skip unreadable files */ }
        }
      }
    }
  } catch { /* docs/designs/ may not exist */ }

  // 2. Git branches matching slug
  try {
    const branches = execFileSync("git", ["branch", "--list", "garyclaw/*"], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 10000,
    }).trim();

    if (branches) {
      const branchList = branches.split("\n").map(b => b.trim().replace(/^\*\s*/, ""));
      const match = branchList.find(b => b.includes(slug));
      if (match) {
        result.branchExists = true;
        // Count commits ahead of main
        try {
          const baseBranch = resolveBaseBranchSafe(projectDir);
          const count = execFileSync(
            "git", ["rev-list", "--count", `${baseBranch}..${match}`],
            { cwd: projectDir, encoding: "utf-8", timeout: 10000 },
          ).trim();
          result.branchCommitCount = parseInt(count, 10) || 0;
        } catch { /* ignore */ }
      }
    }
  } catch { /* git not available or not a repo */ }

  // 3. Commits on main matching slug or keywords
  try {
    const baseBranch = resolveBaseBranchSafe(projectDir);
    const log = execFileSync(
      "git", ["log", "--oneline", "-50", baseBranch],
      { cwd: projectDir, encoding: "utf-8", timeout: 10000 },
    ).trim();

    if (log) {
      const lines = log.split("\n");
      for (const line of lines) {
        const lower = line.toLowerCase();
        // Slug substring match
        if (lower.includes(slug)) {
          result.commitsOnMain = true;
          break;
        }
        // >= 2 non-stopword keyword match in same commit message
        const matchCount = keywords.filter(kw => lower.includes(kw)).length;
        if (matchCount >= 2) {
          result.commitsOnMain = true;
          break;
        }
      }
    }
  } catch { /* git not available or not a repo */ }

  return result;
}

/**
 * Safe base branch resolution — returns "main" if git operations fail.
 */
function resolveBaseBranchSafe(projectDir: string): string {
  try {
    const result = execFileSync(
      "git", ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { cwd: projectDir, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    return result.replace("refs/remotes/origin/", "");
  } catch {
    return "main";
  }
}

// ── Reconciliation ───────────────────────────────────────────────

function lifecycleIndex(state: TodoLifecycleState): number {
  return LIFECYCLE_ORDER.indexOf(state);
}

function isStale(updatedAt: string): boolean {
  const diff = Date.now() - new Date(updatedAt).getTime();
  return diff > STALE_HOURS * 60 * 60 * 1000;
}

/**
 * Infer lifecycle state from detected artifacts alone.
 */
function inferStateFromArtifacts(artifacts: DetectedArtifacts): TodoLifecycleState {
  if (artifacts.commitsOnMain) return "merged";
  if (artifacts.branchExists && artifacts.branchCommitCount > 0) return "implemented";
  if (artifacts.designDoc) return "designed";
  return "open";
}

/**
 * Check if the instance that wrote this state is still alive.
 * Looks up PID from `.garyclaw/daemons/{instanceName}/daemon.pid`.
 */
function isInstanceAlive(
  stored: TodoState,
  checkpointDir: string,
): boolean {
  if (!stored.instanceName) return false;
  const pidPath = join(checkpointDir, "daemons", stored.instanceName, "daemon.pid");
  const pid = readPidFile(pidPath);
  if (pid === null) return false;
  return isPidAlive(pid, "node").alive;
}

/**
 * Reconcile stored state with detected artifacts.
 * Self-healing: promotes state when artifacts show more progress,
 * trusts stored state for recent entries, resets stale stuck states.
 */
export function reconcileState(
  stored: TodoState | null,
  artifacts: DetectedArtifacts,
  checkpointDir?: string,
): TodoState {
  const artifactState = inferStateFromArtifacts(artifacts);
  const artifactIdx = lifecycleIndex(artifactState);

  // No stored state — create from artifacts
  if (!stored) {
    return {
      title: "",   // caller must set title
      slug: "",    // caller must set slug
      state: artifactState,
      designDocPath: artifacts.designDoc,
      updatedAt: new Date().toISOString(),
    };
  }

  const storedIdx = lifecycleIndex(stored.state);

  // Artifacts show MORE advanced state → promote (evidence trumps records)
  if (artifactIdx > storedIdx) {
    return {
      ...stored,
      state: artifactState,
      designDocPath: artifacts.designDoc ?? stored.designDocPath,
      updatedAt: new Date().toISOString(),
    };
  }

  // Artifacts show LESS advanced or equal — check staleness
  if (artifactIdx < storedIdx) {
    // Recent state (<2h) → trust stored (work in progress)
    if (!isStale(stored.updatedAt)) {
      return stored;
    }

    // Stale state: only demote from "open" (no-op anyway)
    if (stored.state === "open") {
      return stored; // demotion from open is meaningless
    }

    // Stale but "implemented" with no branch evidence and instance dead
    if (stored.state === "implemented" && !artifacts.branchExists && !artifacts.commitsOnMain) {
      if (checkpointDir && !isInstanceAlive(stored, checkpointDir)) {
        return {
          ...stored,
          state: "designed",
          updatedAt: new Date().toISOString(),
        };
      }
    }

    // For "designed" or later: trust B but this is a WARNING condition
    // (logged by caller, never demote)
    return stored;
  }

  // Equal state — update designDocPath if artifact detection found one
  if (artifacts.designDoc && !stored.designDocPath) {
    return {
      ...stored,
      designDocPath: artifacts.designDoc,
    };
  }

  return stored;
}

// ── Start skill mapping ──────────────────────────────────────────

/**
 * Determine which skill to start the pipeline at, given current TODO state.
 */
export function getStartSkill(state: TodoState): string {
  switch (state.state) {
    case "open":         return "prioritize";
    case "designed":     return "implement";
    case "implemented":  return "plan-eng-review";
    case "reviewed":     return "qa";
    case "qa-complete":  return "skip";
    case "merged":       return "skip";
    case "complete":     return "skip";
  }
}

/**
 * Find the first pipeline skill at or after the preferred lifecycle position.
 * Handles partial pipelines where the preferred skill isn't in the list.
 */
export function findNextSkill(pipelineSkills: string[], preferredStart: string): number {
  const preferredIdx = PIPELINE_LIFECYCLE_ORDER.indexOf(preferredStart);
  if (preferredIdx === -1) return 0; // unknown skill, start from beginning

  for (let i = 0; i < pipelineSkills.length; i++) {
    const skillIdx = PIPELINE_LIFECYCLE_ORDER.indexOf(pipelineSkills[i]);
    if (skillIdx >= preferredIdx) return i;
  }
  return pipelineSkills.length; // all skills are before preferred, skip all
}

/**
 * Convert a skill name to the lifecycle state it produces on completion.
 * Returns null for skills that don't affect TODO lifecycle (e.g., bootstrap, research).
 */
export function skillToTodoState(skillName: string): TodoLifecycleState | null {
  return SKILL_TO_STATE[skillName] ?? null;
}

// ── Auto-mark TODOS.md ───────────────────────────────────────────

/**
 * Rewrite a TODOS.md heading from open to ~~complete~~.
 * Matches heading by slug comparison (handles minor title edits).
 * Appends a completion summary line below the heading.
 *
 * Returns true if the file was modified, false if title not found or already marked.
 */
export function markTodoCompleteInFile(
  todosPath: string,
  title: string,
  summary: string,
): boolean {
  const content = safeReadText(todosPath);
  if (!content) return false;

  const targetSlug = slugify(title);
  if (!targetSlug) return false;

  const lines = content.split("\n");
  const dateStr = new Date().toISOString().slice(0, 10);
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match ## headings (any depth 2+)
    // COUPLING: parseTodoItems() in prioritize.ts uses /^## P\d/ for the same
    // conceptual operation. Both assume TODOS.md uses ## (not #) for items.
    if (!line.match(/^#{2,}\s/)) continue;

    // Skip already-complete headings (contain ~~)
    if (line.includes("~~")) continue;

    // Extract heading text (strip ## prefix)
    const headingText = line.replace(/^#{2,}\s+/, "").trim();
    const headingSlug = slugify(headingText);

    if (headingSlug === targetSlug) {
      // Rewrite heading: ## P2: Foo Bar → ## ~~P2: Foo Bar~~ — COMPLETE (2026-03-29)
      const prefix = line.match(/^(#{2,}\s+)/)?.[1] ?? "## ";
      lines[i] = `${prefix}~~${headingText}~~ — COMPLETE (${dateStr})`;
      // Insert summary line after heading
      lines.splice(i + 1, 0, "", `${summary}`, "");
      modified = true;
      break;
    }
  }

  if (modified) {
    safeWriteText(todosPath, lines.join("\n"));
  }

  return modified;
}
