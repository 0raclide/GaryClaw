// Regression: ISSUE-003 — --parallel + --name mutual exclusivity untested
// Found by /qa on 2026-03-30
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
//
// parseArgs accepts both --parallel and --name simultaneously (the guard is
// in main(), not parseArgs). This test verifies parseArgs returns both fields
// so main() can detect the conflict.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseArgs } from "../src/cli.js";

describe("--parallel + --name mutual exclusivity", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("parseArgs returns both parallel and name when both specified", () => {
    // parseArgs itself doesn't enforce exclusivity — that's main()'s job
    const parsed = parseArgs([
      "node", "cli.ts", "daemon", "start",
      "--parallel", "3",
      "--name", "review-bot",
    ]);
    expect(parsed.parallel).toBe(3);
    expect(parsed.name).toBe("review-bot");
  });

  it("parseArgs returns parallel without name as normal case", () => {
    const parsed = parseArgs([
      "node", "cli.ts", "daemon", "start",
      "--parallel", "5",
    ]);
    expect(parsed.parallel).toBe(5);
    expect(parsed.name).toBeUndefined();
  });

  it("parseArgs returns name without parallel as normal case", () => {
    const parsed = parseArgs([
      "node", "cli.ts", "daemon", "start",
      "--name", "review-bot",
    ]);
    expect(parsed.name).toBe("review-bot");
    expect(parsed.parallel).toBeUndefined();
  });
});
