import { describe, it, expect } from "vitest";
import { buildSdkEnv, extractTurnUsage, extractResultData, GARYCLAW_DAEMON_EMAIL } from "../src/sdk-wrapper.js";

describe("sdk-wrapper", () => {
  describe("buildSdkEnv", () => {
    it("strips ANTHROPIC_API_KEY", () => {
      const env = buildSdkEnv({
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-secret-123",
        HOME: "/home/user",
      });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.PATH).toBe("/usr/bin");
      expect(env.HOME).toBe("/home/user");
    });

    it("preserves all other env vars", () => {
      const env = buildSdkEnv({
        B: "/usr/local/bin/browse",
        GARYCLAW_TEST: "yes",
        NODE_ENV: "test",
      });
      expect(env.B).toBe("/usr/local/bin/browse");
      expect(env.GARYCLAW_TEST).toBe("yes");
      expect(env.NODE_ENV).toBe("test");
    });

    it("filters out undefined values", () => {
      const env = buildSdkEnv({
        DEFINED: "yes",
        UNDEFINED_VAR: undefined,
      });
      expect(env.DEFINED).toBe("yes");
      expect("UNDEFINED_VAR" in env).toBe(false);
    });

    it("works with empty env (still sets committer fields)", () => {
      const env = buildSdkEnv({});
      expect(env).toEqual({
        GIT_COMMITTER_EMAIL: GARYCLAW_DAEMON_EMAIL,
        GIT_COMMITTER_NAME: "GaryClaw Daemon",
      });
    });

    it("works when ANTHROPIC_API_KEY is already absent", () => {
      const env = buildSdkEnv({ PATH: "/usr/bin" });
      expect(env.PATH).toBe("/usr/bin");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("sets GIT_COMMITTER_EMAIL to GARYCLAW_DAEMON_EMAIL", () => {
      const env = buildSdkEnv({ PATH: "/usr/bin" });
      expect(env.GIT_COMMITTER_EMAIL).toBe(GARYCLAW_DAEMON_EMAIL);
      expect(env.GIT_COMMITTER_EMAIL).toBe("garyclaw-daemon@local");
    });

    it("sets GIT_COMMITTER_NAME to GaryClaw Daemon", () => {
      const env = buildSdkEnv({ PATH: "/usr/bin" });
      expect(env.GIT_COMMITTER_NAME).toBe("GaryClaw Daemon");
    });

    it("overrides user-provided GIT_COMMITTER_EMAIL", () => {
      const env = buildSdkEnv({
        GIT_COMMITTER_EMAIL: "user@example.com",
      });
      expect(env.GIT_COMMITTER_EMAIL).toBe(GARYCLAW_DAEMON_EMAIL);
    });
  });

  describe("extractTurnUsage", () => {
    it("extracts usage from assistant message", () => {
      const msg = {
        type: "assistant" as const,
        session_id: "test",
        message: {
          usage: {
            input_tokens: 3,
            output_tokens: 500,
            cache_read_input_tokens: 7525,
            cache_creation_input_tokens: 3069,
          },
        },
      };
      const usage = extractTurnUsage(msg as any);
      expect(usage).toEqual({
        input_tokens: 3,
        output_tokens: 500,
        cache_read_input_tokens: 7525,
        cache_creation_input_tokens: 3069,
      });
    });

    it("returns null for non-assistant messages", () => {
      expect(extractTurnUsage({ type: "result" } as any)).toBeNull();
      expect(extractTurnUsage({ type: "tool_use" } as any)).toBeNull();
    });

    it("returns null when usage is missing", () => {
      const msg = { type: "assistant", message: {} } as any;
      expect(extractTurnUsage(msg)).toBeNull();
    });

    it("returns null when message is missing", () => {
      const msg = { type: "assistant" } as any;
      expect(extractTurnUsage(msg)).toBeNull();
    });
  });

  describe("extractResultData", () => {
    it("extracts data from result message", () => {
      const msg = {
        type: "result" as const,
        session_id: "sess-123",
        subtype: "success",
        result: "Task complete",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 2000,
        },
        modelUsage: {
          "claude-opus-4-6": { contextWindow: 1_000_000 },
        },
        total_cost_usd: 0.045,
        num_turns: 3,
      };

      const result = extractResultData(msg as any);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("sess-123");
      expect(result!.subtype).toBe("success");
      expect(result!.resultText).toBe("Task complete");
      expect(result!.totalCostUsd).toBe(0.045);
      expect(result!.numTurns).toBe(3);
      expect(result!.modelUsage).toEqual({
        "claude-opus-4-6": { contextWindow: 1_000_000 },
      });
    });

    it("returns null for non-result messages", () => {
      expect(extractResultData({ type: "assistant" } as any)).toBeNull();
    });

    it("handles missing optional fields", () => {
      const msg = { type: "result" } as any;
      const result = extractResultData(msg);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe("");
      expect(result!.usage).toBeNull();
      expect(result!.totalCostUsd).toBe(0);
    });
  });
});
