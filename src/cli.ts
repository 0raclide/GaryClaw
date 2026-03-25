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

function formatEvent(event: OrchestratorEvent): string {
  switch (event.type) {
    case "segment_start":
      return `[Session ${event.sessionIndex}] Segment ${event.segmentIndex} starting...`;
    case "segment_end":
      return `[Session ${event.sessionIndex}] Segment ${event.segmentIndex} complete (${event.numTurns} turns)`;
    case "turn_usage": {
      const pct = event.contextWindow
        ? ` (${((event.contextSize / event.contextWindow) * 100).toFixed(1)}%)`
        : "";
      return `  Turn ${event.turn}: ${(event.contextSize / 1000).toFixed(0)}K context${pct}`;
    }
    case "relay_triggered":
      return `\n>>> RELAY TRIGGERED [Session ${event.sessionIndex}]: ${event.reason}\n    Context: ${(event.contextSize / 1000).toFixed(0)}K tokens`;
    case "relay_complete":
      return `>>> RELAY COMPLETE — starting session ${event.newSessionIndex}`;
    case "ask_user":
      return `\n? ${event.question}`;
    case "skill_complete":
      return `\nSKILL COMPLETE: ${event.totalSessions} session(s), ${event.totalTurns} turn(s)`;
    case "error":
      return `\nERROR${event.recoverable ? " (recoverable)" : ""}: ${event.message}`;
    case "checkpoint_saved":
      return `  Checkpoint saved: ${event.path}`;
  }
}

async function askUserViaReadline(
  question: string,
  options: { label: string; description: string }[],
): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    console.log(`\n? ${question}\n`);
    options.forEach((opt, i) => {
      console.log(`  ${i + 1}. ${opt.label} — ${opt.description}`);
    });
    console.log("");

    rl.question("Choose (number or label): ", (answer) => {
      rl.close();
      const num = parseInt(answer, 10);
      if (num >= 1 && num <= options.length) {
        resolve(options[num - 1].label);
      } else {
        // Try matching by label
        const match = options.find(
          (o) => o.label.toLowerCase() === answer.trim().toLowerCase(),
        );
        resolve(match?.label ?? options[0].label);
      }
    });
  });
}

function printUsage(): void {
  console.log(`
GaryClaw — Context-infinite skill orchestration

Usage:
  garyclaw run <skill>     Run a gstack skill with context relay
  garyclaw resume          Resume from last checkpoint

Options:
  --project-dir <dir>      Project directory (default: cwd)
  --max-turns <n>          Max turns per segment (default: 15)
  --threshold <ratio>      Relay threshold ratio (default: 0.85)
  --checkpoint-dir <dir>   Checkpoint directory (default: .garyclaw)
  --max-sessions <n>       Max relay sessions (default: 10)

Examples:
  garyclaw run qa
  garyclaw run design-review --threshold 0.80
  garyclaw resume --checkpoint-dir .garyclaw
`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (parsed.command === "help" || parsed.command === "--help") {
    printUsage();
    return;
  }

  if (parsed.command === "run") {
    if (!parsed.skill) {
      console.error("Error: skill name required. Usage: garyclaw run <skill>");
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

    console.log(`GaryClaw — running /${config.skillName}`);
    console.log(`  Project: ${config.projectDir}`);
    console.log(`  Max turns/segment: ${config.maxTurnsPerSegment}`);
    console.log(`  Relay threshold: ${(config.relayThresholdRatio * 100).toFixed(0)}%`);
    console.log(`  Max sessions: ${config.maxRelaySessions}`);
    console.log("");

    await runSkill(config, {
      onEvent: (event) => console.log(formatEvent(event)),
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

    console.log(`GaryClaw — resuming from ${checkpointDir}`);
    console.log("");

    await resumeSkill(checkpointDir, config, {
      onEvent: (event) => console.log(formatEvent(event)),
      onAskUser: askUserViaReadline,
    });

    return;
  }

  console.error(`Unknown command: ${parsed.command}`);
  printUsage();
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
