// Tests for OracleSessionState — the pure state machine extracted from
// createSdkOracleQueryFn. Covers all 7 previously untested paths:
// batch reset, MAX_REUSE reset, resume vs cold start, success with session,
// resume fallback on empty result, resume fallback on error, cold start error propagation.
//
// Found by /plan-eng-review on 2026-03-29
// Report: State machine testability extraction

import { describe, it, expect, vi } from "vitest";
import {
  OracleSessionState,
  ORACLE_BATCH_MARKER,
  MAX_REUSE,
  ORACLE_QUESTION_MARKER,
} from "../src/oracle.js";
import type { OracleSessionEvent } from "../src/types.js";

function makePrompt(question: string): string {
  return `Some prefix\n\n${ORACLE_QUESTION_MARKER}${question}\n\nRespond as JSON.`;
}

function makeBatchPrompt(): string {
  return `Some prefix\n\n${ORACLE_BATCH_MARKER}\n\n1. Question one\n2. Question two`;
}

describe("OracleSessionState", () => {
  describe("prepareCall", () => {
    it("returns cold start on first call", () => {
      const state = new OracleSessionState();
      const result = state.prepareCall(makePrompt("What color?"));

      expect(result.isResume).toBe(false);
      expect(result.resumeSessionId).toBeNull();
      expect(result.effectivePrompt).toBe(makePrompt("What color?"));
    });

    it("returns resume after a successful call established a session", () => {
      const state = new OracleSessionState();
      state.prepareCall(makePrompt("Q1"));
      state.handleSuccess("answer", "session-abc");

      const result = state.prepareCall(makePrompt("Q2"));

      expect(result.isResume).toBe(true);
      expect(result.resumeSessionId).toBe("session-abc");
      // Resume prompt strips prefix, keeps question
      expect(result.effectivePrompt).toContain("New decision needed:");
      expect(result.effectivePrompt).toContain("Q2");
      expect(result.effectivePrompt).not.toContain("Some prefix");
    });

    it("resets session when batch marker is detected", () => {
      const onEvent = vi.fn();
      const state = new OracleSessionState(onEvent);

      // Establish a session
      state.prepareCall(makePrompt("Q1"));
      state.handleSuccess("answer", "session-abc");

      // Now send a batch prompt
      const result = state.prepareCall(makeBatchPrompt());

      expect(result.isResume).toBe(false);
      expect(result.resumeSessionId).toBeNull();
      expect(state.sessionId).toBeNull();
      expect(state.callCount).toBe(0);

      // Should emit session_reset event
      const resetEvents = onEvent.mock.calls.filter(
        (c) => c[0].type === "session_reset",
      );
      expect(resetEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("does not reset on batch marker when no session exists", () => {
      const onEvent = vi.fn();
      const state = new OracleSessionState(onEvent);

      const result = state.prepareCall(makeBatchPrompt());

      expect(result.isResume).toBe(false);
      // No session_reset event when there was no session
      const resetEvents = onEvent.mock.calls.filter(
        (c) => c[0].type === "session_reset",
      );
      expect(resetEvents).toHaveLength(0);
    });

    it("resets session after MAX_REUSE calls", () => {
      const onEvent = vi.fn();
      const state = new OracleSessionState(onEvent);

      // Establish a session and simulate MAX_REUSE calls
      state.prepareCall(makePrompt("Q0"));
      state.handleSuccess("answer", "session-abc");

      // Manually set callCount to MAX_REUSE to trigger reset
      state.callCount = MAX_REUSE;

      const result = state.prepareCall(makePrompt("Q-next"));

      expect(result.isResume).toBe(false);
      expect(result.resumeSessionId).toBeNull();
      expect(state.sessionId).toBeNull();
      expect(state.callCount).toBe(0);

      // Should emit session_reset
      const resetEvents = onEvent.mock.calls.filter(
        (c) => c[0].type === "session_reset",
      );
      expect(resetEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("does not reset when callCount is below MAX_REUSE", () => {
      const state = new OracleSessionState();

      state.prepareCall(makePrompt("Q0"));
      state.handleSuccess("answer", "session-abc");
      state.callCount = MAX_REUSE - 1;

      const result = state.prepareCall(makePrompt("Q-next"));

      expect(result.isResume).toBe(true);
      expect(result.resumeSessionId).toBe("session-abc");
    });
  });

  describe("handleSuccess", () => {
    it("returns result and updates session on success with result + sessionId", () => {
      const onEvent = vi.fn();
      const state = new OracleSessionState(onEvent);

      state.prepareCall(makePrompt("Q1"));
      const action = state.handleSuccess("the answer", "session-123");

      expect(action).toEqual({ action: "return", result: "the answer" });
      expect(state.sessionId).toBe("session-123");
      expect(state.callCount).toBe(1);

      // Should emit session_created (first call)
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session_created", sessionId: "session-123" }),
      );
    });

    it("emits session_resumed on successful resume", () => {
      const onEvent = vi.fn();
      const state = new OracleSessionState(onEvent);

      // First call establishes session
      state.prepareCall(makePrompt("Q1"));
      state.handleSuccess("answer1", "session-abc");
      onEvent.mockClear();

      // Second call resumes
      state.prepareCall(makePrompt("Q2"));
      const action = state.handleSuccess("answer2", "session-abc");

      expect(action).toEqual({ action: "return", result: "answer2" });
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session_resumed", sessionId: "session-abc" }),
      );
    });

    it("triggers retry when resume produces no result", () => {
      const onEvent = vi.fn();
      const state = new OracleSessionState(onEvent);

      // Establish session
      state.prepareCall(makePrompt("Q1"));
      state.handleSuccess("answer1", "session-abc");
      onEvent.mockClear();

      // Resume call with empty result
      state.prepareCall(makePrompt("Q2"));
      const action = state.handleSuccess("", null);

      expect(action).toEqual({ action: "retry" });
      expect(state.sessionId).toBeNull();
      expect(state.callCount).toBe(0);

      // Should emit resume_fallback
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "resume_fallback" }),
      );
    });

    it("returns empty result on cold start with no result (no retry)", () => {
      const state = new OracleSessionState();

      state.prepareCall(makePrompt("Q1"));
      const action = state.handleSuccess("", null);

      expect(action).toEqual({ action: "return", result: "" });
    });

    it("returns empty on second attempt (after retry) even in resume context", () => {
      const state = new OracleSessionState();

      // Establish session, then fail resume
      state.prepareCall(makePrompt("Q1"));
      state.handleSuccess("answer1", "session-abc");
      state.prepareCall(makePrompt("Q2"));
      state.handleSuccess("", null); // triggers retry

      // Cold retry also produces empty — should return, not retry again
      const action = state.handleSuccess("", null);

      expect(action).toEqual({ action: "return", result: "" });
    });

    it("increments callCount correctly across multiple successful calls", () => {
      const state = new OracleSessionState();

      for (let i = 0; i < 5; i++) {
        state.prepareCall(makePrompt(`Q${i}`));
        state.handleSuccess(`answer${i}`, "session-abc");
      }

      expect(state.callCount).toBe(5);
    });
  });

  describe("handleError", () => {
    it("triggers retry when resume throws an error", () => {
      const onEvent = vi.fn();
      const state = new OracleSessionState(onEvent);

      // Establish session
      state.prepareCall(makePrompt("Q1"));
      state.handleSuccess("answer1", "session-abc");
      onEvent.mockClear();

      // Resume call throws
      state.prepareCall(makePrompt("Q2"));
      const action = state.handleError(new Error("SDK connection reset"));

      expect(action).toEqual({ action: "retry" });
      expect(state.sessionId).toBeNull();
      expect(state.callCount).toBe(0);

      // Should emit resume_fallback
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "resume_fallback" }),
      );
    });

    it("propagates original Error on cold start failure", () => {
      const state = new OracleSessionState();

      state.prepareCall(makePrompt("Q1"));
      const action = state.handleError(new Error("429 rate limit exceeded, resets at 3pm"));

      expect(action.action).toBe("throw");
      if (action.action === "throw") {
        expect(action.error.message).toBe("429 rate limit exceeded, resets at 3pm");
      }
    });

    it("wraps non-Error values in an Error with context", () => {
      const state = new OracleSessionState();

      state.prepareCall(makePrompt("Q1"));
      const action = state.handleError("raw string error");

      expect(action.action).toBe("throw");
      if (action.action === "throw") {
        expect(action.error.message).toBe("Oracle query failed: raw string error");
        expect(action.error).toBeInstanceOf(Error);
      }
    });

    it("wraps undefined error in an Error", () => {
      const state = new OracleSessionState();

      state.prepareCall(makePrompt("Q1"));
      const action = state.handleError(undefined);

      expect(action.action).toBe("throw");
      if (action.action === "throw") {
        expect(action.error.message).toBe("Oracle query failed: undefined");
      }
    });

    it("throws after retry exhaustion (resume fails, then cold fails)", () => {
      const state = new OracleSessionState();

      // Establish session
      state.prepareCall(makePrompt("Q1"));
      state.handleSuccess("answer1", "session-abc");

      // Resume throws → retry
      state.prepareCall(makePrompt("Q2"));
      const retryAction = state.handleError(new Error("resume broken"));
      expect(retryAction).toEqual({ action: "retry" });

      // Cold start also throws → should propagate
      const throwAction = state.handleError(new Error("auth failed completely"));
      expect(throwAction.action).toBe("throw");
      if (throwAction.action === "throw") {
        expect(throwAction.error.message).toBe("auth failed completely");
      }
    });
  });

  describe("full lifecycle", () => {
    it("cold start → resume → MAX_REUSE reset → cold start", () => {
      const events: OracleSessionEvent[] = [];
      const state = new OracleSessionState((e) => events.push(e));

      // Cold start
      let prep = state.prepareCall(makePrompt("Q0"));
      expect(prep.isResume).toBe(false);
      state.handleSuccess("a0", "s1");
      expect(events[0].type).toBe("session_created");

      // Resume calls up to MAX_REUSE
      for (let i = 1; i < MAX_REUSE; i++) {
        prep = state.prepareCall(makePrompt(`Q${i}`));
        expect(prep.isResume).toBe(true);
        state.handleSuccess(`a${i}`, "s1");
      }

      expect(state.callCount).toBe(MAX_REUSE);

      // Next call triggers reset → cold start
      prep = state.prepareCall(makePrompt("Q-after-reset"));
      expect(prep.isResume).toBe(false);
      expect(state.callCount).toBe(0);

      const resetEvents = events.filter((e) => e.type === "session_reset");
      expect(resetEvents).toHaveLength(1);
    });

    it("cold start → resume → resume fallback (empty) → cold retry succeeds", () => {
      const events: OracleSessionEvent[] = [];
      const state = new OracleSessionState((e) => events.push(e));

      // Cold start succeeds
      state.prepareCall(makePrompt("Q0"));
      state.handleSuccess("a0", "s1");

      // Resume returns empty → retry
      state.prepareCall(makePrompt("Q1"));
      const retryAction = state.handleSuccess("", null);
      expect(retryAction).toEqual({ action: "retry" });

      // Cold retry succeeds
      const successAction = state.handleSuccess("a1-retry", "s2");
      expect(successAction).toEqual({ action: "return", result: "a1-retry" });
      expect(state.sessionId).toBe("s2");

      const fallbackEvents = events.filter((e) => e.type === "resume_fallback");
      expect(fallbackEvents).toHaveLength(1);
    });

    it("cold start → resume → resume error → cold retry succeeds", () => {
      const events: OracleSessionEvent[] = [];
      const state = new OracleSessionState((e) => events.push(e));

      // Cold start succeeds
      state.prepareCall(makePrompt("Q0"));
      state.handleSuccess("a0", "s1");

      // Resume throws → retry
      state.prepareCall(makePrompt("Q1"));
      const retryAction = state.handleError(new Error("resume broken"));
      expect(retryAction).toEqual({ action: "retry" });

      // Cold retry succeeds
      const successAction = state.handleSuccess("a1-retry", "s2");
      expect(successAction).toEqual({ action: "return", result: "a1-retry" });

      const fallbackEvents = events.filter((e) => e.type === "resume_fallback");
      expect(fallbackEvents).toHaveLength(1);
    });
  });
});
