import { describe, it, expect, beforeEach } from "vitest";
import {
  createTokenMonitorState,
  recordTurnUsage,
  computeAdaptiveMaxTurns,
} from "../src/token-monitor.js";
import { createMockSdkUsage } from "./helpers.js";

describe("computeAdaptiveMaxTurns", () => {
  let state: ReturnType<typeof createTokenMonitorState>;

  beforeEach(() => {
    state = createTokenMonitorState();
  });

  // ── Fallback cases (no data) ──────────────────────────────────

  it("returns configured default with no turn history", () => {
    const result = computeAdaptiveMaxTurns(state, 0.85, 15);
    expect(result.maxTurns).toBe(15);
    expect(result.reason).toContain("no growth data");
  });

  it("returns configured default with only 1 turn (insufficient for growth rate)", () => {
    state.contextWindow = 1_000_000;
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 0,
    }));
    const result = computeAdaptiveMaxTurns(state, 0.85, 15);
    expect(result.maxTurns).toBe(15);
    expect(result.reason).toContain("no growth data");
  });

  it("returns configured default when contextWindow is null", () => {
    // 2 turns but no contextWindow set
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
    const result = computeAdaptiveMaxTurns(state, 0.85, 15);
    expect(result.maxTurns).toBe(15);
    expect(result.reason).toContain("no growth data");
  });

  it("returns configured default when growth rate is zero", () => {
    state.contextWindow = 1_000_000;
    // Two turns with identical context size → growth rate = 0
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 0,
    }));
    const result = computeAdaptiveMaxTurns(state, 0.85, 15);
    expect(result.maxTurns).toBe(15);
    expect(result.reason).toContain("no growth data");
  });

  it("returns configured default when growth rate is negative", () => {
    state.contextWindow = 1_000_000;
    // Context shrinks (unlikely but handled)
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 0,
    }));
    const result = computeAdaptiveMaxTurns(state, 0.85, 15);
    expect(result.maxTurns).toBe(15);
    expect(result.reason).toContain("no growth data");
  });

  // ── High growth rate (browse-heavy) ───────────────────────────

  it("clamps to min floor for very high growth rate", () => {
    state.contextWindow = 1_000_000;
    // Simulate browse-heavy: ~100K tokens/turn
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 300_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 400_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 500_000,
      cache_creation_input_tokens: 0,
    }));
    // Growth rate = 100K/turn, currentSize = 500K
    // Target = 1M * 0.85 * 0.85 = 722,500
    // Budget = 722,500 - 500,000 = 222,500
    // Predicted = floor(222,500 / 100,000) = 2
    // Clamped to min=3
    const result = computeAdaptiveMaxTurns(state, 0.85, 15);
    expect(result.maxTurns).toBe(3);
    expect(result.reason).toContain("growth rate");
    expect(result.reason).toContain("clamped to 3");
  });

  // ── Low growth rate (edit-heavy) ──────────────────────────────

  it("uses configured max for low growth rate", () => {
    state.contextWindow = 1_000_000;
    // Simulate edit-heavy: ~10K tokens/turn
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 60_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 70_000,
      cache_creation_input_tokens: 0,
    }));
    // Growth rate = 10K/turn, currentSize = 70K
    // Target = 1M * 0.85 * 0.85 = 722,500
    // Budget = 722,500 - 70,000 = 652,500
    // Predicted = floor(652,500 / 10,000) = 65
    // Clamped to configuredMax=15
    const result = computeAdaptiveMaxTurns(state, 0.85, 15);
    expect(result.maxTurns).toBe(15);
    expect(result.reason).toContain("clamped to 15");
  });

  it("allows higher max when user sets --max-turns 30", () => {
    state.contextWindow = 1_000_000;
    // Low growth rate: ~10K tokens/turn
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 60_000,
      cache_creation_input_tokens: 0,
    }));
    // Growth rate = 10K/turn → predicted = 66 → clamped to 30
    const result = computeAdaptiveMaxTurns(state, 0.85, 30);
    expect(result.maxTurns).toBe(30);
    expect(result.reason).toContain("clamped to 30");
  });

  // ── Medium growth rate ────────────────────────────────────────

  it("predicts mid-range turns for moderate growth rate", () => {
    state.contextWindow = 1_000_000;
    // Simulate mixed: ~50K tokens/turn
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 150_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 0,
    }));
    // Growth rate = 50K/turn, currentSize = 200K
    // Target = 1M * 0.85 * 0.85 = 722,500
    // Budget = 722,500 - 200,000 = 522,500
    // Predicted = floor(522,500 / 50,000) = 10
    // Clamped between 3 and 15 → 10
    const result = computeAdaptiveMaxTurns(state, 0.85, 15);
    expect(result.maxTurns).toBe(10);
    expect(result.reason).toContain("predicted 10");
  });

  // ── Already past target ───────────────────────────────────────

  it("clamps to minTurns when already past target", () => {
    state.contextWindow = 1_000_000;
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 600_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 750_000,
      cache_creation_input_tokens: 0,
    }));
    // currentSize = 750K > target 722.5K
    const result = computeAdaptiveMaxTurns(state, 0.85, 15);
    expect(result.maxTurns).toBe(3);
    expect(result.reason).toContain("already at/past target");
  });

  // ── Custom options ────────────────────────────────────────────

  it("respects custom safetyFactor", () => {
    state.contextWindow = 1_000_000;
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 0,
    }));
    // Growth rate = 100K/turn, currentSize = 200K
    // safetyFactor=1.0: target = 1M * 0.85 * 1.0 = 850,000
    // Budget = 850,000 - 200,000 = 650,000
    // Predicted = floor(650,000 / 100,000) = 6
    const result = computeAdaptiveMaxTurns(state, 0.85, 15, { safetyFactor: 1.0 });
    expect(result.maxTurns).toBe(6);
  });

  it("respects custom minTurns", () => {
    state.contextWindow = 1_000_000;
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 600_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 750_000,
      cache_creation_input_tokens: 0,
    }));
    // Already past target → would clamp to min
    const result = computeAdaptiveMaxTurns(state, 0.85, 15, { minTurns: 5 });
    expect(result.maxTurns).toBe(5);
  });

  it("respects custom growthWindowSize", () => {
    state.contextWindow = 1_000_000;
    // 5 turns with varying growth
    for (let i = 1; i <= 5; i++) {
      recordTurnUsage(state, createMockSdkUsage({
        input_tokens: 0,
        cache_read_input_tokens: i * 50_000,
        cache_creation_input_tokens: 0,
      }));
    }
    // Window 2 (last 2 turns): turns 4,5 → growth = (250K - 200K)/1 = 50K
    // currentSize = 250K, target = 722,500, budget = 472,500
    // predicted = floor(472,500 / 50,000) = 9
    const result = computeAdaptiveMaxTurns(state, 0.85, 15, { growthWindowSize: 2 });
    expect(result.maxTurns).toBe(9);
  });

  // ── Exact boundary ────────────────────────────────────────────

  it("handles exact boundary where currentSize equals target", () => {
    state.contextWindow = 1_000_000;
    // Target = 1M * 0.85 * 0.85 = 722,500
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 622_500,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 722_500,
      cache_creation_input_tokens: 0,
    }));
    // Budget = 0, so clamp to min
    const result = computeAdaptiveMaxTurns(state, 0.85, 15);
    expect(result.maxTurns).toBe(3);
    expect(result.reason).toContain("already at/past target");
  });

  // ── Reason string format ──────────────────────────────────────

  it("includes growth rate, budget, predicted, and clamped in reason", () => {
    state.contextWindow = 1_000_000;
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 100_000,
      cache_creation_input_tokens: 0,
    }));
    recordTurnUsage(state, createMockSdkUsage({
      input_tokens: 0,
      cache_read_input_tokens: 150_000,
      cache_creation_input_tokens: 0,
    }));
    const result = computeAdaptiveMaxTurns(state, 0.85, 15);
    expect(result.reason).toMatch(/growth rate \d+ tok\/turn/);
    expect(result.reason).toMatch(/budget \d+ tokens/);
    expect(result.reason).toMatch(/predicted \d+ turns/);
    expect(result.reason).toMatch(/clamped to \d+/);
  });

  // ── Fresh monitor (relay) ─────────────────────────────────────

  it("returns configured default for fresh monitor (simulating relay session start)", () => {
    // Fresh state = what happens at start of relay session
    const freshState = createTokenMonitorState();
    const result = computeAdaptiveMaxTurns(freshState, 0.85, 15);
    expect(result.maxTurns).toBe(15);
    expect(result.reason).toContain("no growth data");
  });
});
