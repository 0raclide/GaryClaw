/**
 * File-Level Conflict Prevention — predict which files a TODO will modify
 * and check for overlap with files claimed by other parallel daemon instances.
 *
 * Three pure functions:
 * 1. extractPredictedFiles — regex extraction of file paths from TODO/design doc text
 * 2. expandWithDependencies — expand predicted files using a module dependency map
 * 3. hasFileOverlap — set intersection to detect conflicting files
 */

import { basename } from "node:path";

// ── Types ─────────────────────────────────────────────────────────

export interface FileDependencyMap {
  [file: string]: string[];  // file basename -> co-modified files
}

export interface FileOverlapResult {
  overlaps: boolean;
  conflictingFiles: string[];
}

// ── Default dependency map ────────────────────────────────────────

/**
 * Default module dependency map derived from 2026-03-29 overnight run analysis.
 * Maps file basenames to their known co-modification targets.
 *
 * When a TODO mentions oracle.ts, the system also claims types.ts and
 * oracle-memory.ts because they're known co-modification targets.
 */
export const DEFAULT_FILE_DEPS: FileDependencyMap = {
  "oracle.ts": ["types.ts", "oracle-memory.ts"],
  "oracle-memory.ts": ["types.ts", "oracle.ts"],
  "dashboard.ts": ["types.ts"],
  "job-runner.ts": ["types.ts", "daemon-registry.ts"],
  "daemon.ts": ["types.ts", "daemon-registry.ts"],
  "pipeline.ts": ["types.ts"],
  "orchestrator.ts": ["types.ts", "token-monitor.ts"],
  "evaluate.ts": ["types.ts"],
  "bootstrap.ts": ["types.ts"],
  "worktree.ts": ["types.ts"],
  "daemon-registry.ts": ["types.ts"],
  "prioritize.ts": ["types.ts"],
  "implement.ts": ["types.ts"],
};

// ── File path extraction patterns ─────────────────────────────────

/**
 * Match file paths that look like TypeScript/JavaScript source files.
 * Handles:
 * - Backtick-wrapped: `oracle.ts`, `src/job-runner.ts`
 * - Bare paths: src/oracle.ts, test/oracle.test.ts
 * - In **Files:** or **Implementation notes:** sections
 */
const BACKTICK_FILE_PATTERN = /`([a-zA-Z0-9_./-]+\.(?:ts|js|tsx|jsx|json|md))`/g;
const BARE_FILE_PATTERN = /(?:^|\s)((?:src|test|lib|docs)\/[a-zA-Z0-9_./-]+\.(?:ts|js|tsx|jsx|json|md))(?:\s|$|,|;)/gm;

/**
 * Extract predicted file paths from TODO description and optional design doc content.
 *
 * Returns a deduplicated array of file basenames (e.g., ["oracle.ts", "types.ts"]).
 * Uses basenames to avoid path format inconsistencies (src/oracle.ts vs oracle.ts).
 *
 * Returns empty array if no file paths are detected (fail-open behavior).
 */
export function extractPredictedFiles(
  todoDescription: string,
  designDocContent?: string,
): string[] {
  const files = new Set<string>();
  const texts = [todoDescription];
  if (designDocContent) texts.push(designDocContent);

  for (const text of texts) {
    // Backtick-wrapped file references
    let match: RegExpExecArray | null;
    const backtickRe = new RegExp(BACKTICK_FILE_PATTERN.source, "g");
    while ((match = backtickRe.exec(text)) !== null) {
      files.add(basename(match[1]));
    }

    // Bare paths with directory prefix (src/, test/, lib/, docs/)
    const bareRe = new RegExp(BARE_FILE_PATTERN.source, "gm");
    while ((match = bareRe.exec(text)) !== null) {
      files.add(basename(match[1]));
    }
  }

  return [...files];
}

/**
 * Expand a list of predicted files using a module dependency map.
 *
 * Single-level expansion only (not transitive). If oracle.ts maps to
 * [types.ts, oracle-memory.ts], the expanded set includes all three.
 * Unknown files are passed through unchanged.
 *
 * Returns a deduplicated array.
 */
export function expandWithDependencies(
  files: string[],
  depMap: FileDependencyMap,
): string[] {
  const expanded = new Set<string>(files);

  for (const file of files) {
    const deps = depMap[file];
    if (deps) {
      for (const dep of deps) {
        expanded.add(dep);
      }
    }
  }

  return [...expanded];
}

/**
 * Check if two file sets have any overlap.
 *
 * Returns which specific files conflict (for logging/observability).
 */
export function hasFileOverlap(
  predictedFiles: string[],
  claimedFiles: string[],
): FileOverlapResult {
  const claimedSet = new Set(claimedFiles);
  const conflictingFiles: string[] = [];

  for (const file of predictedFiles) {
    if (claimedSet.has(file)) {
      conflictingFiles.push(file);
    }
  }

  return {
    overlaps: conflictingFiles.length > 0,
    conflictingFiles,
  };
}
