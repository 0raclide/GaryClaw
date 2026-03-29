import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAskHandler } from "../src/ask-handler.js";
import type { OracleMemoryFiles } from "../src/types.js";

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

  describe("autonomous escalation", () => {
    const escalationOptions = [
      { label: "Delete all", description: "Delete all data" },
      { label: "Keep", description: "Keep existing data" },
    ];

    function makeOracleConfig(overrides: Partial<{
      escalate: boolean;
      confidence: number;
      choice: string;
    }> = {}) {
      const escalate = overrides.escalate ?? true;
      const confidence = overrides.confidence ?? 3;
      const choice = overrides.choice ?? "Keep";

      return {
        askOracle: vi.fn().mockResolvedValue({
          choice,
          confidence,
          rationale: "Data safety",
          principle: "Safety first",
          escalate,
          isTaste: false,
        }),
        config: { model: "test-model" as const },
        skillName: "qa",
      };
    }

    it("uses oracle's choice and does NOT call onAskUser in autonomous mode", async () => {
      const onAskUser = vi.fn().mockResolvedValue("Delete all");
      const handler = createAskHandler({
        onAskUser,
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: makeOracleConfig({ escalate: true, choice: "Keep", confidence: 3 }),
        escalatedLogPath: join(TEST_DIR, "escalated.jsonl"),
      });

      const input = makeSingleAskInput("Delete everything?", escalationOptions);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(onAskUser).not.toHaveBeenCalled();
      expect(result.behavior).toBe("allow");
      expect(result.updatedInput!.answers).toEqual({
        "Delete everything?": "Keep",
      });
    });

    it("logs escalation to escalated.jsonl in autonomous mode", async () => {
      const escalatedPath = join(TEST_DIR, "escalated.jsonl");
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: makeOracleConfig({ escalate: true, confidence: 2 }),
        escalatedLogPath: escalatedPath,
      });

      await handler.canUseTool(
        "AskUserQuestion",
        makeSingleAskInput("Delete everything?", escalationOptions),
      );

      expect(existsSync(escalatedPath)).toBe(true);
      const record = JSON.parse(readFileSync(escalatedPath, "utf-8").trim());
      expect(record.oracleConfidence).toBe(2);
      expect(record.escalateReason).toBe("security_concern");
    });

    it("falls through to onAskUser in non-autonomous mode (existing behavior)", async () => {
      const onAskUser = vi.fn().mockResolvedValue("Delete all");
      const handler = createAskHandler({
        onAskUser,
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: false,
        oracle: makeOracleConfig({ escalate: true, choice: "Keep", confidence: 3 }),
        escalatedLogPath: join(TEST_DIR, "escalated.jsonl"),
      });

      const input = makeSingleAskInput("Delete everything?", escalationOptions);
      const result = await handler.canUseTool("AskUserQuestion", input);

      // Non-autonomous: onAskUser IS called for escalated questions
      expect(onAskUser).toHaveBeenCalled();
      expect(result.updatedInput!.answers).toEqual({
        "Delete everything?": "Delete all",
      });
    });

    it("preserves oracle's confidence (not 10) in autonomous mode", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: makeOracleConfig({ escalate: true, confidence: 4, choice: "Keep" }),
        escalatedLogPath: join(TEST_DIR, "escalated.jsonl"),
      });

      await handler.canUseTool(
        "AskUserQuestion",
        makeSingleAskInput("Delete everything?", escalationOptions),
      );

      const decisions = handler.getDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].confidence).toBe(4);
      expect(decisions[0].chosen).toBe("Keep");
      expect(decisions[0].principle).toBe("Safety first");
    });
  });

  describe("otherProposal handling", () => {
    const optionsWithOther = [
      { label: "Fix it", description: "Standard fix" },
      { label: "Other", description: "Custom approach" },
    ];

    it("uses otherProposal as answer when oracle chooses Other", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle: vi.fn().mockResolvedValue({
            choice: "Other",
            confidence: 7,
            rationale: "Custom approach needed",
            principle: "Pragmatic",
            escalate: false,
            isTaste: false,
            otherProposal: "Use a hybrid approach combining linting and manual review",
          }),
          config: { model: "test-model" as const },
          skillName: "qa",
        },
      });

      const input = makeSingleAskInput("How should we fix?", optionsWithOther);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(result.updatedInput!.answers).toEqual({
        "How should we fix?": "Use a hybrid approach combining linting and manual review",
      });
    });

    it("records decision.chosen as 'Other' even when answer uses proposal", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle: vi.fn().mockResolvedValue({
            choice: "Other",
            confidence: 7,
            rationale: "Custom approach",
            principle: "Pragmatic",
            escalate: false,
            isTaste: false,
            otherProposal: "Custom answer text",
          }),
          config: { model: "test-model" as const },
          skillName: "qa",
        },
      });

      const input = makeSingleAskInput("Q?", optionsWithOther);
      await handler.canUseTool("AskUserQuestion", input);

      const decisions = handler.getDecisions();
      expect(decisions[0].chosen).toBe("Other");
    });

    it("falls back to 'Other' label when otherProposal is missing", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle: vi.fn().mockResolvedValue({
            choice: "Other",
            confidence: 7,
            rationale: "test",
            principle: "test",
            escalate: false,
            isTaste: false,
            // no otherProposal
          }),
          config: { model: "test-model" as const },
          skillName: "qa",
        },
      });

      const input = makeSingleAskInput("Q?", optionsWithOther);
      const result = await handler.canUseTool("AskUserQuestion", input);

      // Without otherProposal, answer should be the choice label itself
      expect(result.updatedInput!.answers).toEqual({ "Q?": "Other" });
    });

    it("uses choice label when not Other, even if otherProposal present", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle: vi.fn().mockResolvedValue({
            choice: "Fix it",
            confidence: 9,
            rationale: "Standard fix works",
            principle: "Pragmatic",
            escalate: false,
            isTaste: false,
            otherProposal: "This should be ignored",
          }),
          config: { model: "test-model" as const },
          skillName: "qa",
        },
      });

      const input = makeSingleAskInput("Q?", optionsWithOther);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(result.updatedInput!.answers).toEqual({ "Q?": "Fix it" });
    });
  });

  describe("oracle memory passing", () => {
    it("passes memory to oracle call", async () => {
      const mockAskOracle = vi.fn().mockResolvedValue({
        choice: "Dark",
        confidence: 8,
        rationale: "Matches taste",
        principle: "Pragmatic",
        escalate: false,
        isTaste: false,
      });

      const memory: OracleMemoryFiles = {
        taste: "Prefer dark themes",
        domainExpertise: null,
        decisionOutcomes: null,
        memoryMd: null,
      };

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle: mockAskOracle,
          config: { model: "test-model" as const },
          skillName: "qa",
          memory,
        },
      });

      const input = makeSingleAskInput("Theme?", [
        { label: "Dark", description: "Dark theme" },
        { label: "Light", description: "Light theme" },
      ]);
      await handler.canUseTool("AskUserQuestion", input);

      const oracleInput = mockAskOracle.mock.calls[0][0];
      expect(oracleInput.memory).toBe(memory);
      expect(oracleInput.memory.taste).toBe("Prefer dark themes");
    });

    it("passes undefined memory when not configured", async () => {
      const mockAskOracle = vi.fn().mockResolvedValue({
        choice: "Dark",
        confidence: 8,
        rationale: "test",
        principle: "test",
        escalate: false,
        isTaste: false,
      });

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle: mockAskOracle,
          config: { model: "test-model" as const },
          skillName: "qa",
          // no memory field
        },
      });

      const input = makeSingleAskInput("Theme?", [
        { label: "Dark", description: "Dark theme" },
      ]);
      await handler.canUseTool("AskUserQuestion", input);

      const oracleInput = mockAskOracle.mock.calls[0][0];
      expect(oracleInput.memory).toBeUndefined();
    });
  });

  describe("warn routing", () => {
    it("routes decision log write failure through onWarn callback", async () => {
      const onWarn = vi.fn();
      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Dark"),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        // Use an invalid path to trigger a write error
        decisionLogPath: "/dev/null/impossible/path/decisions.jsonl",
        onWarn,
      });

      await handler.canUseTool(
        "AskUserQuestion",
        makeSingleAskInput("Theme?", defaultOptions),
      );

      expect(onWarn).toHaveBeenCalledWith(
        expect.stringContaining("[GaryClaw] Failed to write decision log:"),
      );
    });

    it("routes escalated log write failure through onWarn in autonomous mode", async () => {
      const onWarn = vi.fn();
      const escOptions = [
        { label: "Delete all", description: "Delete all data" },
        { label: "Keep", description: "Keep existing data" },
      ];
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle: vi.fn().mockResolvedValue({
            choice: "Keep",
            confidence: 2,
            rationale: "Dangerous",
            principle: "Safety first",
            escalate: true,
            isTaste: false,
          }),
          config: { model: "test-model" as const },
          skillName: "qa",
        },
        escalatedLogPath: "/dev/null/impossible/path/escalated.jsonl",
        onWarn,
      });

      await handler.canUseTool(
        "AskUserQuestion",
        makeSingleAskInput("Delete?", escOptions),
      );

      expect(onWarn).toHaveBeenCalledWith(
        expect.stringContaining("[GaryClaw] Failed to write escalated log:"),
      );
    });

    it("falls back to console.warn when onWarn not provided", async () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Dark"),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        decisionLogPath: "/dev/null/impossible/path/decisions.jsonl",
        // No onWarn — should fall back to console.warn
      });

      await handler.canUseTool(
        "AskUserQuestion",
        makeSingleAskInput("Theme?", defaultOptions),
      );

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("[GaryClaw] Failed to write decision log:"),
      );
      spy.mockRestore();
    });
  });
});
