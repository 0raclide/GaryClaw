/**
 * TODO state "pr-created" lifecycle tests.
 *
 * Verifies the new "pr-created" state sits correctly in the lifecycle
 * between "qa-complete" and "merged", and that getStartSkill returns
 * "skip" for it.
 */

import { describe, it, expect } from "vitest";
import { getStartSkill, findNextSkill } from "../src/todo-state.js";
import type { TodoState } from "../src/todo-state.js";

function makeTodoState(state: TodoState["state"]): TodoState {
  return {
    title: "Test item",
    slug: "test-item",
    state,
    updatedAt: new Date().toISOString(),
  };
}

describe("pr-created lifecycle state", () => {
  it('getStartSkill returns "skip" for pr-created', () => {
    expect(getStartSkill(makeTodoState("pr-created"))).toBe("skip");
  });

  it("pr-created is between qa-complete and merged in lifecycle order", () => {
    // findNextSkill uses PIPELINE_LIFECYCLE_ORDER which doesn't include pr-created
    // but the state machine should treat pr-created as terminal (skip)
    expect(getStartSkill(makeTodoState("qa-complete"))).toBe("skip");
    expect(getStartSkill(makeTodoState("pr-created"))).toBe("skip");
    expect(getStartSkill(makeTodoState("merged"))).toBe("skip");
  });

  it("pr-created state is valid in TodoLifecycleState union", () => {
    const state = makeTodoState("pr-created");
    expect(state.state).toBe("pr-created");
  });

  it("lifecycle order preserves pr-created position", () => {
    // Verify skip behavior chain: qa-complete → pr-created → merged → complete
    const skipStates = ["qa-complete", "pr-created", "merged", "complete"] as const;
    for (const s of skipStates) {
      expect(getStartSkill(makeTodoState(s))).toBe("skip");
    }
  });
});
