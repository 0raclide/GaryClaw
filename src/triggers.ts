/**
 * Triggers — event sources that enqueue daemon jobs.
 *
 * Phase 4a: Git poll trigger (polls HEAD for changes with debounce).
 * Phase 4b: Cron trigger (time-based scheduling with 5-field cron expressions).
 */

import { execFileSync } from "node:child_process";
import type { GitPollTrigger, CronTrigger } from "./types.js";

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

// ── Cron trigger ──────────────────────────────────────────────────

/**
 * Parsed cron schedule: each field is a sorted array of valid values.
 */
export interface CronSchedule {
  minutes: number[];    // 0-59
  hours: number[];      // 0-23
  daysOfMonth: number[]; // 1-31
  months: number[];     // 1-12
  daysOfWeek: number[]; // 0-6 (0=Sunday)
}

/**
 * Parse a single cron field into an array of matching values.
 * Supports: *, specific numbers, ranges (1-5), steps (*​/15), comma lists (1,15,30).
 */
export function parseCronField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) return null;

    // Step: */N or M-N/S
    const stepMatch = trimmed.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[4], 10);
      if (step <= 0) return null;
      let start = min;
      let end = max;
      if (stepMatch[2] !== undefined && stepMatch[3] !== undefined) {
        start = parseInt(stepMatch[2], 10);
        end = parseInt(stepMatch[3], 10);
      }
      if (start < min || end > max || start > end) return null;
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    // Wildcard
    if (trimmed === "*") {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    // Range: M-N
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < min || end > max || start > end) return null;
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }

    // Specific number
    if (/^\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      if (num < min || num > max) return null;
      values.add(num);
      continue;
    }

    // Unknown format
    return null;
  }

  if (values.size === 0) return null;
  return [...values].sort((a, b) => a - b);
}

/**
 * Parse a 5-field cron expression into a CronSchedule.
 * Returns null if the expression is invalid.
 */
export function parseCronExpression(expr: string): CronSchedule | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const daysOfMonth = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const daysOfWeek = parseCronField(fields[4], 0, 6);

  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

/**
 * Check if a Date matches a CronSchedule.
 */
export function matchesCronSchedule(schedule: CronSchedule, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1; // JS months are 0-indexed
  const dayOfWeek = date.getDay();    // 0=Sunday

  return (
    schedule.minutes.includes(minute) &&
    schedule.hours.includes(hour) &&
    schedule.daysOfMonth.includes(dayOfMonth) &&
    schedule.months.includes(month) &&
    schedule.daysOfWeek.includes(dayOfWeek)
  );
}

export interface CronPollerDeps {
  now: () => Date;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval: (id: ReturnType<typeof globalThis.setInterval>) => void;
}

const defaultCronDeps: CronPollerDeps = {
  now: () => new Date(),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

/**
 * Create a cron poller that fires when the current time matches the cron expression.
 * Checks every 60 seconds. Returns the same start/stop interface as GitPoller.
 *
 * Returns null if the cron expression is invalid.
 */
export function createCronPoller(
  config: CronTrigger,
  onTrigger: TriggerCallback,
  deps: Partial<CronPollerDeps> = {},
): GitPoller | null {
  const schedule = parseCronExpression(config.expression);
  if (!schedule) return null;

  const d = { ...defaultCronDeps, ...deps };
  let timer: ReturnType<typeof globalThis.setInterval> | null = null;
  let lastFiredMinute: string | null = null; // "YYYY-MM-DD HH:MM" to avoid double-fire

  function check(): void {
    const now = d.now();
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    if (minuteKey === lastFiredMinute) return; // Already fired this minute

    if (matchesCronSchedule(schedule, now)) {
      lastFiredMinute = minuteKey;
      const detail = `Cron matched: ${config.expression} at ${now.toISOString()}`;
      onTrigger(config.skills, detail);
    }
  }

  return {
    start() {
      check(); // Check immediately on start
      timer = d.setInterval(check, 60_000);
    },
    stop() {
      if (timer !== null) {
        d.clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * Validate a cron expression string. Returns null if valid, error string otherwise.
 */
export function validateCronExpression(expr: string): string | null {
  const schedule = parseCronExpression(expr);
  if (!schedule) return `Invalid cron expression: "${expr}"`;
  return null;
}
