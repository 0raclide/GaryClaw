// Regression: ISSUE-001 — batchResults[i] undefined when askOracleBatch returns fewer results than questions
// Found by /qa on 2026-03-29
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAskHandler } from "../src/ask-handler.js";

const TEST_DIR = join(tmpdir(), `garyclaw-ask-batch-reg1-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeAskInput(
  questions: Array<{
    question: string;
    options: { label: string; description: string }[];
    multiSelect?: boolean;
  }>,
): Record<string, unknown> {
  return {
    questions: questions.map((q) => ({
      ...q,
      header: "Test",
      multiSelect: q.multiSelect ?? false,
    })),
  };
}

describe("ask-handler batch — batchResults length mismatch guard", () => {
  const themeOptions = [
    { label: "Dark", description: "Dark theme" },
    { label: "Light", description: "Light theme" },
  ];

  const fontOptions = [
    { label: "Sans-serif", description: "Clean" },
    { label: "Serif", description: "Classic" },
  ];

  const layoutOptions = [
    { label: "Grid", description: "Grid layout" },
    { label: "List", description: "List layout" },
  ];

  it("handles askOracleBatch returning fewer results than questions without crashing", async () => {
    // Simulate a partial parse failure: batch returns only 1 result for 3 questions
    const askOracleBatch = vi.fn().mockResolvedValue([
      {
        choice: "Dark",
        confidence: 8,
        rationale: "User preference",
        principle: "Pragmatic",
        escalate: false,
        isTaste: false,
      },
      // Missing results for Q2 and Q3
    ]);

    const handler = createAskHandler({
      onAskUser: vi.fn(),
      askTimeoutMs: 5000,
      sessionIndex: 0,
      autonomous: true,
      oracle: {
        askOracle: vi.fn(),
        askOracleBatch,
        config: { queryFn: vi.fn(), escalateThreshold: 6 },
        skillName: "qa",
      },
    });

    const input = makeAskInput([
      { question: "Which theme?", options: themeOptions },
      { question: "Which font?", options: fontOptions },
      { question: "Which layout?", options: layoutOptions },
    ]);

    // Before the fix, this would crash with "Cannot read properties of undefined"
    const result = await handler.canUseTool("AskUserQuestion", input);

    expect(result.behavior).toBe("allow");
    // Q1 got a real answer
    expect(result.updatedInput!.answers["Which theme?"]).toBe("Dark");
    // Q2 and Q3 get fallback answers (first option label)
    expect(result.updatedInput!.answers["Which font?"]).toBe("Sans-serif");
    expect(result.updatedInput!.answers["Which layout?"]).toBe("Grid");
  });

  it("fallback results from guard have low confidence and escalate", async () => {
    const askOracleBatch = vi.fn().mockResolvedValue([
      {
        choice: "Dark",
        confidence: 9,
        rationale: "Clear preference",
        principle: "Pragmatic",
        escalate: false,
        isTaste: false,
      },
      // Missing Q2
    ]);

    const handler = createAskHandler({
      onAskUser: vi.fn(),
      askTimeoutMs: 5000,
      sessionIndex: 0,
      autonomous: true,
      oracle: {
        askOracle: vi.fn(),
        askOracleBatch,
        config: { queryFn: vi.fn(), escalateThreshold: 6 },
        skillName: "qa",
      },
    });

    const input = makeAskInput([
      { question: "Theme?", options: themeOptions },
      { question: "Font?", options: fontOptions },
    ]);
    await handler.canUseTool("AskUserQuestion", input);

    const decisions = handler.getDecisions();
    expect(decisions).toHaveLength(2);

    // Q1: real result
    expect(decisions[0].confidence).toBe(9);
    expect(decisions[0].chosen).toBe("Dark");

    // Q2: guard fallback — low confidence, escalated
    expect(decisions[1].confidence).toBe(1);
    expect(decisions[1].chosen).toBe("Sans-serif"); // First option of Q2
    expect(decisions[1].rationale).toContain("length mismatch");
  });

  it("handles askOracleBatch returning empty array for multiple questions", async () => {
    const askOracleBatch = vi.fn().mockResolvedValue([]);

    const handler = createAskHandler({
      onAskUser: vi.fn(),
      askTimeoutMs: 5000,
      sessionIndex: 0,
      autonomous: true,
      oracle: {
        askOracle: vi.fn(),
        askOracleBatch,
        config: { queryFn: vi.fn(), escalateThreshold: 6 },
        skillName: "qa",
      },
    });

    const input = makeAskInput([
      { question: "Theme?", options: themeOptions },
      { question: "Font?", options: fontOptions },
    ]);

    const result = await handler.canUseTool("AskUserQuestion", input);

    expect(result.behavior).toBe("allow");
    // Both questions get fallback answers
    const decisions = handler.getDecisions();
    expect(decisions).toHaveLength(2);
    expect(decisions[0].confidence).toBe(1);
    expect(decisions[1].confidence).toBe(1);
  });

  it("writes guard-fallback decisions to escalated log", async () => {
    const escalatedPath = join(TEST_DIR, "escalated.jsonl");

    const askOracleBatch = vi.fn().mockResolvedValue([
      // Missing both results
    ]);

    const handler = createAskHandler({
      onAskUser: vi.fn(),
      askTimeoutMs: 5000,
      sessionIndex: 0,
      autonomous: true,
      escalatedLogPath: escalatedPath,
      oracle: {
        askOracle: vi.fn(),
        askOracleBatch,
        config: { queryFn: vi.fn(), escalateThreshold: 6 },
        skillName: "qa",
      },
    });

    const input = makeAskInput([
      { question: "Theme?", options: themeOptions },
      { question: "Font?", options: fontOptions },
    ]);
    await handler.canUseTool("AskUserQuestion", input);

    // Guard fallback has escalate: true, so it should be written to escalated log
    expect(existsSync(escalatedPath)).toBe(true);
    const lines = readFileSync(escalatedPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2); // Both questions escalated
  });
});
