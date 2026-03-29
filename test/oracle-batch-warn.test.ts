import { describe, it, expect, vi } from "vitest";
import {
  askOracleBatch,
  parseBatchOracleResponse,
} from "../src/oracle.js";
import type {
  OracleConfig,
  OracleBatchQuestion,
} from "../src/oracle.js";

function makeQuestions(count: number): OracleBatchQuestion[] {
  const templates = [
    {
      question: "Which theme?",
      options: [
        { label: "Dark", description: "Dark theme" },
        { label: "Light", description: "Light theme" },
      ],
    },
    {
      question: "Which font?",
      options: [
        { label: "Sans-serif", description: "Clean" },
        { label: "Serif", description: "Classic" },
      ],
    },
  ];

  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    ...(templates[i % templates.length]),
  }));
}

describe("parseBatchOracleResponse onWarn callback", () => {
  describe("happy path — no warnings", () => {
    it("does not call onWarn when JSON array parses correctly", () => {
      const onWarn = vi.fn();
      const questions = makeQuestions(2);
      const raw = JSON.stringify([
        { choice: "Dark", confidence: 8, rationale: "R1", principle: "P1" },
        { choice: "Sans-serif", confidence: 9, rationale: "R2", principle: "P2" },
      ]);

      parseBatchOracleResponse(raw, questions, onWarn);

      expect(onWarn).not.toHaveBeenCalled();
    });
  });

  describe("fallback path 1 — array length mismatch", () => {
    it("calls onWarn with length mismatch message", () => {
      const onWarn = vi.fn();
      const questions = makeQuestions(2);
      // Return array with only 1 element for 2 questions
      const raw = JSON.stringify([
        { choice: "Dark", confidence: 8, rationale: "R1", principle: "P1" },
      ]);

      parseBatchOracleResponse(raw, questions, onWarn);

      expect(onWarn).toHaveBeenCalledWith(
        expect.stringContaining("length mismatch"),
      );
    });

    it("does NOT call console.warn when onWarn is provided", () => {
      const onWarn = vi.fn();
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const questions = makeQuestions(2);
      const raw = JSON.stringify([
        { choice: "Dark", confidence: 8, rationale: "R1", principle: "P1" },
      ]);

      parseBatchOracleResponse(raw, questions, onWarn);

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("fallback path 2 — JSON array parse failure", () => {
    it("calls onWarn with parse failed message", () => {
      const onWarn = vi.fn();
      const questions = makeQuestions(2);
      // Malformed JSON array that regex matches but JSON.parse fails on,
      // and no individual JSON objects to fall back to
      const raw = `[not valid json at all]`;

      parseBatchOracleResponse(raw, questions, onWarn);

      expect(onWarn).toHaveBeenCalledWith(
        expect.stringContaining("JSON array parse failed"),
      );
    });
  });

  describe("fallback path 3 — individual JSON object fallback", () => {
    it("calls onWarn with individual object fallback message", () => {
      const onWarn = vi.fn();
      const questions = makeQuestions(2);
      // No array wrapper, just individual JSON objects
      const raw = `{"choice": "Dark", "confidence": 8, "rationale": "R1", "principle": "P1"}
{"choice": "Sans-serif", "confidence": 9, "rationale": "R2", "principle": "P2"}`;

      parseBatchOracleResponse(raw, questions, onWarn);

      expect(onWarn).toHaveBeenCalledWith(
        expect.stringContaining("individual JSON object fallback"),
      );
    });
  });

  describe("fallback path 4 — complete fallback", () => {
    it("calls onWarn with complete fallback message", () => {
      const onWarn = vi.fn();
      const questions = makeQuestions(2);
      // No parseable JSON at all
      const raw = "I cannot decide on anything, sorry.";

      parseBatchOracleResponse(raw, questions, onWarn);

      expect(onWarn).toHaveBeenCalledWith(
        expect.stringContaining("Complete fallback"),
      );
    });

    it("still returns fallback choices", () => {
      const onWarn = vi.fn();
      const questions = makeQuestions(2);
      const raw = "No JSON here";

      const results = parseBatchOracleResponse(raw, questions, onWarn);

      expect(results).toHaveLength(2);
      expect(results[0].choice).toBe("Dark"); // first option label
      expect(results[1].choice).toBe("Sans-serif");
    });
  });

  describe("default behavior — no onWarn provided", () => {
    it("falls back to console.warn when onWarn is omitted", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const questions = makeQuestions(2);
      const raw = "No JSON here";

      parseBatchOracleResponse(raw, questions);

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("Complete fallback"),
      );
      spy.mockRestore();
    });

    it("falls back to console.warn when onWarn is undefined", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const questions = makeQuestions(2);
      const raw = "No JSON here";

      parseBatchOracleResponse(raw, questions, undefined);

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("Complete fallback"),
      );
      spy.mockRestore();
    });
  });

  describe("askOracleBatch threads onWarn", () => {
    it("passes onWarn to parseBatchOracleResponse", async () => {
      const onWarn = vi.fn();
      // Return unparseable response to trigger complete fallback
      const config: OracleConfig = {
        queryFn: vi.fn().mockResolvedValue("no json"),
        escalateThreshold: 6,
      };

      const result = await askOracleBatch(
        {
          questions: makeQuestions(2),
          skillName: "qa",
          decisionHistory: [],
        },
        config,
        onWarn,
      );

      expect(onWarn).toHaveBeenCalledWith(
        expect.stringContaining("Complete fallback"),
      );
      expect(result).toHaveLength(2);
    });

    it("does not pass onWarn for single question (delegates to askOracle)", async () => {
      const onWarn = vi.fn();
      const config: OracleConfig = {
        queryFn: vi.fn().mockResolvedValue(JSON.stringify({
          choice: "Dark",
          confidence: 9,
          rationale: "Good",
          principle: "P1",
        })),
        escalateThreshold: 6,
      };

      await askOracleBatch(
        {
          questions: makeQuestions(1),
          skillName: "qa",
          decisionHistory: [],
        },
        config,
        onWarn,
      );

      // Single question delegates to askOracle, which doesn't use onWarn
      // onWarn should NOT be called (askOracle has its own path)
      expect(onWarn).not.toHaveBeenCalled();
    });
  });
});
