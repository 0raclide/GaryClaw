import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAskHandler } from "../src/ask-handler.js";
import { OracleCache } from "../src/oracle-cache.js";
import type { OracleOutput } from "../src/oracle.js";

const TEST_DIR = join(tmpdir(), `garyclaw-ask-cache-test-${Date.now()}`);

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

const defaultOptions = [
  { label: "Run tests", description: "Run the test suite" },
  { label: "Browser QA", description: "Open browser and test" },
];

function makeOracleResult(overrides: Partial<OracleOutput> = {}): OracleOutput {
  return {
    choice: "Run tests",
    confidence: 9,
    rationale: "Tests are the way",
    principle: "P7",
    isTaste: false,
    escalate: false,
    ...overrides,
  };
}

describe("ask-handler cache integration", () => {
  describe("cache hit — skips Oracle call", () => {
    it("returns cached answer without calling askOracle", async () => {
      const cache = new OracleCache({ minHits: 2 });
      // Pre-populate: record enough hits to promote
      cache.record("What QA approach?", defaultOptions, "Run tests", "P7");
      cache.record("What QA approach?", defaultOptions, "Run tests", "P7");

      const askOracle = vi.fn();
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        decisionLogPath: join(TEST_DIR, "decisions.jsonl"),
        autonomous: true,
        oracle: {
          askOracle,
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
          cache,
        },
      });

      const result = await handler.canUseTool(
        "AskUserQuestion",
        makeAskInput([{ question: "What QA approach?", options: defaultOptions }]),
      );

      expect(result.behavior).toBe("allow");
      expect(askOracle).not.toHaveBeenCalled(); // No Oracle call!
      const answers = (result.updatedInput as Record<string, unknown>)?.answers as Record<string, string>;
      expect(answers["What QA approach?"]).toBe("Run tests");
    });

    it("emits oracle_cache_hit event", async () => {
      const cache = new OracleCache({ minHits: 2 });
      cache.record("What QA approach?", defaultOptions, "Run tests", "P7");
      cache.record("What QA approach?", defaultOptions, "Run tests", "P7");

      const cacheEvents: Array<{ type: string }> = [];
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle: vi.fn(),
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
          cache,
        },
        onCacheEvent: (e) => cacheEvents.push(e),
      });

      await handler.canUseTool(
        "AskUserQuestion",
        makeAskInput([{ question: "What QA approach?", options: defaultOptions }]),
      );

      expect(cacheEvents).toHaveLength(1);
      expect(cacheEvents[0].type).toBe("oracle_cache_hit");
    });

    it("logs cached decision to decisions.jsonl", async () => {
      const cache = new OracleCache({ minHits: 2 });
      cache.record("What QA approach?", defaultOptions, "Run tests", "P7");
      cache.record("What QA approach?", defaultOptions, "Run tests", "P7");

      const logPath = join(TEST_DIR, "decisions.jsonl");
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        decisionLogPath: logPath,
        autonomous: true,
        oracle: {
          askOracle: vi.fn(),
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
          cache,
        },
      });

      await handler.canUseTool(
        "AskUserQuestion",
        makeAskInput([{ question: "What QA approach?", options: defaultOptions }]),
      );

      const log = readFileSync(logPath, "utf-8").trim();
      const decision = JSON.parse(log);
      expect(decision.chosen).toBe("Run tests");
      expect(decision.rationale).toContain("Cached:");
    });
  });

  describe("cache miss — calls Oracle and records", () => {
    it("calls askOracle on cache miss and records result", async () => {
      const cache = new OracleCache({ minHits: 5 });
      const askOracle = vi.fn().mockResolvedValue(makeOracleResult());

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle,
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
          cache,
        },
      });

      await handler.canUseTool(
        "AskUserQuestion",
        makeAskInput([{ question: "What QA approach?", options: defaultOptions }]),
      );

      expect(askOracle).toHaveBeenCalledOnce();
      // Cache should have recorded the answer
      expect(cache.stats().entries).toBe(1);
    });

    it("emits oracle_cache_miss event", async () => {
      const cache = new OracleCache({ minHits: 5 });
      const cacheEvents: Array<{ type: string }> = [];

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle: vi.fn().mockResolvedValue(makeOracleResult()),
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
          cache,
        },
        onCacheEvent: (e) => cacheEvents.push(e),
      });

      await handler.canUseTool(
        "AskUserQuestion",
        makeAskInput([{ question: "What QA approach?", options: defaultOptions }]),
      );

      expect(cacheEvents).toHaveLength(1);
      expect(cacheEvents[0].type).toBe("oracle_cache_miss");
    });
  });

  describe("partial-batch behavior", () => {
    it("mixes cached and fresh results in batch", async () => {
      const cache = new OracleCache({ minHits: 2 });
      // Pre-populate one question
      cache.record("Cached question?", defaultOptions, "Run tests", "P7");
      cache.record("Cached question?", defaultOptions, "Run tests", "P7");

      const askOracle = vi.fn().mockResolvedValue(makeOracleResult({ choice: "Browser QA" }));

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle,
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
          cache,
        },
      });

      const result = await handler.canUseTool(
        "AskUserQuestion",
        makeAskInput([
          { question: "Cached question?", options: defaultOptions },
          { question: "New question?", options: defaultOptions },
        ]),
      );

      const answers = (result.updatedInput as Record<string, unknown>)?.answers as Record<string, string>;
      expect(answers["Cached question?"]).toBe("Run tests"); // From cache
      expect(answers["New question?"]).toBe("Browser QA"); // From Oracle
      // Only uncached question should trigger Oracle call (serial fallback for 1 uncached)
      expect(askOracle).toHaveBeenCalledOnce();
    });

    it("skips Oracle entirely when all questions cached", async () => {
      const cache = new OracleCache({ minHits: 2 });
      cache.record("Q1?", defaultOptions, "Run tests", "P7");
      cache.record("Q1?", defaultOptions, "Run tests", "P7");
      cache.record("Q2?", defaultOptions, "Browser QA", "P7");
      cache.record("Q2?", defaultOptions, "Browser QA", "P7");

      const askOracle = vi.fn();
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
          cache,
        },
      });

      await handler.canUseTool(
        "AskUserQuestion",
        makeAskInput([
          { question: "Q1?", options: defaultOptions },
          { question: "Q2?", options: defaultOptions },
        ]),
      );

      expect(askOracle).not.toHaveBeenCalled();
      expect(askOracleBatch).not.toHaveBeenCalled();
    });
  });

  describe("no cache — backward compatible", () => {
    it("works normally without cache", async () => {
      const askOracle = vi.fn().mockResolvedValue(makeOracleResult());

      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: true,
        oracle: {
          askOracle,
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
          // no cache
        },
      });

      const result = await handler.canUseTool(
        "AskUserQuestion",
        makeAskInput([{ question: "What QA approach?", options: defaultOptions }]),
      );

      expect(result.behavior).toBe("allow");
      expect(askOracle).toHaveBeenCalledOnce();
    });
  });

  describe("human mode unaffected", () => {
    it("cache is not used in human mode", async () => {
      const cache = new OracleCache({ minHits: 2 });
      cache.record("Q?", defaultOptions, "Run tests", "P7");
      cache.record("Q?", defaultOptions, "Run tests", "P7");

      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Browser QA"),
        askTimeoutMs: 5000,
        sessionIndex: 0,
        autonomous: false,
        oracle: {
          askOracle: vi.fn(),
          config: { queryFn: vi.fn(), escalateThreshold: 6 },
          skillName: "qa",
          cache,
        },
      });

      const result = await handler.canUseTool(
        "AskUserQuestion",
        makeAskInput([{ question: "Q?", options: defaultOptions }]),
      );

      const answers = (result.updatedInput as Record<string, unknown>)?.answers as Record<string, string>;
      expect(answers["Q?"]).toBe("Browser QA"); // Human answer, not cache
    });
  });
});
