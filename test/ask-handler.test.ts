import { describe, it, expect, vi } from "vitest";
import { createAskHandler } from "../src/ask-handler.js";

function makeAskInput(
  question: string,
  options: { label: string; description: string }[],
): Record<string, unknown> {
  return {
    questions: [
      {
        question,
        header: "Test",
        options,
        multiSelect: false,
      },
    ],
  };
}

describe("ask-handler", () => {
  const defaultOptions = [
    { label: "Dark", description: "Dark theme" },
    { label: "Light", description: "Light theme" },
  ];

  describe("canUseTool — non-AskUserQuestion", () => {
    it("passes through non-AskUserQuestion tools", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const result = await handler.canUseTool("Bash", { command: "ls" });
      expect(result.behavior).toBe("allow");
      expect(result.updatedInput).toBeUndefined();
    });

    it("passes through Read, Edit, Glob, Grep", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      for (const tool of ["Read", "Edit", "Glob", "Grep"]) {
        const result = await handler.canUseTool(tool, {});
        expect(result.behavior).toBe("allow");
      }
    });
  });

  describe("canUseTool — AskUserQuestion interception", () => {
    it("intercepts AskUserQuestion and calls onAskUser", async () => {
      const onAskUser = vi.fn().mockResolvedValue("Dark");
      const handler = createAskHandler({
        onAskUser,
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const input = makeAskInput("Which color theme?", defaultOptions);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(onAskUser).toHaveBeenCalledWith("Which color theme?", defaultOptions);
      expect(result.behavior).toBe("allow");
    });

    it("builds updatedInput with pre-filled answer", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Dark"),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const input = makeAskInput("Which color theme?", defaultOptions);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(result.updatedInput).toBeDefined();
      expect(result.updatedInput!.answers).toEqual({
        "Which color theme?": "Dark",
      });
      // Original questions should be preserved
      expect(result.updatedInput!.questions).toEqual(input.questions);
    });

    it("records decision with full context", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Light"),
        askTimeoutMs: 5000,
        sessionIndex: 2,
      });

      const input = makeAskInput("Which theme?", defaultOptions);
      await handler.canUseTool("AskUserQuestion", input);

      const decisions = handler.getDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].question).toBe("Which theme?");
      expect(decisions[0].chosen).toBe("Light");
      expect(decisions[0].sessionIndex).toBe(2);
      expect(decisions[0].confidence).toBe(10);
      expect(decisions[0].principle).toBe("Human override");
    });

    it("records multiple decisions", async () => {
      let callCount = 0;
      const handler = createAskHandler({
        onAskUser: vi.fn().mockImplementation(() => {
          callCount++;
          return Promise.resolve(callCount === 1 ? "Dark" : "Light");
        }),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      await handler.canUseTool("AskUserQuestion", makeAskInput("Q1?", defaultOptions));
      await handler.canUseTool("AskUserQuestion", makeAskInput("Q2?", defaultOptions));

      const decisions = handler.getDecisions();
      expect(decisions).toHaveLength(2);
      expect(decisions[0].chosen).toBe("Dark");
      expect(decisions[1].chosen).toBe("Light");
    });
  });

  describe("canUseTool — edge cases", () => {
    it("allows AskUserQuestion with empty questions array", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const result = await handler.canUseTool("AskUserQuestion", { questions: [] });
      expect(result.behavior).toBe("allow");
      expect(result.updatedInput).toBeUndefined();
    });

    it("allows AskUserQuestion with no questions field", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const result = await handler.canUseTool("AskUserQuestion", {});
      expect(result.behavior).toBe("allow");
    });
  });

  describe("canUseTool — timeout", () => {
    it("denies on timeout", async () => {
      const handler = createAskHandler({
        onAskUser: () => new Promise(() => {}), // Never resolves
        askTimeoutMs: 50,
        sessionIndex: 0,
      });

      const input = makeAskInput("Slow question?", defaultOptions);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(result.behavior).toBe("deny");
      expect(result.message).toContain("timed out");
    });

    it("denies on onAskUser rejection", async () => {
      const handler = createAskHandler({
        onAskUser: () => Promise.reject(new Error("readline closed")),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      const input = makeAskInput("Error question?", defaultOptions);
      const result = await handler.canUseTool("AskUserQuestion", input);

      expect(result.behavior).toBe("deny");
      expect(result.message).toContain("handler error");
    });
  });

  describe("getDecisions", () => {
    it("returns empty array when no decisions made", () => {
      const handler = createAskHandler({
        onAskUser: vi.fn(),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });
      expect(handler.getDecisions()).toEqual([]);
    });

    it("returns a copy (not a reference)", async () => {
      const handler = createAskHandler({
        onAskUser: vi.fn().mockResolvedValue("Dark"),
        askTimeoutMs: 5000,
        sessionIndex: 0,
      });

      await handler.canUseTool("AskUserQuestion", makeAskInput("Q?", defaultOptions));

      const d1 = handler.getDecisions();
      const d2 = handler.getDecisions();
      expect(d1).not.toBe(d2);
      expect(d1).toEqual(d2);
    });
  });
});
