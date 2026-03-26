/**
 * CLI tests — parseArgs, formatEvent, parseSingleAnswer,
 * parseMultiSelectAnswer, formatUptime.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all heavy dependencies so cli.ts can be imported without side effects
vi.mock("../src/sdk-wrapper.js", () => ({
  buildSdkEnv: vi.fn((env: Record<string, string>) => env),
}));
vi.mock("../src/orchestrator.js", () => ({
  runSkill: vi.fn(),
  resumeSkill: vi.fn(),
}));
vi.mock("../src/pipeline.js", () => ({
  runPipeline: vi.fn(),
  resumePipeline: vi.fn(),
  readPipelineState: vi.fn(),
}));
vi.mock("../src/daemon-ipc.js", () => ({
  sendIPCRequest: vi.fn(),
}));
vi.mock("../src/daemon.js", () => ({
  readPidFile: vi.fn(),
  isPidAlive: vi.fn(),
  cleanupDaemonFiles: vi.fn(),
}));

import {
  parseArgs,
  formatEvent,
  parseSingleAnswer,
  parseMultiSelectAnswer,
  formatUptime,
} from "../src/cli.js";

// ── parseArgs ────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("parses 'run' with a single skill", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa"]);
    expect(result.command).toBe("run");
    expect(result.skills).toEqual(["qa"]);
  });

  it("parses 'run' with multiple skills", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "design-review", "ship"]);
    expect(result.command).toBe("run");
    expect(result.skills).toEqual(["qa", "design-review", "ship"]);
  });

  it("strips leading / from skill names", () => {
    const result = parseArgs(["node", "cli.ts", "run", "/qa", "/design-review"]);
    expect(result.skills).toEqual(["qa", "design-review"]);
  });

  it("parses --max-turns flag", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--max-turns", "20"]);
    expect(result.maxTurns).toBe(20);
    expect(result.skills).toEqual(["qa"]);
  });

  it("parses --threshold flag", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--threshold", "0.75"]);
    expect(result.threshold).toBe(0.75);
  });

  it("parses --max-sessions flag", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--max-sessions", "5"]);
    expect(result.maxSessions).toBe(5);
  });

  it("parses --autonomous flag", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--autonomous"]);
    expect(result.autonomous).toBe(true);
  });

  it("defaults autonomous to false", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa"]);
    expect(result.autonomous).toBe(false);
  });

  it("parses --no-memory flag", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--no-memory"]);
    expect(result.noMemory).toBe(true);
  });

  it("defaults noMemory to false", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa"]);
    expect(result.noMemory).toBe(false);
  });

  it("parses --no-memory with --autonomous", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--autonomous", "--no-memory"]);
    expect(result.autonomous).toBe(true);
    expect(result.noMemory).toBe(true);
  });

  it("parses --no-memory in resume command", () => {
    const result = parseArgs(["node", "cli.ts", "resume", "--no-memory"]);
    expect(result.noMemory).toBe(true);
  });

  it("parses --project-dir flag", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--project-dir", "/tmp/test"]);
    expect(result.projectDir).toContain("tmp");
  });

  it("parses --checkpoint-dir flag", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--checkpoint-dir", "/tmp/cp"]);
    expect(result.checkpointDir).toContain("tmp");
  });

  it("defaults command to 'help' when no args", () => {
    const result = parseArgs(["node", "cli.ts"]);
    expect(result.command).toBe("help");
  });

  it("defaults numeric values", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa"]);
    expect(result.maxTurns).toBe(15);
    expect(result.threshold).toBe(0.85);
    expect(result.maxSessions).toBe(10);
    expect(result.tailLines).toBe(50);
  });

  it("handles skills mixed with flags", () => {
    const result = parseArgs([
      "node", "cli.ts", "run", "qa", "--max-turns", "10", "design-review", "--autonomous",
    ]);
    expect(result.skills).toEqual(["qa", "design-review"]);
    expect(result.maxTurns).toBe(10);
    expect(result.autonomous).toBe(true);
  });

  // Daemon subcommands
  it("parses 'daemon start'", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "start"]);
    expect(result.command).toBe("daemon");
    expect(result.subcommand).toBe("start");
  });

  it("parses 'daemon trigger' with skills", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "trigger", "qa", "ship"]);
    expect(result.command).toBe("daemon");
    expect(result.subcommand).toBe("trigger");
    expect(result.skills).toEqual(["qa", "ship"]);
  });

  it("parses 'daemon log --tail 100'", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "log", "--tail", "100"]);
    expect(result.command).toBe("daemon");
    expect(result.subcommand).toBe("log");
    expect(result.tailLines).toBe(100);
  });

  it("parses 'daemon start --config path'", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "start", "--config", "/tmp/d.json"]);
    expect(result.configPath).toContain("d.json");
  });

  it("strips / from daemon trigger skill names", () => {
    const result = parseArgs(["node", "cli.ts", "daemon", "trigger", "/qa"]);
    expect(result.skills).toEqual(["qa"]);
  });

  // Non-run commands with flags
  it("parses resume with flags", () => {
    const result = parseArgs(["node", "cli.ts", "resume", "--checkpoint-dir", "/tmp/cp"]);
    expect(result.command).toBe("resume");
    expect(result.checkpointDir).toContain("tmp");
  });

  it("parses replay command", () => {
    const result = parseArgs(["node", "cli.ts", "replay"]);
    expect(result.command).toBe("replay");
  });

  // Edge cases
  it("returns empty skills array when no skills given to run", () => {
    const result = parseArgs(["node", "cli.ts", "run"]);
    expect(result.skills).toEqual([]);
  });

  it("handles unknown flags gracefully (they are ignored)", () => {
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--unknown-flag"]);
    expect(result.skills).toEqual(["qa"]);
  });

  it("parses --max-turns without a value (flag at end of args)", () => {
    // --max-turns at end with no value: the condition `args[i + 1]` is falsy
    const result = parseArgs(["node", "cli.ts", "run", "qa", "--max-turns"]);
    expect(result.maxTurns).toBe(15); // unchanged default
  });
});

// ── parseSingleAnswer ────────────────────────────────────────────

describe("parseSingleAnswer", () => {
  const options = [
    { label: "Fix it", description: "Auto-fix the issue" },
    { label: "Skip", description: "Skip this issue" },
    { label: "Manual", description: "Fix manually" },
  ];

  it("selects by number (1-indexed)", () => {
    expect(parseSingleAnswer("1", options)).toBe("Fix it");
    expect(parseSingleAnswer("2", options)).toBe("Skip");
    expect(parseSingleAnswer("3", options)).toBe("Manual");
  });

  it("selects by exact label", () => {
    expect(parseSingleAnswer("Fix it", options)).toBe("Fix it");
  });

  it("selects by case-insensitive label", () => {
    expect(parseSingleAnswer("fix it", options)).toBe("Fix it");
    expect(parseSingleAnswer("SKIP", options)).toBe("Skip");
  });

  it("returns free text for unmatched input", () => {
    expect(parseSingleAnswer("custom answer", options)).toBe("custom answer");
  });

  it("returns first option for empty input", () => {
    expect(parseSingleAnswer("", options)).toBe("Fix it");
    expect(parseSingleAnswer("  ", options)).toBe("Fix it");
  });

  it("ignores out-of-range numbers and treats as free text", () => {
    expect(parseSingleAnswer("0", options)).toBe("0");
    expect(parseSingleAnswer("4", options)).toBe("4");
    expect(parseSingleAnswer("-1", options)).toBe("-1");
  });

  it("trims whitespace from input", () => {
    expect(parseSingleAnswer("  2  ", options)).toBe("Skip");
  });
});

// ── parseMultiSelectAnswer ───────────────────────────────────────

describe("parseMultiSelectAnswer", () => {
  const options = [
    { label: "Alpha", description: "First" },
    { label: "Beta", description: "Second" },
    { label: "Gamma", description: "Third" },
  ];

  it("selects multiple by number", () => {
    expect(parseMultiSelectAnswer("1,3", options)).toBe("Alpha, Gamma");
  });

  it("selects by label", () => {
    expect(parseMultiSelectAnswer("Alpha, Beta", options)).toBe("Alpha, Beta");
  });

  it("selects by case-insensitive label", () => {
    expect(parseMultiSelectAnswer("alpha, gamma", options)).toBe("Alpha, Gamma");
  });

  it("mixes numbers and labels", () => {
    expect(parseMultiSelectAnswer("1, Beta", options)).toBe("Alpha, Beta");
  });

  it("includes free text for unmatched items", () => {
    expect(parseMultiSelectAnswer("1, custom", options)).toBe("Alpha, custom");
  });

  it("returns first option for empty input", () => {
    expect(parseMultiSelectAnswer("", options)).toBe("Alpha");
  });

  it("handles single selection", () => {
    expect(parseMultiSelectAnswer("2", options)).toBe("Beta");
  });

  it("ignores empty parts after split", () => {
    expect(parseMultiSelectAnswer("1,,2", options)).toBe("Alpha, Beta");
  });

  it("handles out-of-range numbers as free text", () => {
    expect(parseMultiSelectAnswer("0, 5", options)).toBe("0, 5");
  });
});

// ── formatUptime ─────────────────────────────────────────────────

describe("formatUptime", () => {
  it("formats seconds only", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(30)).toBe("30s");
    expect(formatUptime(59)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(60)).toBe("1m 0s");
    expect(formatUptime(90)).toBe("1m 30s");
    expect(formatUptime(3599)).toBe("59m 59s");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(3600)).toBe("1h 0m");
    expect(formatUptime(7200)).toBe("2h 0m");
    expect(formatUptime(3661)).toBe("1h 1m");
    expect(formatUptime(86400)).toBe("24h 0m");
  });
});

// ── formatEvent ──────────────────────────────────────────────────

describe("formatEvent", () => {
  it("formats segment_start event", () => {
    const result = formatEvent({ type: "segment_start", sessionIndex: 0, segmentIndex: 1 });
    expect(result).toContain("Session 0");
    expect(result).toContain("Segment 1");
  });

  it("formats segment_end event", () => {
    const result = formatEvent({ type: "segment_end", sessionIndex: 0, segmentIndex: 0, numTurns: 5 });
    expect(result).toContain("5 turns");
  });

  it("formats turn_usage with context percentage", () => {
    const result = formatEvent({
      type: "turn_usage",
      sessionIndex: 0,
      turn: 3,
      contextSize: 500000,
      contextWindow: 1000000,
    });
    expect(result).toContain("Turn 3");
    expect(result).toContain("500K");
    expect(result).toContain("50.0%");
  });

  it("formats turn_usage without context window", () => {
    const result = formatEvent({
      type: "turn_usage",
      sessionIndex: 0,
      turn: 1,
      contextSize: 100000,
      contextWindow: null,
    });
    expect(result).toContain("Turn 1");
    expect(result).toContain("100K");
    expect(result).not.toContain("%");
  });

  it("formats relay_triggered event", () => {
    const result = formatEvent({
      type: "relay_triggered",
      sessionIndex: 1,
      reason: "Context at 90%",
      contextSize: 900000,
    });
    expect(result).toContain("RELAY TRIGGERED");
    expect(result).toContain("Session 1");
    expect(result).toContain("900K");
  });

  it("formats relay_complete event", () => {
    const result = formatEvent({ type: "relay_complete", newSessionIndex: 2 });
    expect(result).toContain("RELAY COMPLETE");
    expect(result).toContain("session 2");
  });

  it("formats ask_user event", () => {
    const result = formatEvent({ type: "ask_user", question: "Which option?" });
    expect(result).toContain("Which option?");
  });

  it("formats skill_complete event", () => {
    const result = formatEvent({
      type: "skill_complete",
      totalSessions: 3,
      totalTurns: 45,
      costUsd: 1.234,
    });
    expect(result).toContain("SKILL COMPLETE");
    expect(result).toContain("3 session(s)");
    expect(result).toContain("45 turn(s)");
    expect(result).toContain("$1.234");
  });

  it("formats error event (recoverable)", () => {
    const result = formatEvent({ type: "error", message: "Something failed", recoverable: true });
    expect(result).toContain("WARNING");
    expect(result).toContain("Something failed");
  });

  it("formats error event (non-recoverable)", () => {
    const result = formatEvent({ type: "error", message: "Fatal", recoverable: false });
    expect(result).toContain("ERROR");
    expect(result).toContain("Fatal");
  });

  it("formats checkpoint_saved event", () => {
    const result = formatEvent({ type: "checkpoint_saved", path: "/tmp/cp.json" });
    expect(result).toContain("/tmp/cp.json");
  });

  it("formats assistant_text event", () => {
    const result = formatEvent({ type: "assistant_text", text: "Working on it..." });
    expect(result).toContain("Working on it...");
  });

  it("formats tool_use event", () => {
    const result = formatEvent({ type: "tool_use", toolName: "Bash", inputSummary: "npm test" });
    expect(result).toContain("Bash");
    expect(result).toContain("npm test");
  });

  it("formats tool_use event without summary", () => {
    const result = formatEvent({ type: "tool_use", toolName: "Read", inputSummary: "" });
    expect(result).toContain("Read");
  });

  it("formats tool_result event", () => {
    const result = formatEvent({ type: "tool_result", toolName: "Bash" });
    expect(result).toContain("Bash");
  });

  it("formats cost_update event", () => {
    const result = formatEvent({ type: "cost_update", costUsd: 0.567, sessionIndex: 1 });
    expect(result).toContain("$0.567");
    expect(result).toContain("session 1");
  });

  it("formats pipeline_skill_start event", () => {
    const result = formatEvent({
      type: "pipeline_skill_start",
      skillIndex: 0,
      totalSkills: 3,
      skillName: "qa",
    });
    expect(result).toContain("PIPELINE [1/3]");
    expect(result).toContain("/qa");
  });

  it("formats pipeline_skill_complete event", () => {
    const result = formatEvent({
      type: "pipeline_skill_complete",
      skillIndex: 1,
      totalSkills: 3,
      skillName: "ship",
      costUsd: 0.5,
    });
    expect(result).toContain("PIPELINE [2/3]");
    expect(result).toContain("/ship");
    expect(result).toContain("$0.500");
  });

  it("formats issue_extracted event", () => {
    const result = formatEvent({
      type: "issue_extracted",
      issue: { id: "FIX-001", description: "Fix login bug", filePath: "src/auth.ts" } as any,
    });
    expect(result).toContain("FIX-001");
    expect(result).toContain("Fix login bug");
    expect(result).toContain("src/auth.ts");
  });

  it("formats issue_extracted event without filePath", () => {
    const result = formatEvent({
      type: "issue_extracted",
      issue: { id: "FIX-002", description: "Fix CSS" } as any,
    });
    expect(result).toContain("FIX-002");
    expect(result).not.toContain("undefined");
  });

  it("formats pipeline_complete event", () => {
    const result = formatEvent({
      type: "pipeline_complete",
      totalSkills: 3,
      totalCostUsd: 2.5,
    });
    expect(result).toContain("PIPELINE COMPLETE");
    expect(result).toContain("3 skill(s)");
    expect(result).toContain("$2.500");
  });
});
