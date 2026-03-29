/**
 * Tests for Oracle Session Reuse: buildResumePrompt, ORACLE_QUESTION_MARKER,
 * MAX_REUSE, ORACLE_BATCH_MARKER, and the session lifecycle behavior of
 * createSdkOracleQueryFn.
 *
 * All tests use synthetic data — no SDK calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildOraclePrompt,
  buildResumePrompt,
  buildBatchOraclePrompt,
  ORACLE_QUESTION_MARKER,
  ORACLE_BATCH_MARKER,
  MAX_REUSE,
} from "../src/oracle.js";
import type { OracleInput, OracleBatchInput } from "../src/oracle.js";
import type { OracleSessionEvent } from "../src/types.js";

// ── Helpers ────────────────────────────────────────────────────

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

function makeBatchInput(overrides: Partial<OracleBatchInput> = {}): OracleBatchInput {
  return {
    questions: [
      {
        id: 1,
        question: "Which database?",
        options: [
          { label: "Postgres", description: "Relational" },
          { label: "Mongo", description: "Document" },
        ],
      },
      {
        id: 2,
        question: "Which framework?",
        options: [
          { label: "Express", description: "Minimal" },
          { label: "Fastify", description: "Fast" },
        ],
      },
    ],
    skillName: "qa",
    decisionHistory: [],
    ...overrides,
  };
}

// ── ORACLE_QUESTION_MARKER ─────────────────────────────────────

describe("ORACLE_QUESTION_MARKER", () => {
  it("is present in buildOraclePrompt output", () => {
    const prompt = buildOraclePrompt(makeInput());
    expect(prompt).toContain(ORACLE_QUESTION_MARKER);
  });

  it("appears exactly once in buildOraclePrompt output", () => {
    const prompt = buildOraclePrompt(makeInput());
    const count = prompt.split(ORACLE_QUESTION_MARKER).length - 1;
    expect(count).toBe(1);
  });

  it("equals '## Question\\n'", () => {
    expect(ORACLE_QUESTION_MARKER).toBe("## Question\n");
  });
});

// ── ORACLE_BATCH_MARKER ────────────────────────────────────────

describe("ORACLE_BATCH_MARKER", () => {
  it("is present in buildBatchOraclePrompt output", () => {
    const prompt = buildBatchOraclePrompt(makeBatchInput());
    expect(prompt).toContain(ORACLE_BATCH_MARKER);
  });

  it("is NOT present in single-question buildOraclePrompt output", () => {
    const prompt = buildOraclePrompt(makeInput());
    expect(prompt).not.toContain(ORACLE_BATCH_MARKER);
  });
});

// ── MAX_REUSE ──────────────────────────────────────────────────

describe("MAX_REUSE", () => {
  it("is 25", () => {
    expect(MAX_REUSE).toBe(25);
  });
});

// ── buildResumePrompt ──────────────────────────────────────────

describe("buildResumePrompt", () => {
  it("strips prefix and keeps question + options", () => {
    const fullPrompt = buildOraclePrompt(makeInput());
    const resumed = buildResumePrompt(fullPrompt);

    // Should start with "New decision needed:" prefix
    expect(resumed.startsWith("New decision needed:")).toBe(true);

    // Should contain the question
    expect(resumed).toContain("Which approach should we use?");

    // Should contain the options
    expect(resumed).toContain("Approach A");
    expect(resumed).toContain("Approach B");

    // Should contain instructions
    expect(resumed).toContain("## Instructions");

    // Should NOT contain the Decision Principles section header (stripped prefix)
    expect(resumed).not.toContain("## Decision Principles");
    // Should NOT contain the full principle text
    expect(resumed).not.toContain("Choose completeness");
  });

  it("preserves full prompt when ORACLE_QUESTION_MARKER is not found", () => {
    const oddPrompt = "Some prompt without the question marker";
    const result = buildResumePrompt(oddPrompt);
    expect(result).toBe(oddPrompt);
  });

  it("strips memory sections from the prefix", () => {
    const input = makeInput({
      memory: {
        taste: "Prefer TypeScript strict mode",
        domainExpertise: "WebSocket best practices",
        decisionOutcomes: "Used Vitest: success",
        memoryMd: "Project uses Node.js",
      },
    });
    const fullPrompt = buildOraclePrompt(input);
    const resumed = buildResumePrompt(fullPrompt);

    // The "## Taste Profile" section header should be stripped (it's in the prefix)
    expect(resumed).not.toContain("## Taste Profile");
    expect(resumed).not.toContain("## Domain Expertise");
    expect(resumed).not.toContain("## Decision Outcomes");
    expect(resumed).not.toContain("## Project Memory");
  });

  it("strips recent decisions from the prefix", () => {
    const input = makeInput({
      decisionHistory: [
        {
          timestamp: "2026-01-01",
          sessionIndex: 0,
          question: "Old question?",
          options: [{ label: "X", description: "x" }],
          chosen: "X",
          confidence: 8,
          rationale: "Because",
          principle: "DRY",
        },
      ],
    });
    const fullPrompt = buildOraclePrompt(input);
    const resumed = buildResumePrompt(fullPrompt);

    expect(resumed).not.toContain("Recent Decisions");
    expect(resumed).not.toContain("Old question?");
  });

  it("resume prompt is significantly shorter than full prompt", () => {
    const input = makeInput({
      memory: {
        taste: "x".repeat(1000),
        domainExpertise: "y".repeat(2000),
        decisionOutcomes: null,
        memoryMd: null,
      },
    });
    const fullPrompt = buildOraclePrompt(input);
    const resumed = buildResumePrompt(fullPrompt);

    // Resume should be much shorter (stripped ~3K+ of memory)
    expect(resumed.length).toBeLessThan(fullPrompt.length * 0.5);
  });

  it("handles prompts with Other option", () => {
    const input = makeInput({
      options: [
        { label: "A", description: "Option A" },
        { label: "Other", description: "Propose something else" },
      ],
    });
    const fullPrompt = buildOraclePrompt(input);
    const resumed = buildResumePrompt(fullPrompt);

    expect(resumed).toContain("otherProposal");
  });
});

// ── OracleSessionEvent type ────────────────────────────────────

describe("OracleSessionEvent", () => {
  it("has the expected type union values", () => {
    const events: OracleSessionEvent[] = [
      { type: "session_created", callCount: 1, sessionId: "abc" },
      { type: "session_resumed", callCount: 2, sessionId: "abc" },
      { type: "session_reset", callCount: 25 },
      { type: "resume_fallback", callCount: 3, sessionId: "abc" },
    ];
    expect(events).toHaveLength(4);
    expect(events[0].type).toBe("session_created");
    expect(events[1].type).toBe("session_resumed");
    expect(events[2].type).toBe("session_reset");
    expect(events[3].type).toBe("resume_fallback");
  });

  it("sessionId is optional", () => {
    const event: OracleSessionEvent = { type: "session_reset", callCount: 5 };
    expect(event.sessionId).toBeUndefined();
  });
});

// ── formatEvent for oracle_session ─────────────────────────────

describe("formatEvent oracle_session", () => {
  it("formats oracle_session event correctly", async () => {
    // Dynamic import to match the project pattern
    const { formatEvent } = await import("../src/cli.js");
    const result = formatEvent({
      type: "oracle_session",
      event: { type: "session_created", callCount: 1, sessionId: "abc" },
    });
    expect(result).toContain("Oracle session");
    expect(result).toContain("session_created");
    expect(result).toContain("call #1");
  });

  it("formats resume_fallback event", async () => {
    const { formatEvent } = await import("../src/cli.js");
    const result = formatEvent({
      type: "oracle_session",
      event: { type: "resume_fallback", callCount: 3 },
    });
    expect(result).toContain("resume_fallback");
    expect(result).toContain("call #3");
  });
});
