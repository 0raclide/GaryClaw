import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAskHandler } from "../src/ask-handler.js";

const TEST_DIR = join(tmpdir(), `garyclaw-ask-test-${Date.now()}`);

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

function makeSingleAskInput(
  question: string,
  options: { label: string; description: string }[],
  multiSelect = false,
): Record<string, unknown> {
  return makeAskInput([{ question, options, multiSelect }]);
}

describe("ask-handler", () => {
  const defaultOptions = [
    { label: "Dark", description: "Dark theme" },
    { label: "Light", description: "Light theme" },
  ];

  describe("canUseTool — non-AskUserQuestion", () => {
    it("passes through non-AskUserQuestion tools", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const result = await handler.canUseTool("Bash", { command: "ls" });
      expect(result.behavior).toBe("allow");
      expect(result.updatedInput).toBeUndefined();
    });

    it("passes through Read, Edit, Glob, Grep", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      for (const tool of ["Read", "Edit", "Glob", "Grep"]) {
        const result = await handler.canUseTool(tool, {});
        expect(result.behavior).toBe("allow");
      }
    });
  });

  describe("canUseTool — single question", () => {
    it("intercepts AskUserQuestion and calls onAskUser", async () => {
      const onAskUser = vi.fn().mockResolvedValue("Dark");
      const handler = createAskHandler({
        onAskUser,
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const input = makeSingleAskInput("Which color theme?", defaultOptions);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(onAskUser).toHaveBeenCalledWith("Which color theme?", defaultOptions, false);
      expect(result.behavior).toBe("allow");
    });

    it("builds updatedInput with pre-filled answer", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Dark"),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const input = makeSingleAskInput("Which color theme?", defaultOptions);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(result.updatedInput).toBeDefined();
      expect(result.updatedInput!.answers).toEqual({
        "Which color theme?": "Dark",
      });
    });

    it("records decision with full context", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Light"),
        askTimeoutMs: 5000,
        sessionIndex: 2,
      });

      const input = makeSingleAskInput("Which theme?", defaultOptions);
      await handler.canUseTool("AskUserQuestion", input);

      const decisions = handler.getDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].question).toBe("Which theme?");
      expect(decisions[0].chosen).toBe("Light");
      expect(decisions[0].sessionIndex).toBe(2);
      expect(decisions[0].confidence).toBe(10);
    });
  });

  describe("canUseTool — multiple questions", () => {
    it("handles multiple questions in a single call", async () => {
      let callCount = 0;
      const onAskUser = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? "Dark" : "Sans-serif");
      });

      const handler = createAskHandler({
        onAskUser,
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const input = makeAskInput([
        { question: "Which theme?", options: defaultOptions },
        {
          question: "Which font?",
          options: [
            { label: "Sans-serif", description: "Clean" },
            { label: "Serif", description: "Classic" },
          ],
        },
      ]);

      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(onAskUser).toHaveBeenCalledTimes(2);
      expect(result.updatedInput!.answers).toEqual({
        "Which theme?": "Dark",
        "Which font?": "Sans-serif",
      });

      const decisions = handler.getDecisions();
      expect(decisions).toHaveLength(2);
      expect(decisions[0].question).toBe("Which theme?");
      expect(decisions[1].question).toBe("Which font?");
    });
  });

  describe("canUseTool — multiSelect", () => {
    it("passes multiSelect flag to onAskUser", async () => {
      const onAskUser = vi.fn().mockResolvedValue("Dark, Blue");

      const handler = createAskHandler({
        onAskUser,
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const input = makeSingleAskInput("Which themes?", defaultOptions, true);
      await handler.canUseTool("AskUserQuestion", input);

      expect(onAskUser).toHaveBeenCalledWith("Which themes?", defaultOptions, true);
    });
  });

  describe("canUseTool — edge cases", () => {
    it("allows AskUserQuestion with empty questions array", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const result = await handler.canUseTool("AskUserQuestion", { questions: [] });
      expect(result.behavior).toBe("allow");
      expect(result.updatedInput).toBeUndefined();
    });

    it("allows AskUserQuestion with no questions field", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const result = await handler.canUseTool("AskUserQuestion", {});
      expect(result.behavior).toBe("allow");
    });
  });

  describe("canUseTool — timeout", () => {
    it("denies on timeout", async () => {
      const handler = createAskHandler({
        onAskUser: () => new Promise(() => {}), // Never resolves
        askTimeoutMs: 50,
        sessionIndex: 0,
      });

      const input = makeSingleAskInput("Slow question?", defaultOptions);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(result.behavior).toBe("deny");
      expect(result.message).toContain("timed out");
    });

    it("denies on onAskUser rejection", async () => {
      const handler = createAskHandler({
        onAskUser: () => Promise.reject(new Error("readline closed")),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const input = makeSingleAskInput("Error question?", defaultOptions);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(result.behavior).toBe("deny");
      expect(result.message).toContain("handler error");
    });
  });

  describe("decision audit log", () => {
    it("writes decisions to JSONL file", async () => {
      const logPath = join(TEST_DIR, "decisions.jsonl");
      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Dark"),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        decisionLogPath: logPath,
      });

      await handler.canUseTool("AskUserQuestion", makeSingleAskInput("Q?", defaultOptions));

      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0]);
      expect(record.question).toBe("Q?");
      expect(record.chosen).toBe("Dark");
    });

    it("appends multiple decisions to same file", async () => {
      const logPath = join(TEST_DIR, "decisions.jsonl");
      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Dark"),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        decisionLogPath: logPath,
      });

      await handler.canUseTool("AskUserQuestion", makeSingleAskInput("Q1?", defaultOptions));
      await handler.canUseTool("AskUserQuestion", makeSingleAskInput("Q2?", defaultOptions));

      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
    });

    it("creates parent directory if it doesn't exist", async () => {
      const logPath = join(TEST_DIR, "nested", "deep", "decisions.jsonl");
      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Dark"),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        decisionLogPath: logPath,
      });

      await handler.canUseTool("AskUserQuestion", makeSingleAskInput("Q?", defaultOptions));
      expect(existsSync(logPath)).toBe(true);
    });
  });

  describe("getDecisions", () => {
    it("returns empty array when no decisions made", () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });
      expect(handler.getDecisions()).toEqual([]);
    });

    it("returns a copy (not a reference)", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Dark"),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      await handler.canUseTool("AskUserQuestion", makeSingleAskInput("Q?", defaultOptions));

      const d1 = handler.getDecisions();
      const d2 = handler.getDecisions();
      expect(d1).not.toBe(d2);
      expect(d1).toEqual(d2);
    });
  });
});
