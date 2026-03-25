import { describe, it, expect, vi } from "vitest";
import { askOracle, DECISION_PRINCIPLES } from "../src/oracle.js";
import type { OracleConfig, OracleInput } from "../src/oracle.js";

function makeInput(overrides: Partial<OracleInput> = {}): OracleInput {
  return {
    question: "Which approach should we use?",
    options: [
      { label: "Approach A", description: "Simple and explicit" },
      { label: "Approach B", description: "Complex but thorough" },
    ],
    skillName: "qa",
    decisionHistory: [],
    ...overrides,
  };
}

function makeConfig(
  response: string,
  overrides: Partial<OracleConfig> = {},
): OracleConfig {
  return {
    queryFn: vi.fn().mockResolvedValue(response),
    escalateThreshold: 6,
    ...overrides,
  };
}

describe("oracle", () => {
  describe("askOracle — successful decisions", () => {
    it("parses a well-formed JSON response", async () => {
      const config = makeConfig(
        JSON.stringify({
          choice: "Approach A",
          confidence: 9,
          rationale: "Simple and explicit aligns with principle 5",
          principle: "Explicit over clever",
        }),
      );

      const result = await askOracle(makeInput(), config);

      expect(result.choice).toBe("Approach A");
      expect(result.confidence).toBe(9);
      expect(result.rationale).toContain("Simple and explicit");
      expect(result.principle).toBe("Explicit over clever");
      expect(result.isTaste).toBe(false); // confidence 9 >= threshold 6
      expect(result.escalate).toBe(false);
    });

    it("extracts JSON from surrounding text", async () => {
      const config = makeConfig(
        'Here is my decision:\n{"choice": "Approach B", "confidence": 7, "rationale": "More thorough", "principle": "Choose completeness"}\nThat is my answer.',
      );

      const result = await askOracle(makeInput(), config);
      expect(result.choice).toBe("Approach B");
      expect(result.confidence).toBe(7);
    });

    it("handles case-insensitive label matching", async () => {
      const config = makeConfig(
        JSON.stringify({
          choice: "approach a",
          confidence: 8,
          rationale: "test",
          principle: "test",
        }),
      );

      const result = await askOracle(makeInput(), config);
      expect(result.choice).toBe("Approach A"); // Resolved to exact label
    });

    it("handles partial label matching", async () => {
      const config = makeConfig(
        JSON.stringify({
          choice: "Approach A (Recommended)",
          confidence: 8,
          rationale: "test",
          principle: "test",
        }),
      );

      const result = await askOracle(makeInput(), config);
      expect(result.choice).toBe("Approach A"); // Resolved via partial match
    });
  });

  describe("askOracle — confidence and escalation", () => {
    it("marks low-confidence decisions as taste decisions", async () => {
      const config = makeConfig(
        JSON.stringify({
          choice: "Approach A",
          confidence: 4,
          rationale: "Both are viable",
          principle: "Pragmatic",
        }),
      );

      const result = await askOracle(makeInput(), config);
      expect(result.isTaste).toBe(true); // 4 < threshold 6
      expect(result.escalate).toBe(true);
    });

    it("escalates security-related questions", async () => {
      const config = makeConfig(
        JSON.stringify({
          choice: "Yes",
          confidence: 9,
          rationale: "Need to update credentials",
          principle: "Bias toward action",
        }),
      );

      const input = makeInput({
        question: "Should we update the API key in production?",
        options: [
          { label: "Yes", description: "Update the credential" },
          { label: "No", description: "Keep existing" },
        ],
      });

      const result = await askOracle(input, config);
      expect(result.escalate).toBe(true); // "API key" + "production" trigger escalation
    });

    it("escalates destructive operations", async () => {
      const config = makeConfig(
        JSON.stringify({
          choice: "Delete",
          confidence: 8,
          rationale: "Clean slate",
          principle: "Bias toward action",
        }),
      );

      const input = makeInput({
        question: "How should we handle the old data?",
        options: [
          { label: "Delete", description: "Remove all user data" },
          { label: "Archive", description: "Keep in cold storage" },
        ],
      });

      const result = await askOracle(input, config);
      expect(result.escalate).toBe(true); // "delete" + "user data"
    });

    it("does not escalate safe questions with high confidence", async () => {
      const config = makeConfig(
        JSON.stringify({
          choice: "Dark",
          confidence: 9,
          rationale: "User preference",
          principle: "Pragmatic",
        }),
      );

      const input = makeInput({
        question: "Which color theme?",
        options: [
          { label: "Dark", description: "Dark theme" },
          { label: "Light", description: "Light theme" },
        ],
      });

      const result = await askOracle(input, config);
      expect(result.escalate).toBe(false);
    });
  });

  describe("askOracle — error handling", () => {
    it("returns fallback on oracle call failure", async () => {
      const config = makeConfig("", {
        queryFn: vi.fn().mockRejectedValue(new Error("API timeout")),
      });

      const result = await askOracle(makeInput(), config);
      expect(result.choice).toBe("Approach A"); // Falls back to first option
      expect(result.confidence).toBe(1);
      expect(result.escalate).toBe(true);
      expect(result.rationale).toContain("Oracle call failed");
    });

    it("returns fallback on non-JSON response", async () => {
      const config = makeConfig("I think Approach A is better because...");

      const result = await askOracle(makeInput(), config);
      // Should fall back since no JSON object is found
      expect(result.confidence).toBeLessThan(6);
    });

    it("returns fallback on malformed JSON", async () => {
      const config = makeConfig('{"choice": "bad json...');

      const result = await askOracle(makeInput(), config);
      expect(result.confidence).toBeLessThan(6);
    });

    it("clamps confidence to 1-10 range", async () => {
      const config = makeConfig(
        JSON.stringify({
          choice: "Approach A",
          confidence: 15,
          rationale: "test",
          principle: "test",
        }),
      );

      const result = await askOracle(makeInput(), config);
      expect(result.confidence).toBe(10);
    });

    it("defaults unknown choice to first option", async () => {
      const config = makeConfig(
        JSON.stringify({
          choice: "Nonexistent Option",
          confidence: 7,
          rationale: "test",
          principle: "test",
        }),
      );

      const result = await askOracle(makeInput(), config);
      expect(result.choice).toBe("Approach A");
    });
  });

  describe("askOracle — context passing", () => {
    it("passes decision history to the prompt", async () => {
      const queryFn = vi.fn().mockResolvedValue(
        JSON.stringify({
          choice: "Approach A",
          confidence: 8,
          rationale: "Consistent",
          principle: "DRY",
        }),
      );

      const input = makeInput({
        decisionHistory: [
          {
            timestamp: "2026-03-25T10:00:00Z",
            sessionIndex: 0,
            question: "Previous question?",
            options: [],
            chosen: "Yes",
            confidence: 9,
            rationale: "Prior decision",
            principle: "Bias toward action",
          },
        ],
      });

      await askOracle(input, { queryFn, escalateThreshold: 6 });

      const prompt = queryFn.mock.calls[0][0] as string;
      expect(prompt).toContain("Previous question?");
      expect(prompt).toContain("Bias toward action");
    });

    it("includes project context when provided", async () => {
      const queryFn = vi.fn().mockResolvedValue(
        JSON.stringify({
          choice: "Approach A",
          confidence: 8,
          rationale: "test",
          principle: "test",
        }),
      );

      const input = makeInput({
        projectContext: "This is a React app using TypeScript",
      });

      await askOracle(input, { queryFn, escalateThreshold: 6 });

      const prompt = queryFn.mock.calls[0][0] as string;
      expect(prompt).toContain("React app using TypeScript");
    });
  });

  describe("DECISION_PRINCIPLES", () => {
    it("contains all 6 principles", () => {
      expect(DECISION_PRINCIPLES).toContain("Choose completeness");
      expect(DECISION_PRINCIPLES).toContain("Boil lakes");
      expect(DECISION_PRINCIPLES).toContain("Pragmatic");
      expect(DECISION_PRINCIPLES).toContain("DRY");
      expect(DECISION_PRINCIPLES).toContain("Explicit over clever");
      expect(DECISION_PRINCIPLES).toContain("Bias toward action");
    });
  });
});
