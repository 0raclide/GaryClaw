import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAskHandler } from "../src/ask-handler.js";
import type { OracleMemoryFiles } from "../src/types.js";

const TEST_DIR = join(tmpdir(), `garyclaw-ask-batch-test-${Date.now()}`);

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

describe("ask-handler batch integration", () => {
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

  function makeOracleResult(choice: string, confidence = 8) {
    return {
      choice,
      confidence,
      rationale: `Chose ${choice}`,
      principle: "Pragmatic",
      escalate: false,
      isTaste: false,
    };
  }

  describe("batching — multi-question calls", () => {
    it("calls askOracleBatch once for 2 questions (not askOracle twice)", async () => {
      const askOracle = vi.fn();
      const askOracleBatch = vi.fn().mockResolvedValue([
        makeOracleResult("Dark"),
        makeOracleResult("Sans-serif"),
      ]);

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle,
          askOracleBatch,
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
        },
      });

      const input = makeAskInput([
        { question: "Which theme?", options: themeOptions },
        { question: "Which font?", options: fontOptions },
      ]);

      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(askOracleBatch).toHaveBeenCalledTimes(1);
      expect(askOracle).not.toHaveBeenCalled();
      expect(result.behavior).toBe("allow");
      expect(result.updatedInput!.answers).toEqual({
        "Which theme?": "Dark",
        "Which font?": "Sans-serif",
      });
    });

    it("calls askOracleBatch once for 3 questions", async () => {
      const askOracleBatch = vi.fn().mockResolvedValue([
        makeOracleResult("Dark"),
        makeOracleResult("Sans-serif"),
        makeOracleResult("Grid"),
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

      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(askOracleBatch).toHaveBeenCalledTimes(1);
      expect(result.updatedInput!.answers).toEqual({
        "Which theme?": "Dark",
        "Which font?": "Sans-serif",
        "Which layout?": "Grid",
      });

      const decisions = handler.getDecisions();
      expect(decisions).toHaveLength(3);
      expect(decisions[0].question).toBe("Which theme?");
      expect(decisions[1].question).toBe("Which font?");
      expect(decisions[2].question).toBe("Which layout?");
    });

    it("records all decisions from batch", async () => {
      const askOracleBatch = vi.fn().mockResolvedValue([
        makeOracleResult("Dark", 9),
        makeOracleResult("Sans-serif", 7),
      ]);

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 2,
        autonomous: true,
        oracle: {
          askOracle: vi.fn(),
          askOracleBatch,
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "design-review",
        },
      });

      const input = makeAskInput([
        { question: "Theme?", options: themeOptions },
        { question: "Font?", options: fontOptions },
      ]);
      await handler.canUseTool("AskUserQuestion", input);

      const decisions = handler.getDecisions();
      expect(decisions).toHaveLength(2);
      expect(decisions[0].sessionIndex).toBe(2);
      expect(decisions[0].confidence).toBe(9);
      expect(decisions[0].chosen).toBe("Dark");
      expect(decisions[1].confidence).toBe(7);
      expect(decisions[1].chosen).toBe("Sans-serif");
    });

    it("writes all batch decisions to decision log", async () => {
      const logPath = join(TEST_DIR, "decisions.jsonl");

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        decisionLogPath: logPath,
        autonomous: true,
        oracle: {
          askOracle: vi.fn(),
          askOracleBatch: vi.fn().mockResolvedValue([
            makeOracleResult("Dark"),
            makeOracleResult("Sans-serif"),
          ]),
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
        },
      });

      const input = makeAskInput([
        { question: "Theme?", options: themeOptions },
        { question: "Font?", options: fontOptions },
      ]);
      await handler.canUseTool("AskUserQuestion", input);

      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).question).toBe("Theme?");
      expect(JSON.parse(lines[1]).question).toBe("Font?");
    });

    it("logs escalation per question in batch", async () => {
      const escalatedPath = join(TEST_DIR, "escalated.jsonl");

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        escalatedLogPath: escalatedPath,
        oracle: {
          askOracle: vi.fn(),
          askOracleBatch: vi.fn().mockResolvedValue([
            { ...makeOracleResult("Dark", 9), escalate: false },
            { ...makeOracleResult("Sans-serif", 3), escalate: true, isTaste: true },
          ]),
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
        },
      });

      const input = makeAskInput([
        { question: "Theme?", options: themeOptions },
        { question: "Font?", options: fontOptions },
      ]);
      await handler.canUseTool("AskUserQuestion", input);

      expect(existsSync(escalatedPath)).toBe(true);
      const lines = readFileSync(escalatedPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1); // Only Q2 escalated
      expect(JSON.parse(lines[0]).question).toBe("Font?");
    });

    it("handles otherProposal in batch results", async () => {
      const optionsWithOther = [
        { label: "Standard", description: "Standard fix" },
        { label: "Other", description: "Custom" },
      ];

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle: vi.fn(),
          askOracleBatch: vi.fn().mockResolvedValue([
            {
              choice: "Other",
              confidence: 7,
              rationale: "Custom needed",
              principle: "Pragmatic",
              escalate: false,
              isTaste: false,
              otherProposal: "Hybrid approach",
            },
            makeOracleResult("Dark"),
          ]),
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
        },
      });

      const input = makeAskInput([
        { question: "How to fix?", options: optionsWithOther },
        { question: "Theme?", options: themeOptions },
      ]);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(result.updatedInput!.answers).toEqual({
        "How to fix?": "Hybrid approach",
        "Theme?": "Dark",
      });

      const decisions = handler.getDecisions();
      expect(decisions[0].chosen).toBe("Other");
    });

    it("passes batch input with correct question ids", async () => {
      const askOracleBatch = vi.fn().mockResolvedValue([
        makeOracleResult("Dark"),
        makeOracleResult("Sans-serif"),
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
          projectContext: "React app",
          memory: { taste: "Prefer dark", domainExpertise: null, decisionOutcomes: null, memoryMd: null },
        },
      });

      const input = makeAskInput([
        { question: "Theme?", options: themeOptions },
        { question: "Font?", options: fontOptions },
      ]);
      await handler.canUseTool("AskUserQuestion", input);

      const batchInput = askOracleBatch.mock.calls[0][0];
      expect(batchInput.questions).toHaveLength(2);
      expect(batchInput.questions[0].id).toBe(1);
      expect(batchInput.questions[0].question).toBe("Theme?");
      expect(batchInput.questions[1].id).toBe(2);
      expect(batchInput.questions[1].question).toBe("Font?");
      expect(batchInput.skillName).toBe("qa");
      expect(batchInput.projectContext).toBe("React app");
      expect(batchInput.memory?.taste).toBe("Prefer dark");
    });

    it("passes accumulated decisions as decisionHistory to batch", async () => {
      const askOracleBatch = vi.fn().mockResolvedValue([
        makeOracleResult("Dark"),
        makeOracleResult("Sans-serif"),
      ]);

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle: vi.fn().mockResolvedValue(makeOracleResult("Grid")),
          askOracleBatch,
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
        },
      });

      // First call: single question (uses askOracle, not batch)
      await handler.canUseTool("AskUserQuestion", makeAskInput([
        { question: "Layout?", options: layoutOptions },
      ]));

      // Second call: batch — should include the first decision in history
      await handler.canUseTool("AskUserQuestion", makeAskInput([
        { question: "Theme?", options: themeOptions },
        { question: "Font?", options: fontOptions },
      ]));

      const batchInput = askOracleBatch.mock.calls[0][0];
      expect(batchInput.decisionHistory).toHaveLength(1);
      expect(batchInput.decisionHistory[0].question).toBe("Layout?");
    });
  });

  describe("fallback — single question uses askOracle", () => {
    it("uses askOracle (not batch) for single question even when batch available", async () => {
      const askOracle = vi.fn().mockResolvedValue(makeOracleResult("Dark"));
      const askOracleBatch = vi.fn();

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle,
          askOracleBatch,
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
        },
      });

      const input = makeAskInput([{ question: "Theme?", options: themeOptions }]);
      await handler.canUseTool("AskUserQuestion", input);

      expect(askOracle).toHaveBeenCalledTimes(1);
      expect(askOracleBatch).not.toHaveBeenCalled();
    });
  });

  describe("fallback — no batch function", () => {
    it("falls back to serial askOracle when askOracleBatch not provided", async () => {
      const askOracle = vi.fn()
        .mockResolvedValueOnce(makeOracleResult("Dark"))
        .mockResolvedValueOnce(makeOracleResult("Sans-serif"));

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle,
          // no askOracleBatch
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
        },
      });

      const input = makeAskInput([
        { question: "Theme?", options: themeOptions },
        { question: "Font?", options: fontOptions },
      ]);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(askOracle).toHaveBeenCalledTimes(2); // Serial, not batched
      expect(result.updatedInput!.answers).toEqual({
        "Theme?": "Dark",
        "Font?": "Sans-serif",
      });
    });
  });

  describe("human mode — unaffected by batching", () => {
    it("human mode ignores batch (still serial)", async () => {
      let callCount = 0;
      const onAskUser = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? "Dark" : "Sans-serif");
      });

      const handler = createAskHandler({
        onAskUser,
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: false,
        oracle: {
          askOracle: vi.fn(),
          askOracleBatch: vi.fn(),
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
        },
      });

      const input = makeAskInput([
        { question: "Theme?", options: themeOptions },
        { question: "Font?", options: fontOptions },
      ]);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(onAskUser).toHaveBeenCalledTimes(2);
      expect(result.updatedInput!.answers).toEqual({
        "Theme?": "Dark",
        "Font?": "Sans-serif",
      });
    });
  });
});
