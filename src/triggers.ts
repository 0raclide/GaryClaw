/**
 * Triggers — event sources that enqueue daemon jobs.
 *
 * Phase 4a: Git poll trigger (polls HEAD for changes with debounce).
 * Phase 4b will add: Cron trigger.
 */

import { execFileSync } from "node:child_process";
import type { GitPollTrigger } from "./types.js";

export interface GitPoller {
  start(): void;
  stop(): void;
}

export type TriggerCallback = (skills: string[], triggerDetail: string) => void;

export interface GitPollerDeps {
  getHead: (projectDir: string, branch?: string) => string | null;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval: (id: ReturnType<typeof globalThis.setInterval>) => void;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) => void;
}

const defaultDeps: GitPollerDeps = {
  getHead: getGitHead,
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
};

/**
 * Create a git poller that detects HEAD changes on a branch.
 *
 * Polls at `intervalSeconds`, debounces triggers by `debounceSeconds`.
 * Debounce: resets timer on each new HEAD, fires after stable period.
 */
export function createGitPoller(
  config: GitPollTrigger,
  projectDir: string,
  onTrigger: TriggerCallback,
  deps: Partial<GitPollerDeps> = {},
): GitPoller {
  const d = { ...defaultDeps, ...deps };
  const debounceMs = (config.debounceSeconds ?? 30) * 1000;
  const intervalMs = config.intervalSeconds * 1000;

  let lastHead: string | null = null;
  let pollTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  let debounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let pendingHead: string | null = null;

  function poll(): void {
    const head = d.getHead(projectDir, config.branch);
    if (head === null) return; // Failed to read HEAD

    // First poll — just record the current HEAD
    if (lastHead === null) {
      lastHead = head;
      return;
    }

    // No change
    if (head === lastHead) return;

    // HEAD changed — start/restart debounce
    pendingHead = head;

    if (debounceTimer !== null) {
      d.clearTimeout(debounceTimer);
    }

    debounceTimer = d.setTimeout(() => {
      debounceTimer = null;
      if (pendingHead !== null && pendingHead !== lastHead) {
        const detail = `HEAD changed: ${lastHead?.slice(0, 7)} → ${pendingHead.slice(0, 7)}`;
        lastHead = pendingHead;
        pendingHead = null;
        onTrigger(config.skills, detail);
      }
    }, debounceMs);
  }

  return {
    start() {
      // Initial poll to capture baseline
      poll();
      pollTimer = d.setInterval(poll, intervalMs);
    },
    stop() {
      if (pollTimer !== null) {
        d.clearInterval(pollTimer);
        pollTimer = null;
      }
      if (debounceTimer !== null) {
        d.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },
  };
}

/**
 * Get the current HEAD commit hash for a project directory.
 * Optionally checks a specific branch.
 */
export function getGitHead(projectDir: string, branch?: string): string | null {
  try {
    const ref = branch ? `refs/heads/${branch}` : "HEAD";
    return execFileSync("git", ["rev-parse", ref], {
      cwd: projectDir,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
