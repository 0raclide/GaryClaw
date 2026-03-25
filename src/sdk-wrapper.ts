/**
 * SDK wrapper — thin compatibility layer isolating the codebase from pre-1.0
 * Agent SDK API changes. All SDK imports go through here.
 *
 * When the SDK ships 1.0, update this file only.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  SegmentOptions,
  SegmentResult,
  SdkUsage,
  SdkModelUsageEntry,
} from "./types.js";

// Re-export SDK types for stable import paths
export { query };
export type { SDKMessage };

/**
 * Start a bounded query segment. Returns the async generator.
 */
export function startSegment(options: SegmentOptions): AsyncIterable<SDKMessage> {
  return query({
    prompt: options.prompt,
    options: {
      maxTurns: options.maxTurns,
      cwd: options.cwd,
      env: options.env,
      settingSources: options.settingSources as any,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      canUseTool: options.canUseTool as any,
      ...(options.resume ? { resume: options.resume } : {}),
    },
  });
}

/**
 * Extract per-turn usage from an AssistantMessage.
 * Returns null if the message doesn't have usage data.
 */
export function extractTurnUsage(msg: SDKMessage): SdkUsage | null {
  if (msg.type !== "assistant") return null;
  const usage = (msg as any).message?.usage;
  if (!usage) return null;
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
  };
}

/**
 * Extract aggregate result data from a ResultMessage.
 */
export function extractResultData(msg: SDKMessage): SegmentResult | null {
  if (msg.type !== "result") return null;
  const m = msg as any;
  return {
    sessionId: m.session_id ?? "",
    subtype: m.subtype ?? "",
    resultText: m.result ?? "",
    usage: m.usage ?? null,
    modelUsage: m.modelUsage ?? null,
    totalCostUsd: m.total_cost_usd ?? 0,
    numTurns: m.num_turns ?? 0,
  };
}

/**
 * Build SDK-safe env by stripping ANTHROPIC_API_KEY.
 * This ensures the SDK uses Claude Max login instead of API billing.
 */
export function buildSdkEnv(
  processEnv: Record<string, string | undefined>,
): Record<string, string> {
  const { ANTHROPIC_API_KEY: _, ...rest } = processEnv;
  // Filter out undefined values
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Verify auth by running a minimal 1-turn query.
 * Throws if auth fails.
 */
export async function verifyAuth(env: Record<string, string>): Promise<string> {
  let sessionId = "";
  const gen = query({
    prompt: 'Say exactly "OK" and nothing else.',
    options: {
      maxTurns: 1,
      env,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      canUseTool: async () => ({ behavior: "allow" as const }),
    },
  });

  for await (const msg of gen) {
    if (msg.type === "result") {
      sessionId = (msg as any).session_id ?? "";
      const subtype = (msg as any).subtype;
      if (subtype === "error") {
        throw new Error(`Auth verification failed: ${(msg as any).error ?? "unknown error"}`);
      }
    }
  }

  if (!sessionId) {
    throw new Error("Auth verification failed: no session ID returned");
  }

  return sessionId;
}
