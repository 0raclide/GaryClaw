import { describe, it, expect, beforeEach } from "vitest";
import {
  createTokenMonitorState,
  recordTurnUsage,
  setContextWindow,
  setCost,
  shouldRelay,
  computeGrowthRate,
  buildUsageSnapshot,
} from "../src/token-monitor.js";
import { createMockSdkUsage, createMockModelUsage } from "./helpers.js";

describe("token-monitor", () => {
  let state: ReturnType<typeof createTokenMonitorState>;

  beforeEach(() => {
    state = createTokenMonitorState();
  });

  describe("createTokenMonitorState", () => {
    it("initializes with null context window and empty history", () => {
      expect(state.contextWindow).toBeNull();
      expect(state.totalOutputTokens).toBe(0);
      expect(state.turnHistory).toHaveLength(0);
      expect(state.turnCounter).toBe(0);
    });
  });

  describe("recordTurnUsage", () => {
    it("records valid usage and returns computed context size", () => {
      const usage = createMockSdkUsage({
        input_tokens: 3,
        cache_read_input_tokens: 7525,
        cache_creation_input_tokens: 3069,
      });
      const size = recordTurnUsage(state, usage);
      expect(size).toBe(3 + 7525 + 3069);
      expect(state.turnHistory).toHaveLength(1);
      expect(state.turnCounter).toBe(1);
      expect(state.turnHistory[0].computedContextSize).toBe(10597);
    });

    it("returns null for null usage", () => {
      expect(recordTurnUsage(state, null)).toBeNull();
      expect(state.turnHistory).toHaveLength(0);
    });

    it("returns null for undefined usage", () => {
      expect(recordTurnUsage(state, undefined)).toBeNull();
    });

    it("returns null when all token fields are zero", () => {
      const usage = createMockSdkUsage({
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });
      expect(recordTurnUsage(state, usage)).toBeNull();
    });

    it("accumulates output tokens", () => {
      recordTurnUsage(state, createMockSdkUsage({ output_tokens: 100 }));
      recordTurnUsage(state, createMockSdkUsage({ output_tokens: 200 }));
      expect(state.totalOutputTokens).toBe(300);
    });

    it("increments turn counter across multiple recordings", () => {
      recordTurnUsage(state, createMockSdkUsage());
      recordTurnUsage(state, createMockSdkUsage());
      recordTurnUsage(state, createMockSdkUsage());
      expect(state.turnCounter).toBe(3);
      expect(state.turnHistory).toHaveLength(3);
      expect(state.turnHistory[2].turn).toBe(3);
    });

    it("handles missing optional fields gracefully", () => {
      const usage = { input_tokens: 5 } as any;
      const size = recordTurnUsage(state, usage);
      expect(size).toBe(5); // 5 + 0 + 0
    });
  });

  describe("setContextWindow", () => {
    it("extracts context window from model usage", () => {
      setContextWindow(state, createMockModelUsage(1_000_000));
      expect(state.contextWindow).toBe(1_000_000);
    });

    it("ignores null model usage", () => {
      setContextWindow(state, null);
      expect(state.contextWindow).toBeNull();
    });

    it("ignores model usage with zero context window", () => {
      setContextWindow(state, { "test-model": { contextWindow: 0 } });
      expect(state.contextWindow).toBeNull();
    });

    it("ignores model usage without context window field", () => {
      setContextWindow(state, { "test-model": {} });
      expect(state.contextWindow).toBeNull();
    });
  });

  describe("shouldRelay", () => {
    it("returns false with no context window", () => {
      const result = shouldRelay(state, 0.85);
      expect(result.relay).toBe(false);
      expect(result.reason).toContain("no context window");
    });

    it("returns false with no turns recorded", () => {
      state.contextWindow = 1_000_000;
      const result = shouldRelay(state, 0.85);
      expect(result.relay).toBe(false);
      expect(result.reason).toContain("no turns");
    });

    it("returns false when under threshold", () => {
      state.contextWindow = 1_000_000;
      recordTurnUsage(state, createMockSdkUsage({
        input_tokens: 3,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 50_000,
      }));
      const result = shouldRelay(state, 0.85);
      expect(result.relay).toBe(false);
      expect(result.contextSize).toBe(150_003);
    });

    it("returns true when at threshold", () => {
      state.contextWindow = 1_000_000;
      recordTurnUsage(state, createMockSdkUsage({
        input_tokens: 0,
        cache_read_input_tokens: 850_000,
        cache_creation_input_tokens: 0,
      }));
      const result = shouldRelay(state, 0.85);
      expect(result.relay).toBe(true);
      expect(result.contextSize).toBe(850_000);
    });

    it("returns true when above threshold", () => {
      state.contextWindow = 1_000_000;
      recordTurnUsage(state, createMockSdkUsage({
        input_tokens: 3,
        cache_read_input_tokens: 900_000,
        cache_creation_input_tokens: 50_000,
      }));
      const result = shouldRelay(state, 0.85);
      expect(result.relay).toBe(true);
      expect(result.reason).toContain("95.0%");
    });

    it("uses latest turn for decision", () => {
      state.contextWindow = 1_000_000;
      // First turn: low usage
      recordTurnUsage(state, createMockSdkUsage({
        input_tokens: 3,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 5_000,
      }));
      // Second turn: high usage
      recordTurnUsage(state, createMockSdkUsage({
        input_tokens: 3,
        cache_read_input_tokens: 900_000,
        cache_creation_input_tokens: 0,
      }));
      const result = shouldRelay(state, 0.85);
      expect(result.relay).toBe(true);
    });
  });

  describe("computeGrowthRate", () => {
    it("returns null with fewer than 2 turns", () => {
      expect(computeGrowthRate(state)).toBeNull();
      recordTurnUsage(state, createMockSdkUsage());
      expect(computeGrowthRate(state)).toBeNull();
    });

    it("computes average growth over turns", () => {
      recordTurnUsage(state, createMockSdkUsage({
        input_tokens: 0,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 0,
      }));
      recordTurnUsage(state, createMockSdkUsage({
        input_tokens: 0,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 0,
      }));
      recordTurnUsage(state, createMockSdkUsage({
        input_tokens: 0,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 0,
      }));
      const rate = computeGrowthRate(state);
      expect(rate).toBe(10_000); // 20K delta over 2 intervals
    });

    it("respects window size", () => {
      // Add 10 turns with linear growth
      for (let i = 1; i <= 10; i++) {
        recordTurnUsage(state, createMockSdkUsage({
          input_tokens: 0,
          cache_read_input_tokens: i * 10_000,
          cache_creation_input_tokens: 0,
        }));
      }
      // Window of 3: looks at turns 8, 9, 10
      const rate = computeGrowthRate(state, 3);
      expect(rate).toBe(10_000);
    });
  });

  describe("buildUsageSnapshot", () => {
    it("builds snapshot from current state", () => {
      state.contextWindow = 1_000_000;
      state.estimatedCostUsd = 0.045;
      recordTurnUsage(state, createMockSdkUsage());

      const snapshot = buildUsageSnapshot(state, 2);
      expect(snapshot.sessionCount).toBe(2);
      expect(snapshot.contextWindow).toBe(1_000_000);
      expect(snapshot.estimatedCostUsd).toBe(0.045);
      expect(snapshot.lastContextSize).toBe(10597);
      expect(snapshot.turnHistory).toHaveLength(1);
    });

    it("returns zero context size with no turns", () => {
      const snapshot = buildUsageSnapshot(state, 1);
      expect(snapshot.lastContextSize).toBe(0);
    });
  });

  describe("setCost", () => {
    it("updates estimated cost", () => {
      setCost(state, 0.123);
      expect(state.estimatedCostUsd).toBe(0.123);
    });
  });
});
