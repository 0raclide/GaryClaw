#!/usr/bin/env node
/**
 * GaryClaw CLI — entry point for skill orchestration.
 *
 * Usage:
 *   garyclaw run <skill> [--project-dir <dir>] [--max-turns <n>] [--threshold <ratio>]
 *   garyclaw resume [--checkpoint-dir <dir>]
 */

import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { buildSdkEnv } from "./sdk-wrapper.js";
import { runSkill, resumeSkill } from "./orchestrator.js";
import type { GaryClawConfig, OrchestratorEvent } from "./types.js";

// ── ANSI colors ─────────────────────────────────────────────────

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

// ── Arg parsing ─────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  command: string;
  skill?: string;
  projectDir: string;
  maxTurns: number;
  threshold: number;
  checkpointDir?: string;
  maxSessions: number;
} {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const skill = command === "run" ? args[1] : undefined;

  let projectDir = process.cwd();
  let maxTurns = 15;
  let threshold = 0.85;
  let checkpointDir: string | undefined;
  let maxSessions = 10;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project-dir" && args[i + 1]) {
      projectDir = resolve(args[++i]);
    } else if (args[i] === "--max-turns" && args[i + 1]) {
      maxTurns = parseInt(args[++i], 10);
    } else if (args[i] === "--threshold" && args[i + 1]) {
      threshold = parseFloat(args[++i]);
    } else if (args[i] === "--checkpoint-dir" && args[i + 1]) {
      checkpointDir = resolve(args[++i]);
    } else if (args[i] === "--max-sessions" && args[i + 1]) {
      maxSessions = parseInt(args[++i], 10);
    }
  }

  return { command, skill, projectDir, maxTurns, threshold, checkpointDir, maxSessions };
}

// ── Event formatting ────────────────────────────────────────────

function formatEvent(event: OrchestratorEvent): string {
  switch (event.type) {
    case "segment_start":
      return `${DIM}[Session ${event.sessionIndex}] Segment ${event.segmentIndex} starting...${RESET}`;

    case "segment_end":
      return `${DIM}[Session ${event.sessionIndex}] Segment ${event.segmentIndex} complete (${event.numTurns} turns)${RESET}`;

    case "turn_usage": {
      const pct = event.contextWindow
        ? ` (${((event.contextSize / event.contextWindow) * 100).toFixed(1)}%)`
        : "";
      const color = event.contextWindow && event.contextSize / event.contextWindow > 0.7 ? YELLOW : DIM;
      return `${color}  Turn ${event.turn}: ${(event.contextSize / 1000).toFixed(0)}K context${pct}${RESET}`;
    }

    case "relay_triggered":
      return `\n${YELLOW}${BOLD}>>> RELAY TRIGGERED${RESET}${YELLOW} [Session ${event.sessionIndex}]: ${event.reason}\n    Context: ${(event.contextSize / 1000).toFixed(0)}K tokens${RESET}`;

    case "relay_complete":
      return `${GREEN}>>> RELAY COMPLETE${RESET} — starting session ${event.newSessionIndex}`;

    case "ask_user":
      return `\n${MAGENTA}?${RESET} ${event.question}`;

    case "skill_complete":
      return `\n${GREEN}${BOLD}SKILL COMPLETE${RESET}: ${event.totalSessions} session(s), ${event.totalTurns} turn(s), $${event.costUsd.toFixed(3)}`;

    case "error":
      return `\n${RED}${event.recoverable ? "WARNING" : "ERROR"}${RESET}: ${event.message}`;

    case "checkpoint_saved":
      return `${DIM}  Checkpoint saved: ${event.path}${RESET}`;

    case "assistant_text":
      return `${CYAN}${event.text}${RESET}`;

    case "tool_use":
      return `${DIM}  -> ${event.toolName}${event.inputSummary ? ` ${event.inputSummary}` : ""}${RESET}`;

    case "tool_result":
      return `${DIM}  <- ${event.toolName}${RESET}`;

    case "cost_update":
      return `${DIM}  Cost: $${event.costUsd.toFixed(3)} (session ${event.sessionIndex})${RESET}`;
  }
}

// ── AskUserQuestion readline ────────────────────────────────────

async function askUserViaReadline(
  question: string,
  options: { label: string; description: string }[],
  multiSelect: boolean,
): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolvePromise) => {
    console.log(`\n${MAGENTA}${BOLD}?${RESET} ${BOLD}${question}${RESET}\n`);

    options.forEach((opt, i) => {
      console.log(`  ${CYAN}${i + 1}.${RESET} ${BOLD}${opt.label}${RESET} ${DIM}— ${opt.description}${RESET}`);
    });
    console.log(`  ${CYAN}${options.length + 1}.${RESET} ${BOLD}Other${RESET} ${DIM}— Type a custom answer${RESET}`);
    console.log("");

    const promptText = multiSelect
      ? `${MAGENTA}Choose (comma-separated numbers or labels): ${RESET}`
      : `${MAGENTA}Choose (number or label): ${RESET}`;

    rl.question(promptText, (answer) => {
      rl.close();

      if (multiSelect) {
        resolvePromise(parseMultiSelectAnswer(answer, options));
      } else {
        resolvePromise(parseSingleAnswer(answer, options));
      }
    });
  });
}

function parseSingleAnswer(
  answer: string,
  options: { label: string; description: string }[],
): string {
  const trimmed = answer.trim();
  const num = parseInt(trimmed, 10);

  // "Other" option (last number)
  if (num === options.length + 1) {
    return trimmed; // User will type their answer next prompt — for now return the raw input
  }

  // Number selection
  if (num >= 1 && num <= options.length) {
    return options[num - 1].label;
  }

  // Label match (case-insensitive)
  const match = options.find(
    (o) => o.label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (match) return match.label;

  // Free text — treat as "Other"
  return trimmed || options[0].label;
}

function parseMultiSelectAnswer(
  answer: string,
  options: { label: string; description: string }[],
): string {
  const parts = answer.split(",").map((s) => s.trim()).filter(Boolean);
  const selected: string[] = [];

  for (const part of parts) {
    const num = parseInt(part, 10);
    if (num >= 1 && num <= options.length) {
      selected.push(options[num - 1].label);
    } else {
      const match = options.find(
        (o) => o.label.toLowerCase() === part.toLowerCase(),
      );
      if (match) {
        selected.push(match.label);
      } else {
        selected.push(part); // Free text
      }
    }
  }

  return selected.length > 0 ? selected.join(", ") : options[0].label;
}

// ── Usage ───────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
${BOLD}GaryClaw${RESET} — Context-infinite skill orchestration

${BOLD}Usage:${RESET}
  garyclaw run <skill>     Run a gstack skill with context relay
  garyclaw resume          Resume from last checkpoint

${BOLD}Options:${RESET}
  --project-dir <dir>      Project directory (default: cwd)
  --max-turns <n>          Max turns per segment (default: 15)
  --threshold <ratio>      Relay threshold ratio (default: 0.85)
  --checkpoint-dir <dir>   Checkpoint directory (default: .garyclaw)
  --max-sessions <n>       Max relay sessions (default: 10)

${BOLD}Examples:${RESET}
  garyclaw run qa
  garyclaw run design-review --threshold 0.80
  garyclaw resume --checkpoint-dir .garyclaw
`);
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (parsed.command === "help" || parsed.command === "--help") {
    printUsage();
    return;
  }

  if (parsed.command === "run") {
    if (!parsed.skill) {
      console.error(`${RED}Error:${RESET} skill name required. Usage: garyclaw run <skill>`);
      process.exit(1);
    }

    const config: GaryClawConfig = {
      skillName: parsed.skill,
      projectDir: parsed.projectDir,
      maxTurnsPerSegment: parsed.maxTurns,
      relayThresholdRatio: parsed.threshold,
      checkpointDir: parsed.checkpointDir ?? join(parsed.projectDir, ".garyclaw"),
      settingSources: ["project"],
      env: buildSdkEnv(process.env as Record<string, string>),
      askTimeoutMs: 5 * 60 * 1000, // 5 minutes
      maxRelaySessions: parsed.maxSessions,
    };

    console.log(`${BOLD}GaryClaw${RESET} — running ${CYAN}/${config.skillName}${RESET}`);
    console.log(`${DIM}  Project:          ${config.projectDir}${RESET}`);
    console.log(`${DIM}  Max turns/segment: ${config.maxTurnsPerSegment}${RESET}`);
    console.log(`${DIM}  Relay threshold:   ${(config.relayThresholdRatio * 100).toFixed(0)}%${RESET}`);
    console.log(`${DIM}  Max sessions:      ${config.maxRelaySessions}${RESET}`);
    console.log("");

    await runSkill(config, {
      onEvent: (event) => {
        const formatted = formatEvent(event);
        if (formatted) console.log(formatted);
      },
      onAskUser: askUserViaReadline,
    });

    return;
  }

  if (parsed.command === "resume") {
    const checkpointDir =
      parsed.checkpointDir ?? join(parsed.projectDir, ".garyclaw");

    const config: GaryClawConfig = {
      skillName: "", // Will be overridden from checkpoint
      projectDir: parsed.projectDir,
      maxTurnsPerSegment: parsed.maxTurns,
      relayThresholdRatio: parsed.threshold,
      checkpointDir,
      settingSources: ["project"],
      env: buildSdkEnv(process.env as Record<string, string>),
      askTimeoutMs: 5 * 60 * 1000,
      maxRelaySessions: parsed.maxSessions,
    };

    console.log(`${BOLD}GaryClaw${RESET} — resuming from ${CYAN}${checkpointDir}${RESET}`);
    console.log("");

    await resumeSkill(checkpointDir, config, {
      onEvent: (event) => {
        const formatted = formatEvent(event);
        if (formatted) console.log(formatted);
      },
      onAskUser: askUserViaReadline,
    });

    return;
  }

  console.error(`${RED}Unknown command:${RESET} ${parsed.command}`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error(`${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
