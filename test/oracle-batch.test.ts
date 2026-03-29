import { describe, it, expect, vi } from "vitest";
import {
  askOracleBatch,
  buildBatchOraclePrompt,
  parseBatchOracleResponse,
} from "../src/oracle.js";
import type {
  OracleConfig,
  OracleBatchInput,
  OracleBatchQuestion,
} from "../src/oracle.js";
import type { OracleMemoryFiles } from "../src/types.js";

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
    {
      question: "Which layout?",
      options: [
        { label: "Grid", description: "Grid layout" },
        { label: "List", description: "List layout" },
      ],
    },
  ];

  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    ...(templates[i % templates.length]),
  }));
}

function makeBatchInput(overrides: Partial<OracleBatchInput> = {}): OracleBatchInput {
  return {
    questions: makeQuestions(2),
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

function makeBatchResponse(answers: Array<{
  questionId: number;
  choice: string;
  confidence: number;
  rationale: string;
  principle: string;
  otherProposal?: string;
}>): string {
  return JSON.stringify(answers);
}

describe("oracle batching", () => {
  describe("askOracleBatch — single question delegation", () => {
    it("returns empty array for zero questions", async () => {
      const config = makeConfig("");
      const result = await askOracleBatch(
        makeBatchInput({ questions: [] }),
        config,
      );
      expect(result).toEqual([]);
      expect(config.queryFn).not.toHaveBeenCalled();
    });

    it("delegates single question to askOracle (no batch overhead)", async () => {
      const config = makeConfig(
        JSON.stringify({
          choice: "Dark",
          confidence: 9,
          rationale: "User preference",
          principle: "Pragmatic",
        }),
      );

      const result = await askOracleBatch(
        makeBatchInput({ questions: makeQuestions(1) }),
        config,
      );

      expect(result).toHaveLength(1);
      expect(result[0].choice).toBe("Dark");
      expect(result[0].confidence).toBe(9);
      // Single question should NOT generate a batch prompt (no "Questions (answer ALL")
      const prompt = (config.queryFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(prompt).not.toContain("Questions (answer ALL");
    });
  });

  describe("askOracleBatch — multi-question batching", () => {
    it("batches 2 questions into one API call", async () => {
      const config = makeConfig(
        makeBatchResponse([
          { questionId: 1, choice: "Dark", confidence: 8, rationale: "R1", principle: "Pragmatic" },
          { questionId: 2, choice: "Sans-serif", confidence: 9, rationale: "R2", principle: "DRY" },
        ]),
      );

      const result = await askOracleBatch(makeBatchInput(), config);

      expect(config.queryFn).toHaveBeenCalledTimes(1); // ONE call, not two
      expect(result).toHaveLength(2);
      expect(result[0].choice).toBe("Dark");
      expect(result[0].confidence).toBe(8);
      expect(result[1].choice).toBe("Sans-serif");
      expect(result[1].confidence).toBe(9);
    });

    it("batches 3 questions into one API call", async () => {
      const config = makeConfig(
        makeBatchResponse([
          { questionId: 1, choice: "Dark", confidence: 8, rationale: "R1", principle: "P1" },
          { questionId: 2, choice: "Sans-serif", confidence: 7, rationale: "R2", principle: "P2" },
          { questionId: 3, choice: "Grid", confidence: 9, rationale: "R3", principle: "P3" },
        ]),
      );

      const result = await askOracleBatch(
        makeBatchInput({ questions: makeQuestions(3) }),
        config,
      );

      expect(config.queryFn).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(3);
      expect(result[0].choice).toBe("Dark");
      expect(result[1].choice).toBe("Sans-serif");
      expect(result[2].choice).toBe("Grid");
    });

    it("applies escalation logic per question independently", async () => {
      const questions: OracleBatchQuestion[] = [
        {
          id: 1,
          question: "Should we delete the production database?",
          options: [
            { label: "Yes", description: "Delete it" },
            { label: "No", description: "Keep it" },
          ],
        },
        {
          id: 2,
          question: "Which color theme?",
          options: [
            { label: "Dark", description: "Dark theme" },
            { label: "Light", description: "Light theme" },
          ],
        },
      ];

      const config = makeConfig(
        makeBatchResponse([
          { questionId: 1, choice: "No", confidence: 9, rationale: "Safety", principle: "Safety" },
          { questionId: 2, choice: "Dark", confidence: 9, rationale: "Preference", principle: "Pragmatic" },
        ]),
      );

      const result = await askOracleBatch(
        makeBatchInput({ questions }),
        config,
      );

      // Q1 should escalate (security phrases: "delete" + "production")
      expect(result[0].escalate).toBe(true);
      // Q2 should NOT escalate
      expect(result[1].escalate).toBe(false);
    });

    it("marks low-confidence answers as taste decisions", async () => {
      const config = makeConfig(
        makeBatchResponse([
          { questionId: 1, choice: "Dark", confidence: 4, rationale: "Unsure", principle: "Pragmatic" },
          { questionId: 2, choice: "Sans-serif", confidence: 8, rationale: "Clear", principle: "DRY" },
        ]),
      );

      const result = await askOracleBatch(makeBatchInput(), config);

      expect(result[0].isTaste).toBe(true);  // 4 < 6
      expect(result[0].escalate).toBe(true);
      expect(result[1].isTaste).toBe(false); // 8 >= 6
      expect(result[1].escalate).toBe(false);
    });
  });

  describe("askOracleBatch — error handling", () => {
    it("returns fallback for all questions when API call fails", async () => {
      const config = makeConfig("", {
        queryFn: vi.fn().mockRejectedValue(new Error("API timeout")),
      });

      const result = await askOracleBatch(makeBatchInput(), config);

      expect(result).toHaveLength(2);
      expect(result[0].confidence).toBe(1);
      expect(result[0].escalate).toBe(true);
      expect(result[0].rationale).toContain("Oracle batch call failed");
      expect(result[1].confidence).toBe(1);
      expect(result[1].escalate).toBe(true);
    });

    it("handles non-Error rejection", async () => {
      const config = makeConfig("", {
        queryFn: vi.fn().mockRejectedValue("string error"),
      });

      const result = await askOracleBatch(makeBatchInput(), config);

      expect(result).toHaveLength(2);
      expect(result[0].rationale).toContain("string error");
    });
  });

  describe("buildBatchOraclePrompt", () => {
    it("includes all questions with ids", () => {
      const prompt = buildBatchOraclePrompt(makeBatchInput());

      expect(prompt).toContain("Questions (answer ALL 2 questions)");
      expect(prompt).toContain("### Question 1");
      expect(prompt).toContain("Which theme?");
      expect(prompt).toContain("### Question 2");
      expect(prompt).toContain("Which font?");
    });

    it("includes decision principles", () => {
      const prompt = buildBatchOraclePrompt(makeBatchInput());
      expect(prompt).toContain("Decision Principles");
      expect(prompt).toContain("Choose completeness");
    });

    it("includes skill context", () => {
      const prompt = buildBatchOraclePrompt(makeBatchInput({ skillName: "design-review" }));
      expect(prompt).toContain("/design-review");
    });

    it("includes project context when provided", () => {
      const prompt = buildBatchOraclePrompt(
        makeBatchInput({ projectContext: "React TypeScript app" }),
      );
      expect(prompt).toContain("React TypeScript app");
    });

    it("includes memory sections when provided", () => {
      const memory: OracleMemoryFiles = {
        taste: "Prefer dark themes",
        domainExpertise: "React best practices",
        decisionOutcomes: "Prior: success",
        memoryMd: "State: active",
      };

      const prompt = buildBatchOraclePrompt(makeBatchInput({ memory }));
      expect(prompt).toContain("Taste Profile");
      expect(prompt).toContain("Prefer dark themes");
      expect(prompt).toContain("Domain Expertise");
      expect(prompt).toContain("Decision Outcomes");
      expect(prompt).toContain("Project Memory");
    });

    it("omits memory sections when all null", () => {
      const memory: OracleMemoryFiles = {
        taste: null,
        domainExpertise: null,
        decisionOutcomes: null,
        memoryMd: null,
      };

      const prompt = buildBatchOraclePrompt(makeBatchInput({ memory }));
      expect(prompt).not.toContain("Taste Profile");
    });

    it("includes decision history", () => {
      const prompt = buildBatchOraclePrompt(makeBatchInput({
        decisionHistory: [{
          timestamp: "2026-03-25T10:00:00Z",
          sessionIndex: 0,
          question: "Previous?",
          options: [],
          chosen: "Yes",
          confidence: 9,
          rationale: "test",
          principle: "DRY",
        }],
      }));
      expect(prompt).toContain("Recent Decisions");
      expect(prompt).toContain("Previous?");
    });

    it("requests JSON array format", () => {
      const prompt = buildBatchOraclePrompt(makeBatchInput());
      expect(prompt).toContain("JSON array");
      expect(prompt).toContain('"questionId"');
    });

    it("includes otherProposal instruction for questions with Other option", () => {
      const questions: OracleBatchQuestion[] = [
        {
          id: 1,
          question: "How to fix?",
          options: [
            { label: "Fix it", description: "Standard" },
            { label: "Other", description: "Custom" },
          ],
        },
        {
          id: 2,
          question: "Which theme?",
          options: [
            { label: "Dark", description: "Dark" },
            { label: "Light", description: "Light" },
          ],
        },
      ];

      const prompt = buildBatchOraclePrompt(makeBatchInput({ questions }));
      expect(prompt).toContain('choosing "Other" for Q1');
      // Q2 has no Other option, so no otherProposal instruction for it
      expect(prompt).not.toContain('choosing "Other" for Q2');
    });

    it("includes taste consideration when taste memory present", () => {
      const memory: OracleMemoryFiles = {
        taste: "Be concise",
        domainExpertise: null,
        decisionOutcomes: null,
        memoryMd: null,
      };

      const prompt = buildBatchOraclePrompt(makeBatchInput({ memory }));
      expect(prompt).toContain("Taste Profile preferences");
    });
  });

  describe("parseBatchOracleResponse", () => {
    const questions = makeQuestions(2);

    it("parses well-formed JSON array", () => {
      const raw = JSON.stringify([
        { questionId: 1, choice: "Dark", confidence: 8, rationale: "R1", principle: "Pragmatic" },
        { questionId: 2, choice: "Sans-serif", confidence: 7, rationale: "R2", principle: "DRY" },
      ]);

      const result = parseBatchOracleResponse(raw, questions);

      expect(result).toHaveLength(2);
      expect(result[0].choice).toBe("Dark");
      expect(result[0].confidence).toBe(8);
      expect(result[1].choice).toBe("Sans-serif");
      expect(result[1].confidence).toBe(7);
    });

    it("extracts JSON array from surrounding text", () => {
      const raw = `Here are my decisions:\n${JSON.stringify([
        { choice: "Dark", confidence: 8, rationale: "R1", principle: "P1" },
        { choice: "Sans-serif", confidence: 7, rationale: "R2", principle: "P2" },
      ])}\nThat's it.`;

      const result = parseBatchOracleResponse(raw, questions);
      expect(result).toHaveLength(2);
      expect(result[0].choice).toBe("Dark");
      expect(result[1].choice).toBe("Sans-serif");
    });

    it("handles case-insensitive label matching", () => {
      const raw = JSON.stringify([
        { choice: "dark", confidence: 8, rationale: "R1", principle: "P1" },
        { choice: "SANS-SERIF", confidence: 7, rationale: "R2", principle: "P2" },
      ]);

      const result = parseBatchOracleResponse(raw, questions);
      expect(result[0].choice).toBe("Dark");
      expect(result[1].choice).toBe("Sans-serif");
    });

    it("clamps confidence to 1-10 range", () => {
      const raw = JSON.stringify([
        { choice: "Dark", confidence: 15, rationale: "R1", principle: "P1" },
        { choice: "Sans-serif", confidence: -3, rationale: "R2", principle: "P2" },
      ]);

      const result = parseBatchOracleResponse(raw, questions);
      expect(result[0].confidence).toBe(10);
      expect(result[1].confidence).toBe(1);
    });

    it("extracts otherProposal for Other choices", () => {
      const questionsWithOther: OracleBatchQuestion[] = [
        {
          id: 1,
          question: "How to fix?",
          options: [
            { label: "Standard", description: "Standard fix" },
            { label: "Other", description: "Custom" },
          ],
        },
      ];

      const raw = JSON.stringify([
        {
          choice: "Other",
          confidence: 7,
          rationale: "Custom needed",
          principle: "Pragmatic",
          otherProposal: "Use a hybrid approach",
        },
      ]);

      const result = parseBatchOracleResponse(raw, questionsWithOther);
      expect(result[0].choice).toBe("Other");
      expect(result[0].otherProposal).toBe("Use a hybrid approach");
    });

    it("falls back to individual JSON objects when array parsing fails", () => {
      // Response has multiple separate JSON objects instead of an array
      const raw = `Question 1: {"choice": "Dark", "confidence": 8, "rationale": "R1", "principle": "P1"}\nQuestion 2: {"choice": "Sans-serif", "confidence": 7, "rationale": "R2", "principle": "P2"}`;

      const result = parseBatchOracleResponse(raw, questions);
      expect(result).toHaveLength(2);
      expect(result[0].choice).toBe("Dark");
      expect(result[1].choice).toBe("Sans-serif");
    });

    it("returns fallback for all questions when parsing completely fails", () => {
      const raw = "I think Dark and Sans-serif are good choices.";

      const result = parseBatchOracleResponse(raw, questions);
      expect(result).toHaveLength(2);
      expect(result[0].confidence).toBe(3); // Fallback confidence
      expect(result[1].confidence).toBe(3);
    });

    it("handles array shorter than questions by falling back", () => {
      const raw = JSON.stringify([
        { choice: "Dark", confidence: 8, rationale: "R1", principle: "P1" },
        // Missing second answer
      ]);

      const result = parseBatchOracleResponse(raw, questions);
      // Should fall through since array.length < questions.length
      // Then individual JSON extraction also has only 1 object
      // Falls back to fallback choices
      expect(result).toHaveLength(2);
    });

    it("handles extra answers gracefully (ignores extras)", () => {
      const raw = JSON.stringify([
        { choice: "Dark", confidence: 8, rationale: "R1", principle: "P1" },
        { choice: "Sans-serif", confidence: 7, rationale: "R2", principle: "P2" },
        { choice: "Extra", confidence: 6, rationale: "R3", principle: "P3" },
      ]);

      const result = parseBatchOracleResponse(raw, questions);
      expect(result).toHaveLength(2); // Only 2 questions, ignore extra
      expect(result[0].choice).toBe("Dark");
      expect(result[1].choice).toBe("Sans-serif");
    });

    it("defaults missing fields gracefully", () => {
      const raw = JSON.stringify([
        { choice: "Dark" }, // Missing confidence, rationale, principle
        { confidence: 7 },  // Missing choice
      ]);

      const result = parseBatchOracleResponse(raw, questions);
      expect(result[0].choice).toBe("Dark");
      expect(result[0].confidence).toBe(5); // Default
      expect(result[0].rationale).toBe("No rationale provided");
      expect(result[0].principle).toBe("Bias toward action");
      expect(result[1].choice).toBe("Sans-serif"); // Falls back to first option of Q2
      expect(result[1].confidence).toBe(7);
    });

    it("handles malformed JSON gracefully", () => {
      const raw = '[ {"choice": "Dark"... broken json';

      const result = parseBatchOracleResponse(raw, questions);
      expect(result).toHaveLength(2);
      // Should fall through to fallback
      expect(result[0].confidence).toBeLessThanOrEqual(5);
    });
  });

  describe("askOracleBatch — context passing", () => {
    it("builds batch prompt with shared context (one API call)", async () => {
      const queryFn = vi.fn().mockResolvedValue(
        makeBatchResponse([
          { questionId: 1, choice: "Dark", confidence: 8, rationale: "R1", principle: "P1" },
          { questionId: 2, choice: "Sans-serif", confidence: 7, rationale: "R2", principle: "P2" },
        ]),
      );

      const memory: OracleMemoryFiles = {
        taste: "Prefer simple",
        domainExpertise: null,
        decisionOutcomes: null,
        memoryMd: null,
      };

      await askOracleBatch(
        makeBatchInput({ memory, projectContext: "React app" }),
        { queryFn, escalateThreshold: 6 },
      );

      expect(queryFn).toHaveBeenCalledTimes(1);
      const prompt = queryFn.mock.calls[0][0] as string;
      expect(prompt).toContain("Prefer simple");
      expect(prompt).toContain("React app");
      expect(prompt).toContain("Question 1");
      expect(prompt).toContain("Question 2");
    });

    it("passes decisionHistory to batch prompt", async () => {
      const queryFn = vi.fn().mockResolvedValue(
        makeBatchResponse([
          { questionId: 1, choice: "Dark", confidence: 8, rationale: "R1", principle: "P1" },
          { questionId: 2, choice: "Sans-serif", confidence: 7, rationale: "R2", principle: "P2" },
        ]),
      );

      await askOracleBatch(
        makeBatchInput({
          decisionHistory: [{
            timestamp: "2026-03-25T10:00:00Z",
            sessionIndex: 0,
            question: "Earlier?",
            options: [],
            chosen: "Yes",
            confidence: 9,
            rationale: "prior",
            principle: "DRY",
          }],
        }),
        { queryFn, escalateThreshold: 6 },
      );

      const prompt = queryFn.mock.calls[0][0] as string;
      expect(prompt).toContain("Earlier?");
    });
  });

  describe("askOracleBatch — otherProposal in batch", () => {
    it("preserves otherProposal per question", async () => {
      const questions: OracleBatchQuestion[] = [
        {
          id: 1,
          question: "How?",
          options: [
            { label: "Standard", description: "Standard" },
            { label: "Other", description: "Custom" },
          ],
        },
        {
          id: 2,
          question: "Which?",
          options: [
            { label: "A", description: "Option A" },
            { label: "B", description: "Option B" },
          ],
        },
      ];

      const config = makeConfig(
        makeBatchResponse([
          {
            questionId: 1,
            choice: "Other",
            confidence: 7,
            rationale: "Custom",
            principle: "Pragmatic",
            otherProposal: "Hybrid approach",
          },
          {
            questionId: 2,
            choice: "A",
            confidence: 9,
            rationale: "Better",
            principle: "DRY",
          },
        ]),
      );

      const result = await askOracleBatch(
        makeBatchInput({ questions }),
        config,
      );

      expect(result[0].otherProposal).toBe("Hybrid approach");
      expect(result[1].otherProposal).toBeUndefined();
    });
  });
});
