#!/usr/bin/env node
/**
 * GaryClaw CLI — entry point for skill orchestration.
 *
 * Usage:
 *   garyclaw run <skill> [--project-dir <dir>] [--max-turns <n>] [--threshold <ratio>]
 *   garyclaw resume [--checkpoint-dir <dir>]
 */

import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSdkEnv } from "./sdk-wrapper.js";
import { runSkill, resumeSkill } from "./orchestrator.js";
import { runPipeline, resumePipeline, readPipelineState } from "./pipeline.js";
import type { GaryClawConfig, OrchestratorCallbacks, OrchestratorEvent } from "./types.js";

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
  skills: string[];
  projectDir: string;
  maxTurns: number;
  threshold: number;
  checkpointDir?: string;
  maxSessions: number;
  autonomous: boolean;
} {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const skills: string[] = [];

  let projectDir = process.cwd();
  let maxTurns = 15;
  let threshold = 0.85;
  let checkpointDir: string | undefined;
  let maxSessions = 10;
  let autonomous = false;

  // Collect skills (positional args after "run") and flags
  if (command === "run") {
    for (let i = 1; i < args.length; i++) {
      if (args[i].startsWith("--")) {
        // Handle flags
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
        } else if (args[i] === "--autonomous") {
          autonomous = true;
        }
      } else {
        // Positional arg = skill name (strip leading / if present)
        skills.push(args[i].replace(/^\//, ""));
      }
    }
  } else {
    // Non-run commands: parse flags only
    for (let i = 1; i < args.length; i++) {
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
      } else if (args[i] === "--autonomous") {
        autonomous = true;
      }
    }
  }

  return { command, skills, projectDir, maxTurns, threshold, checkpointDir, maxSessions, autonomous };
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

    case "pipeline_skill_start":
      return `\n${BOLD}${CYAN}>>> PIPELINE [${event.skillIndex + 1}/${event.totalSkills}]${RESET} Starting ${CYAN}/${event.skillName}${RESET}`;

    case "pipeline_skill_complete":
      return `${GREEN}${BOLD}>>> PIPELINE [${event.skillIndex + 1}/${event.totalSkills}]${RESET} ${GREEN}/${event.skillName} complete ($${event.costUsd.toFixed(3)})${RESET}`;

    case "issue_extracted":
      return `  ${GREEN}✓${RESET} ${BOLD}${event.issue.id}${RESET}: ${event.issue.description}${event.issue.filePath ? ` ${DIM}(${event.issue.filePath})${RESET}` : ""}`;

    case "pipeline_complete":
      return `\n${GREEN}${BOLD}PIPELINE COMPLETE${RESET}: ${event.totalSkills} skill(s), $${event.totalCostUsd.toFixed(3)} total`;
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
  garyclaw run <skill> [skill2 ...]   Run one or more skills (pipeline if multiple)
  garyclaw resume                     Resume from last checkpoint or pipeline
  garyclaw replay                     Replay decision log as timeline

${BOLD}Options:${RESET}
  --project-dir <dir>      Project directory (default: cwd)
  --max-turns <n>          Max turns per segment (default: 15)
  --threshold <ratio>      Relay threshold ratio (default: 0.85)
  --checkpoint-dir <dir>   Checkpoint directory (default: .garyclaw)
  --max-sessions <n>       Max relay sessions (default: 10)
  --autonomous             Use Decision Oracle instead of human prompts

${BOLD}Examples:${RESET}
  garyclaw run qa
  garyclaw run qa --autonomous
  garyclaw run qa design-review ship          # skill pipeline
  garyclaw run /qa /design-review /ship       # same (slashes stripped)
  garyclaw run design-review --threshold 0.80
  garyclaw resume --checkpoint-dir .garyclaw
  garyclaw replay
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
    if (parsed.skills.length === 0) {
      console.error(`${RED}Error:${RESET} skill name required. Usage: garyclaw run <skill> [skill2 ...]`);
      process.exit(1);
    }

    const cbs: OrchestratorCallbacks = {
      onEvent: (event) => {
        const formatted = formatEvent(event);
        if (formatted) console.log(formatted);
      },
      onAskUser: askUserViaReadline,
    };

    if (parsed.skills.length === 1) {
      // Single skill — run directly
      const config: GaryClawConfig = {
        skillName: parsed.skills[0],
        projectDir: parsed.projectDir,
        maxTurnsPerSegment: parsed.maxTurns,
        relayThresholdRatio: parsed.threshold,
        checkpointDir: parsed.checkpointDir ?? join(parsed.projectDir, ".garyclaw"),
        settingSources: ["user", "project"],
        env: buildSdkEnv(process.env as Record<string, string>),
        askTimeoutMs: 5 * 60 * 1000,
        maxRelaySessions: parsed.maxSessions,
        autonomous: parsed.autonomous,
      };

      console.log(`${BOLD}GaryClaw${RESET} — running ${CYAN}/${config.skillName}${RESET}${config.autonomous ? ` ${YELLOW}[AUTONOMOUS]${RESET}` : ""}`);
      console.log(`${DIM}  Project:          ${config.projectDir}${RESET}`);
      console.log(`${DIM}  Max turns/segment: ${config.maxTurnsPerSegment}${RESET}`);
      console.log(`${DIM}  Relay threshold:   ${(config.relayThresholdRatio * 100).toFixed(0)}%${RESET}`);
      console.log(`${DIM}  Max sessions:      ${config.maxRelaySessions}${RESET}`);
      console.log("");

      await runSkill(config, cbs);
    } else {
      // Multiple skills — run as pipeline
      const config: GaryClawConfig = {
        skillName: parsed.skills[0], // First skill (pipeline will override per-skill)
        projectDir: parsed.projectDir,
        maxTurnsPerSegment: parsed.maxTurns,
        relayThresholdRatio: parsed.threshold,
        checkpointDir: parsed.checkpointDir ?? join(parsed.projectDir, ".garyclaw"),
        settingSources: ["user", "project"],
        env: buildSdkEnv(process.env as Record<string, string>),
        askTimeoutMs: 5 * 60 * 1000,
        maxRelaySessions: parsed.maxSessions,
        autonomous: parsed.autonomous,
      };

      const skillList = parsed.skills.map((s) => `/${s}`).join(" → ");
      console.log(`${BOLD}GaryClaw Pipeline${RESET} — ${CYAN}${skillList}${RESET}${config.autonomous ? ` ${YELLOW}[AUTONOMOUS]${RESET}` : ""}`);
      console.log(`${DIM}  Skills:           ${parsed.skills.length}${RESET}`);
      console.log(`${DIM}  Project:          ${config.projectDir}${RESET}`);
      console.log(`${DIM}  Max turns/segment: ${config.maxTurnsPerSegment}${RESET}`);
      console.log(`${DIM}  Relay threshold:   ${(config.relayThresholdRatio * 100).toFixed(0)}%${RESET}`);
      console.log(`${DIM}  Max sessions:      ${config.maxRelaySessions}${RESET}`);
      console.log("");

      await runPipeline(parsed.skills, config, cbs);
    }

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
      settingSources: ["user", "project"],
      env: buildSdkEnv(process.env as Record<string, string>),
      askTimeoutMs: 5 * 60 * 1000,
      maxRelaySessions: parsed.maxSessions,
      autonomous: parsed.autonomous,
    };

    const cbs: OrchestratorCallbacks = {
      onEvent: (event) => {
        const formatted = formatEvent(event);
        if (formatted) console.log(formatted);
      },
      onAskUser: askUserViaReadline,
    };

    // Check for pipeline state first, then fall back to single-skill checkpoint
    const pipelineState = readPipelineState(checkpointDir);
    if (pipelineState) {
      const skillList = pipelineState.skills.map((s) => `/${s.skillName}`).join(" → ");
      const completed = pipelineState.skills.filter((s) => s.status === "complete").length;
      console.log(`${BOLD}GaryClaw Pipeline${RESET} — resuming ${CYAN}${skillList}${RESET}`);
      console.log(`${DIM}  Completed: ${completed}/${pipelineState.skills.length}${RESET}`);
      console.log("");

      await resumePipeline(checkpointDir, config, cbs);
    } else {
      console.log(`${BOLD}GaryClaw${RESET} — resuming from ${CYAN}${checkpointDir}${RESET}`);
      console.log("");

      await resumeSkill(checkpointDir, config, cbs);
    }

    return;
  }

  if (parsed.command === "replay") {
    const checkpointDir =
      parsed.checkpointDir ?? join(parsed.projectDir, ".garyclaw");
    const logPath = join(checkpointDir, "decisions.jsonl");

    if (!existsSync(logPath)) {
      console.error(`${RED}No decision log found at:${RESET} ${logPath}`);
      process.exit(1);
    }

    console.log(`${BOLD}GaryClaw Decision Replay${RESET}\n`);

    const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      try {
        const d = JSON.parse(lines[i]);
        const conf = d.confidence ?? "?";
        const confColor = conf >= 8 ? GREEN : conf >= 6 ? YELLOW : RED;

        console.log(`${DIM}${d.timestamp}${RESET}`);
        console.log(`${BOLD}${i + 1}. ${d.question}${RESET}`);

        if (d.options && Array.isArray(d.options)) {
          for (const opt of d.options) {
            const marker = opt.label === d.chosen ? `${GREEN}>>${RESET}` : "  ";
            console.log(`  ${marker} ${opt.label} ${DIM}— ${opt.description}${RESET}`);
          }
        }

        console.log(`  ${CYAN}Answer:${RESET} ${BOLD}${d.chosen}${RESET} ${confColor}(confidence: ${conf}/10)${RESET}`);
        if (d.rationale) console.log(`  ${DIM}Why: ${d.rationale}${RESET}`);
        if (d.principle) console.log(`  ${DIM}Principle: ${d.principle}${RESET}`);
        console.log("");
      } catch {
        console.log(`${DIM}  [corrupt entry at line ${i + 1}]${RESET}\n`);
      }
    }

    console.log(`${DIM}Total decisions: ${lines.length}${RESET}`);

    // Check for escalated decisions
    const escalatedPath = join(checkpointDir, "escalated.jsonl");
    if (existsSync(escalatedPath)) {
      const escalated = readFileSync(escalatedPath, "utf-8").trim().split("\n").filter(Boolean);
      if (escalated.length > 0) {
        console.log(`\n${YELLOW}${BOLD}Escalated decisions: ${escalated.length}${RESET}`);
        for (const line of escalated) {
          try {
            const e = JSON.parse(line);
            console.log(`  ${YELLOW}>${RESET} ${e.question} — ${e.escalateReason}`);
          } catch {
            // skip corrupt
          }
        }
      }
    }

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
