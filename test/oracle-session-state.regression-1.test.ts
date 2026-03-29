// Regression: ISSUE-002 — TS narrowing failure for SessionAction union in oracle.ts
// Found by /qa on 2026-03-29
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
//
// handleError returns SessionAction which is a discriminated union of
// { action: "return" }, { action: "retry" }, and { action: "throw"; error: Error }.
// The catch block in createSdkOracleQueryFn must narrow correctly after
// checking for "retry" — the remaining cases are "return" and "throw".
// This test verifies the type contract at runtime.

import { describe, it, expect } from "vitest";
import {
  OracleSessionState,
  ORACLE_QUESTION_MARKER,
} from "../src/oracle.js";
import type { SessionAction } from "../src/oracle.js";

function makePrompt(q: string): string {
  return `Prefix\n\n${ORACLE_QUESTION_MARKER}${q}\n\nRespond as JSON.`;
}

describe("SessionAction union narrowing regression", () => {
  it("handleError returns { action: 'retry' } on first resume failure", () => {
    const state = new OracleSessionState();
    // Cold start succeeds — establish session
    state.prepareCall(makePrompt("Q1"));
    state.handleSuccess("answer", "sess-1");
    // Resume call
    state.prepareCall(makePrompt("Q2"));
    const action = state.handleError(new Error("resume failed"));
    expect(action.action).toBe("retry");
    // TypeScript should NOT have .error on retry variant
    expect(action).not.toHaveProperty("error");
  });

  it("handleError returns { action: 'throw', error } on cold start failure", () => {
    const state = new OracleSessionState();
    state.prepareCall(makePrompt("Q1"));
    const action = state.handleError(new Error("cold start failed"));
    expect(action.action).toBe("throw");
    // Narrow to throw variant — .error must exist
    if (action.action === "throw") {
      expect(action.error).toBeInstanceOf(Error);
      expect(action.error.message).toBe("cold start failed");
    }
  });

  it("handleError wraps non-Error objects", () => {
    const state = new OracleSessionState();
    state.prepareCall(makePrompt("Q1"));
    const action = state.handleError("string error");
    expect(action.action).toBe("throw");
    if (action.action === "throw") {
      expect(action.error).toBeInstanceOf(Error);
      expect(action.error.message).toContain("string error");
    }
  });

  it("handleSuccess never returns { action: 'throw' }", () => {
    const state = new OracleSessionState();
    state.prepareCall(makePrompt("Q1"));

    // Success with result + session → return
    const a1 = state.handleSuccess("result", "sess-1");
    expect(a1.action).toBe("return");

    // Success with empty result on cold start → return (empty)
    const state2 = new OracleSessionState();
    state2.prepareCall(makePrompt("Q2"));
    const a2 = state2.handleSuccess("", null);
    expect(a2.action).toBe("return");
  });

  it("all SessionAction variants are discriminable at runtime", () => {
    // Collect all 3 action types
    const actions: SessionAction[] = [];

    // "return" from handleSuccess
    const s1 = new OracleSessionState();
    s1.prepareCall(makePrompt("Q"));
    actions.push(s1.handleSuccess("ok", "sess"));

    // "retry" from handleError on resume
    const s2 = new OracleSessionState();
    s2.prepareCall(makePrompt("Q"));
    s2.handleSuccess("ok", "sess");
    s2.prepareCall(makePrompt("Q2"));
    actions.push(s2.handleError(new Error("fail")));

    // "throw" from handleError on cold start
    const s3 = new OracleSessionState();
    s3.prepareCall(makePrompt("Q"));
    actions.push(s3.handleError(new Error("fail")));

    // Verify all 3 discriminants present
    const types = actions.map(a => a.action);
    expect(types).toContain("return");
    expect(types).toContain("retry");
    expect(types).toContain("throw");

    // Verify narrowing works for each
    for (const action of actions) {
      if (action.action === "return") {
        expect(typeof action.result).toBe("string");
      } else if (action.action === "retry") {
        expect(Object.keys(action)).toEqual(["action"]);
      } else if (action.action === "throw") {
        expect(action.error).toBeInstanceOf(Error);
      }
    }
  });
});
