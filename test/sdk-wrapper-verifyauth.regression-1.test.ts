/**
 * Regression: verifyAuth() — zero test coverage
 * Found by /qa on 2026-03-26
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-26.md
 *
 * Tests verifyAuth() success path, error subtype, and no-session-ID paths.
 * Mocks the SDK query() function to avoid real API calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK before importing verifyAuth
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { verifyAuth } from "../src/sdk-wrapper.js";

/** Create an async iterable that yields the given messages */
function makeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= items.length) return { done: true as const, value: undefined };
          return { done: false as const, value: items[i++] };
        },
      };
    },
  };
}

describe("verifyAuth", () => {
  beforeEach(() => {
    vi.mocked(query).mockReset();
  });

  it("returns sessionId on successful auth", async () => {
    vi.mocked(query).mockReturnValue(
      makeAsyncIterable([
        {
          type: "result",
          session_id: "sess-auth-123",
          subtype: "success",
          result: "OK",
        },
      ]) as any,
    );

    const sessionId = await verifyAuth({ HOME: "/home/test" });
    expect(sessionId).toBe("sess-auth-123");
  });

  it("throws when result subtype is error", async () => {
    vi.mocked(query).mockReturnValue(
      makeAsyncIterable([
        {
          type: "result",
          session_id: "sess-err",
          subtype: "error",
          error: "Invalid credentials",
        },
      ]) as any,
    );

    await expect(verifyAuth({ HOME: "/home/test" })).rejects.toThrow(
      "Auth verification failed: Invalid credentials",
    );
  });

  it("throws with 'unknown error' when error field is missing", async () => {
    vi.mocked(query).mockReturnValue(
      makeAsyncIterable([
        {
          type: "result",
          session_id: "sess-err",
          subtype: "error",
        },
      ]) as any,
    );

    await expect(verifyAuth({ HOME: "/home/test" })).rejects.toThrow(
      "Auth verification failed: unknown error",
    );
  });

  it("throws when no session ID returned", async () => {
    vi.mocked(query).mockReturnValue(
      makeAsyncIterable([
        {
          type: "result",
          // No session_id
          subtype: "success",
        },
      ]) as any,
    );

    await expect(verifyAuth({ HOME: "/home/test" })).rejects.toThrow(
      "Auth verification failed: no session ID returned",
    );
  });

  it("throws when generator yields no messages at all", async () => {
    vi.mocked(query).mockReturnValue(
      makeAsyncIterable([]) as any,
    );

    await expect(verifyAuth({ HOME: "/home/test" })).rejects.toThrow(
      "Auth verification failed: no session ID returned",
    );
  });

  it("ignores non-result messages and extracts sessionId from result", async () => {
    vi.mocked(query).mockReturnValue(
      makeAsyncIterable([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "OK" }] },
        },
        {
          type: "result",
          session_id: "sess-after-assistant",
          subtype: "success",
          result: "OK",
        },
      ]) as any,
    );

    const sessionId = await verifyAuth({ HOME: "/home/test" });
    expect(sessionId).toBe("sess-after-assistant");
  });

  it("passes env to query options", async () => {
    vi.mocked(query).mockReturnValue(
      makeAsyncIterable([
        {
          type: "result",
          session_id: "sess-env",
          subtype: "success",
        },
      ]) as any,
    );

    await verifyAuth({ HOME: "/home/test", CUSTOM_VAR: "value" });

    expect(query).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(query).mock.calls[0][0];
    expect(callArgs.options.env).toEqual({ HOME: "/home/test", CUSTOM_VAR: "value" });
  });

  it("uses maxTurns=1 and bypassPermissions", async () => {
    vi.mocked(query).mockReturnValue(
      makeAsyncIterable([
        {
          type: "result",
          session_id: "sess-config",
          subtype: "success",
        },
      ]) as any,
    );

    await verifyAuth({ HOME: "/home/test" });

    const callArgs = vi.mocked(query).mock.calls[0][0];
    expect(callArgs.options.maxTurns).toBe(1);
    expect(callArgs.options.permissionMode).toBe("bypassPermissions");
    expect(callArgs.options.allowDangerouslySkipPermissions).toBe(true);
  });

  it("uses a simple prompt that asks for OK", async () => {
    vi.mocked(query).mockReturnValue(
      makeAsyncIterable([
        {
          type: "result",
          session_id: "sess-prompt",
          subtype: "success",
        },
      ]) as any,
    );

    await verifyAuth({ HOME: "/home/test" });

    const callArgs = vi.mocked(query).mock.calls[0][0];
    expect(callArgs.prompt).toContain("OK");
  });
});
