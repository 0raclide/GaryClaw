/**
 * Oracle extended tests — buildOraclePrompt construction, parseOracleResponse
 * edge cases, resolveChoice matching, confidence boundary handling.
 */

import { describe, it, expect, vi } from "vitest";
import { askOracle, DECISION_PRINCIPLES } from "../src/oracle.js";
import type { OracleInput, OracleConfig } from "../src/oracle.js";

function createInput(overrides: Partial<OracleInput> = {}): OracleInput {
  return {
    question: "Which approach should we take?",
    options: [
      { label: "Complete", description: "Full implementation" },
      { label: "Quick", description: "Fast shortcut" },
    ],
    skillName: "qa",
    decisionHistory: [],
    ...overrides,
  };
}

function createConfig(queryResponse: string): OracleConfig {
  return {
    queryFn: vi.fn().mockResolvedValue(queryResponse),
    escalateThreshold: 6,
  };
}

describe("Oracle — Extended", () => {
  // ── Response parsing edge cases ────────────────────────────

  describe("parseOracleResponse", () => {
    it("parses valid JSON response", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Complete",
        confidence: 9,
        rationale: "Better coverage",
        principle: "Choose completeness",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.choice).toBe("Complete");
      expect(result.confidence).toBe(9);
      expect(result.rationale).toBe("Better coverage");
      expect(result.principle).toBe("Choose completeness");
    });

    it("extracts JSON embedded in markdown fences", async () => {
      const response = 'Here is my decision:\n```json\n{"choice":"Quick","confidence":7,"rationale":"Faster","principle":"Pragmatic"}\n```';
      const config = createConfig(response);

      const result = await askOracle(createInput(), config);
      expect(result.choice).toBe("Quick");
      expect(result.confidence).toBe(7);
    });

    it("falls back to first option when no JSON found", async () => {
      const config = createConfig("I think we should go with the complete approach.");

      const result = await askOracle(createInput(), config);
      expect(result.choice).toBe("Complete");
      expect(result.confidence).toBe(3); // fallback confidence
    });

    it("falls back on malformed JSON", async () => {
      const config = createConfig('{"choice": "Complete", confidence: }');

      const result = await askOracle(createInput(), config);
      // The regex matches the outer { }, but JSON.parse fails
      expect(result.confidence).toBe(3);
    });

    it("clamps confidence to 1-10 range", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Complete",
        confidence: 15,
        rationale: "Sure",
        principle: "P1",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.confidence).toBe(10);
    });

    it("clamps negative confidence to 1", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Complete",
        confidence: -5,
        rationale: "Sure",
        principle: "P1",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.confidence).toBe(1);
    });

    it("defaults confidence to 5 when not a number", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Complete",
        confidence: "high",
        rationale: "Sure",
        principle: "P1",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.confidence).toBe(5);
    });

    it("defaults rationale when missing", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Complete",
        confidence: 8,
      }));

      const result = await askOracle(createInput(), config);
      expect(result.rationale).toBe("No rationale provided");
    });

    it("defaults principle when missing", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Complete",
        confidence: 8,
      }));

      const result = await askOracle(createInput(), config);
      expect(result.principle).toBe("Bias toward action");
    });
  });

  // ── resolveChoice matching ─────────────────────────────────

  describe("resolveChoice", () => {
    it("matches exact label", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Complete",
        confidence: 9,
        rationale: "r",
        principle: "p",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.choice).toBe("Complete");
    });

    it("matches case-insensitive label", async () => {
      const config = createConfig(JSON.stringify({
        choice: "complete",
        confidence: 9,
        rationale: "r",
        principle: "p",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.choice).toBe("Complete");
    });

    it("matches partial label (oracle adds extra text)", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Complete (Recommended)",
        confidence: 9,
        rationale: "r",
        principle: "p",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.choice).toBe("Complete");
    });

    it("falls back to first option when no label match", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Nonexistent Option",
        confidence: 9,
        rationale: "r",
        principle: "p",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.choice).toBe("Complete");
    });

    it("falls back to first option when choice is null", async () => {
      const config = createConfig(JSON.stringify({
        choice: null,
        confidence: 9,
        rationale: "r",
        principle: "p",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.choice).toBe("Complete");
    });

    it("falls back to first option when choice is empty string", async () => {
      const config = createConfig(JSON.stringify({
        choice: "",
        confidence: 9,
        rationale: "r",
        principle: "p",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.choice).toBe("Complete");
    });
  });

  // ── Escalation logic ───────────────────────────────────────

  describe("escalation", () => {
    it("escalates when confidence is below threshold", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Complete",
        confidence: 4,
        rationale: "Not sure",
        principle: "P1",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.escalate).toBe(true);
      expect(result.isTaste).toBe(true);
    });

    it("does not escalate when confidence is at threshold", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Complete",
        confidence: 6,
        rationale: "Sure",
        principle: "P1",
      }));

      const result = await askOracle(createInput(), config);
      // confidence == threshold (6) means NOT below threshold
      expect(result.escalate).toBe(false);
      expect(result.isTaste).toBe(false);
    });

    it("escalates when question contains security keywords", async () => {
      const input = createInput({
        question: "Should we delete the production database?",
      });
      const config = createConfig(JSON.stringify({
        choice: "Complete",
        confidence: 10,
        rationale: "Sure",
        principle: "P1",
      }));

      const result = await askOracle(input, config);
      expect(result.escalate).toBe(true);
    });

    it("escalates when options contain security keywords", async () => {
      const input = createInput({
        options: [
          { label: "Deploy", description: "Force push to production" },
          { label: "Skip", description: "Don't deploy" },
        ],
      });
      const config = createConfig(JSON.stringify({
        choice: "Deploy",
        confidence: 10,
        rationale: "r",
        principle: "p",
      }));

      const result = await askOracle(input, config);
      expect(result.escalate).toBe(true);
    });

    it("does not escalate for safe questions with high confidence", async () => {
      const config = createConfig(JSON.stringify({
        choice: "Complete",
        confidence: 9,
        rationale: "Clear choice",
        principle: "P1",
      }));

      const result = await askOracle(createInput(), config);
      expect(result.escalate).toBe(false);
    });

    it("detects various security keywords", async () => {
      const keywords = ["api key", "credential", "password", "vulnerability", "pii", "gdpr"];
      for (const kw of keywords) {
        const input = createInput({ question: `Handle the ${kw} issue` });
        const config = createConfig(JSON.stringify({
          choice: "Complete",
          confidence: 10,
          rationale: "r",
          principle: "p",
        }));
        const result = await askOracle(input, config);
        expect(result.escalate).toBe(true);
      }
    });
  });

  // ── Oracle call failure ────────────────────────────────────

  describe("oracle failure", () => {
    it("returns low-confidence escalation on queryFn error", async () => {
      const config: OracleConfig = {
        queryFn: vi.fn().mockRejectedValue(new Error("API timeout")),
        escalateThreshold: 6,
      };

      const result = await askOracle(createInput(), config);
      expect(result.confidence).toBe(1);
      expect(result.escalate).toBe(true);
      expect(result.rationale).toContain("API timeout");
    });

    it("uses first option label on failure", async () => {
      const config: OracleConfig = {
        queryFn: vi.fn().mockRejectedValue(new Error("fail")),
        escalateThreshold: 6,
      };

      const result = await askOracle(createInput(), config);
      expect(result.choice).toBe("Complete");
    });
  });

  // ── Decision history in prompt ─────────────────────────────

  describe("decision history", () => {
    it("includes recent decisions when provided", async () => {
      const queryFn = vi.fn().mockResolvedValue(JSON.stringify({
        choice: "Complete",
        confidence: 8,
        rationale: "r",
        principle: "p",
      }));

      const input = createInput({
        decisionHistory: [
          {
            question: "Previous Q?",
            chosen: "Option A",
            confidence: 9,
            rationale: "Because",
            principle: "P1",
            timestamp: new Date().toISOString(),
          },
        ],
      });

      await askOracle(input, { queryFn, escalateThreshold: 6 });

      const promptArg = queryFn.mock.calls[0][0] as string;
      expect(promptArg).toContain("Recent Decisions");
      expect(promptArg).toContain("Previous Q?");
      expect(promptArg).toContain("Option A");
    });

    it("limits to last 5 decisions", async () => {
      const queryFn = vi.fn().mockResolvedValue(JSON.stringify({
        choice: "Complete",
        confidence: 8,
        rationale: "r",
        principle: "p",
      }));

      const history = Array.from({ length: 10 }, (_, i) => ({
        question: `Q${i}`,
        chosen: `A${i}`,
        confidence: 8,
        rationale: "r",
        principle: "p",
        timestamp: new Date().toISOString(),
      }));

      await askOracle(
        createInput({ decisionHistory: history }),
        { queryFn, escalateThreshold: 6 },
      );

      const promptArg = queryFn.mock.calls[0][0] as string;
      expect(promptArg).toContain("last 5");
      // Should include Q5-Q9 (last 5), not Q0-Q4
      expect(promptArg).toContain("Q9");
      expect(promptArg).not.toContain("Q0");
    });

    it("skips decision history section when empty", async () => {
      const queryFn = vi.fn().mockResolvedValue(JSON.stringify({
        choice: "Complete",
        confidence: 8,
        rationale: "r",
        principle: "p",
      }));

      await askOracle(createInput(), { queryFn, escalateThreshold: 6 });

      const promptArg = queryFn.mock.calls[0][0] as string;
      expect(promptArg).not.toContain("Recent Decisions");
    });
  });

  // ── Project context ────────────────────────────────────────

  describe("project context", () => {
    it("includes project context when provided", async () => {
      const queryFn = vi.fn().mockResolvedValue(JSON.stringify({
        choice: "Complete",
        confidence: 8,
        rationale: "r",
        principle: "p",
      }));

      await askOracle(
        createInput({ projectContext: "Node.js TypeScript CLI tool" }),
        { queryFn, escalateThreshold: 6 },
      );

      const promptArg = queryFn.mock.calls[0][0] as string;
      expect(promptArg).toContain("Node.js TypeScript CLI tool");
    });

    it("truncates long project context to 500 chars", async () => {
      const queryFn = vi.fn().mockResolvedValue(JSON.stringify({
        choice: "Complete",
        confidence: 8,
        rationale: "r",
        principle: "p",
      }));

      const longContext = "x".repeat(1000);
      await askOracle(
        createInput({ projectContext: longContext }),
        { queryFn, escalateThreshold: 6 },
      );

      const promptArg = queryFn.mock.calls[0][0] as string;
      // Should not contain the full 1000-char string
      expect(promptArg).not.toContain(longContext);
    });

    it("omits project context line when not provided", async () => {
      const queryFn = vi.fn().mockResolvedValue(JSON.stringify({
        choice: "Complete",
        confidence: 8,
        rationale: "r",
        principle: "p",
      }));

      await askOracle(createInput(), { queryFn, escalateThreshold: 6 });

      const promptArg = queryFn.mock.calls[0][0] as string;
      expect(promptArg).not.toContain("Project:");
    });
  });

  // ── Prompt structure ───────────────────────────────────────

  describe("prompt structure", () => {
    it("includes decision principles", async () => {
      const queryFn = vi.fn().mockResolvedValue(JSON.stringify({
        choice: "Complete",
        confidence: 8,
        rationale: "r",
        principle: "p",
      }));

      await askOracle(createInput(), { queryFn, escalateThreshold: 6 });

      const promptArg = queryFn.mock.calls[0][0] as string;
      expect(promptArg).toContain("Decision Principles");
      expect(promptArg).toContain("Choose completeness");
      expect(promptArg).toContain("Boil lakes");
    });

    it("includes all options with descriptions", async () => {
      const queryFn = vi.fn().mockResolvedValue(JSON.stringify({
        choice: "Complete",
        confidence: 8,
        rationale: "r",
        principle: "p",
      }));

      await askOracle(createInput(), { queryFn, escalateThreshold: 6 });

      const promptArg = queryFn.mock.calls[0][0] as string;
      expect(promptArg).toContain("Complete");
      expect(promptArg).toContain("Full implementation");
      expect(promptArg).toContain("Quick");
      expect(promptArg).toContain("Fast shortcut");
    });

    it("includes the skill name", async () => {
      const queryFn = vi.fn().mockResolvedValue(JSON.stringify({
        choice: "Complete",
        confidence: 8,
        rationale: "r",
        principle: "p",
      }));

      await askOracle(
        createInput({ skillName: "design-review" }),
        { queryFn, escalateThreshold: 6 },
      );

      const promptArg = queryFn.mock.calls[0][0] as string;
      expect(promptArg).toContain("/design-review");
    });
  });
});
