// Regression: ISSUE-001 — config.onWarn not verified as threaded to askOracleBatch
// Found by /qa on 2026-03-29
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAskHandler } from "../src/ask-handler.js";

const TEST_DIR = join(tmpdir(), `garyclaw-ask-batch-reg2-${Date.now()}`);

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
  }>,
): Record<string, unknown> {
  return {
    questions: questions.map((q) => ({
      ...q,
      header: "Test",
      multiSelect: false,
    })),
  };
}

describe("ask-handler batch — onWarn threading to askOracleBatch", () => {
  const themeOptions = [
    { label: "Dark", description: "Dark theme" },
    { label: "Light", description: "Light theme" },
  ];

  const fontOptions = [
    { label: "Sans-serif", description: "Clean" },
    { label: "Serif", description: "Classic" },
  ];

  it("threads config.onWarn as the 3rd argument to askOracleBatch", async () => {
    const onWarn = vi.fn();
    const askOracleBatch = vi.fn().mockResolvedValue([
      {
        choice: "Dark",
        confidence: 8,
        rationale: "Preference",
        principle: "P1",
        escalate: false,
        isTaste: false,
      },
      {
        choice: "Sans-serif",
        confidence: 9,
        rationale: "Clean",
        principle: "P2",
        escalate: false,
        isTaste: false,
      },
    ]);

    const handler = createAskHandler({
      onAskUser: vi.fn(),
      askTimeoutMs: 5000,
      sessionIndex: 0,
      autonomous: true,
      onWarn,
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
    ]);

    await handler.canUseTool("AskUserQuestion", input);

    // Verify askOracleBatch was called with onWarn as the 3rd argument
    expect(askOracleBatch).toHaveBeenCalledTimes(1);
    expect(askOracleBatch).toHaveBeenCalledWith(
      expect.any(Object), // batchInput
      expect.any(Object), // config
      onWarn,             // onWarn callback — the critical threading
    );
  });

  it("passes undefined when config.onWarn is not set", async () => {
    const askOracleBatch = vi.fn().mockResolvedValue([
      {
        choice: "Dark",
        confidence: 8,
        rationale: "Preference",
        principle: "P1",
        escalate: false,
        isTaste: false,
      },
      {
        choice: "Sans-serif",
        confidence: 9,
        rationale: "Clean",
        principle: "P2",
        escalate: false,
        isTaste: false,
      },
    ]);

    const handler = createAskHandler({
      onAskUser: vi.fn(),
      askTimeoutMs: 5000,
      sessionIndex: 0,
      autonomous: true,
      // No onWarn
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
    ]);

    await handler.canUseTool("AskUserQuestion", input);

    // 3rd arg should be undefined when no onWarn provided
    expect(askOracleBatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      undefined,
    );
  });

  it("single question bypasses batch — onWarn is not passed to askOracle", async () => {
    const onWarn = vi.fn();
    const askOracle = vi.fn().mockResolvedValue({
      choice: "Dark",
      confidence: 8,
      rationale: "Preference",
      principle: "P1",
      escalate: false,
      isTaste: false,
    });
    const askOracleBatch = vi.fn();

    const handler = createAskHandler({
      onAskUser: vi.fn(),
      askTimeoutMs: 5000,
      sessionIndex: 0,
      autonomous: true,
      onWarn,
      oracle: {
        askOracle,
        askOracleBatch,
        config: { queryFn: vi.fn(), escalateThreshold: 6 },
        skillName: "qa",
      },
    });

    const input = makeAskInput([
      { question: "Which theme?", options: themeOptions },
    ]);

    await handler.canUseTool("AskUserQuestion", input);

    // Single question: askOracle is called, not askOracleBatch
    expect(askOracle).toHaveBeenCalledTimes(1);
    expect(askOracleBatch).not.toHaveBeenCalled();
  });
});
