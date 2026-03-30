// Regression: ISSUE-001 — displayAllInstances .replace() colors wrong column
// Found by /qa on 2026-03-30
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
//
// The fleet table used `line.replace(statusRaw, statusStr)` to inject ANSI color
// codes into the status column. But String.replace() replaces the FIRST occurrence,
// so if the instance name or TODO title contained the status word (e.g. "stopped"
// in "stopped-bot" or "running" in "running-tests"), the wrong column got colored.

import { describe, it, expect } from "vitest";

describe("fleet display column-safe color injection", () => {
  // Replicates the fixed logic from displayAllInstances
  function buildFleetRow(
    instName: string,
    statusRaw: string,
    statusStr: string,
    skillStr: string,
    todoStr: string,
    timeStr: string,
    commitStr: string,
  ): string {
    const nameCol = `  ${instName.padEnd(17)}`;
    const statusCol = statusStr + " ".repeat(Math.max(0, 10 - statusRaw.length));
    const restCols = `${skillStr.padEnd(16)}${todoStr.padEnd(28)}${timeStr.padEnd(8)}${commitStr}`;
    return `${nameCol}${statusCol}${restCols}`;
  }

  it("does not color instance name when it contains the status word", () => {
    // Instance named "stopped-bot" with status "stopped"
    const row = buildFleetRow("stopped-bot", "stopped", "\x1b[2mstopped\x1b[0m", "—", "—", "—", "—");
    // The instance name column should NOT contain ANSI codes
    const nameCol = row.slice(0, 19); // "  " + 17 chars
    expect(nameCol).not.toContain("\x1b[");
    expect(nameCol).toContain("stopped-bot");
  });

  it("does not color TODO title when it contains the status word", () => {
    // TODO title "running-tests" with status "running"
    const row = buildFleetRow("worker-1", "running", "\x1b[32mrunning\x1b[0m", "qa 1/3", "running-tests integration", "5m", "2");
    // Status column should have the ANSI code, not the TODO column
    const afterName = row.slice(19); // skip name column
    const firstAnsi = afterName.indexOf("\x1b[32m");
    // ANSI should appear at the very start (status column), not deep in the string
    expect(firstAnsi).toBe(0);
  });

  it("correctly pads status column when status word is short", () => {
    const row = buildFleetRow("worker-1", "idle", "\x1b[32midle\x1b[0m", "—", "—", "—", "—");
    // "idle" is 4 chars, column is 10, so 6 spaces of padding after the ANSI-colored "idle"
    const afterName = row.slice(19);
    // Should start with colored "idle" then spaces before the skill column
    expect(afterName).toMatch(/^\x1b\[32midle\x1b\[0m\s+—/);
  });

  it("handles status word appearing in multiple columns without misfire", () => {
    // Instance "running-1", status "running", skill "running", TODO "running..."
    const row = buildFleetRow("running-1", "running", "\x1b[32mrunning\x1b[0m", "running 2/3", "running diagnostics...", "12m", "7");
    // Only ONE occurrence of the ANSI green code should exist (the status column)
    const matches = row.match(/\x1b\[32m/g);
    expect(matches).toHaveLength(1);
  });
});
