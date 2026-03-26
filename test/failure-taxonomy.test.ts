/**
 * Failure Taxonomy tests — classification rules, record building, JSONL persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  classifyError,
  buildFailureRecord,
  appendFailureRecord,
  RULES,
} from "../src/failure-taxonomy.js";
import { PerJobCostExceededError } from "../src/types.js";
import type { FailureRecord } from "../src/types.js";

const TEST_DIR = join(process.cwd(), ".test-failure-taxonomy-tmp");

describe("Failure Taxonomy", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── classifyError: Known typed errors ───────────────────────────

  describe("classifyError — budget-exceeded", () => {
    it("classifies PerJobCostExceededError by error name", () => {
      const err = new PerJobCostExceededError(1.5, 1.0);
      const result = classifyError(err);
      expect(result.category).toBe("budget-exceeded");
      expect(result.retryable).toBe(false);
    });

    it("classifies a custom error with name PerJobCostExceededError", () => {
      const err = new Error("cost exceeded");
      err.name = "PerJobCostExceededError";
      const result = classifyError(err);
      expect(result.category).toBe("budget-exceeded");
    });
  });

  // ── classifyError: Auth issues ──────────────────────────────────

  describe("classifyError — auth-issue", () => {
    it("classifies auth verification failed", () => {
      const result = classifyError(new Error("auth verification failed"));
      expect(result.category).toBe("auth-issue");
      expect(result.retryable).toBe(true);
    });

    it("classifies 'no session id returned'", () => {
      const result = classifyError(new Error("no session id returned"));
      expect(result.category).toBe("auth-issue");
    });

    it("classifies 'unauthorized' (case-insensitive)", () => {
      const result = classifyError(new Error("UNAUTHORIZED request"));
      expect(result.category).toBe("auth-issue");
    });

    it("classifies 'token expired'", () => {
      const result = classifyError(new Error("token expired please re-login"));
      expect(result.category).toBe("auth-issue");
      expect(result.retryable).toBe(true);
    });

    it("classifies 'login required'", () => {
      const result = classifyError(new Error("login required"));
      expect(result.category).toBe("auth-issue");
    });

    it("classifies AUTH_TIMEOUT", () => {
      const result = classifyError(new Error("AUTH_TIMEOUT waiting for session"));
      expect(result.category).toBe("auth-issue");
    });

    it("classifies 'authentication'", () => {
      const result = classifyError(new Error("authentication required"));
      expect(result.category).toBe("auth-issue");
    });
  });

  // ── classifyError: Infrastructure / transient ───────────────────

  describe("classifyError — infra-issue", () => {
    it("classifies ENOSPC (disk full)", () => {
      const result = classifyError(new Error("ENOSPC: no space left on device"));
      expect(result.category).toBe("infra-issue");
      expect(result.retryable).toBe(true);
    });

    it("classifies ECONNREFUSED", () => {
      const result = classifyError(new Error("connect ECONNREFUSED 127.0.0.1:3000"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies ETIMEDOUT", () => {
      const result = classifyError(new Error("ETIMEDOUT"));
      expect(result.category).toBe("infra-issue");
      expect(result.retryable).toBe(true);
    });

    it("classifies 'rate limit'", () => {
      const result = classifyError(new Error("rate limit exceeded"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies '503'", () => {
      const result = classifyError(new Error("HTTP 503 Service Unavailable"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies 'socket hang up'", () => {
      const result = classifyError(new Error("socket hang up"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies 'overloaded'", () => {
      const result = classifyError(new Error("API is overloaded"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies ENOMEM", () => {
      const result = classifyError(new Error("ENOMEM: not enough memory"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies ECONNRESET", () => {
      const result = classifyError(new Error("read ECONNRESET"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies EPIPE", () => {
      const result = classifyError(new Error("write EPIPE"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies EAI_AGAIN (DNS)", () => {
      const result = classifyError(new Error("getaddrinfo EAI_AGAIN api.anthropic.com"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies 'network error'", () => {
      const result = classifyError(new Error("network error: connection lost"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies 'status 429' (rate limit HTTP)", () => {
      const result = classifyError(new Error("Request failed with status 429"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies 'HTTP 502' (bad gateway)", () => {
      const result = classifyError(new Error("HTTP 502 Bad Gateway"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies 'capacity'", () => {
      const result = classifyError(new Error("API at capacity, try again later"));
      expect(result.category).toBe("infra-issue");
    });

    it("classifies daemon restart", () => {
      const result = classifyError(new Error("Daemon restarted — job was interrupted"));
      expect(result.category).toBe("infra-issue");
      expect(result.retryable).toBe(true);
    });
  });

  // ── classifyError: SDK bugs ─────────────────────────────────────

  describe("classifyError — sdk-bug", () => {
    it("classifies 'protocol error' in message", () => {
      const result = classifyError(new Error("protocol error in stream"));
      expect(result.category).toBe("sdk-bug");
      expect(result.retryable).toBe(true);
    });

    it("classifies 'stream error' in message", () => {
      const result = classifyError(new Error("stream error: unexpected EOF"));
      expect(result.category).toBe("sdk-bug");
    });

    it("classifies 'unexpected message type'", () => {
      const result = classifyError(new Error("unexpected message type received"));
      expect(result.category).toBe("sdk-bug");
    });

    it("classifies 'invalid json'", () => {
      const result = classifyError(new Error("invalid json in response chunk"));
      expect(result.category).toBe("sdk-bug");
    });

    it("classifies 'chunk parsing'", () => {
      const result = classifyError(new Error("chunk parsing failed at offset 42"));
      expect(result.category).toBe("sdk-bug");
    });

    it("classifies by stack trace containing claude-agent-sdk", () => {
      const err = new Error("something went wrong");
      err.stack = `Error: something went wrong
    at Object.parse (/node_modules/@anthropic-ai/claude-agent-sdk/dist/index.js:42)
    at processStream (internal/streams.js:100)
    at run (src/cli.ts:50)`;
      const result = classifyError(err);
      expect(result.category).toBe("sdk-bug");
    });

    it("classifies by stack trace containing node_modules/@anthropic-ai", () => {
      const err = new Error("unexpected");
      err.stack = `Error: unexpected
    at something (node_modules/@anthropic-ai/sdk/lib.js:10)
    at other (src/relay.ts:20)`;
      const result = classifyError(err);
      expect(result.category).toBe("sdk-bug");
    });
  });

  // ── classifyError: GaryClaw bugs ────────────────────────────────

  describe("classifyError — garyclaw-bug", () => {
    it("classifies by stack trace containing src/orchestrator.ts", () => {
      const err = new Error("Cannot read properties of undefined");
      err.stack = `TypeError: Cannot read properties of undefined
    at buildPrompt (src/orchestrator.ts:150:22)
    at runSegment (src/orchestrator.ts:80:10)`;
      const result = classifyError(err);
      expect(result.category).toBe("garyclaw-bug");
      expect(result.retryable).toBe(false);
    });

    it("classifies by stack trace containing src/pipeline.ts", () => {
      const err = new Error("index out of bounds");
      err.stack = `Error: index out of bounds\n    at runPipeline (src/pipeline.ts:45)`;
      const result = classifyError(err);
      expect(result.category).toBe("garyclaw-bug");
    });

    it("classifies by stack trace containing src/relay.ts", () => {
      const err = new Error("stash failed");
      err.stack = `Error: stash failed\n    at prepareRelay (src/relay.ts:20)`;
      const result = classifyError(err);
      expect(result.category).toBe("garyclaw-bug");
    });

    it("classifies by stack trace containing src/daemon", () => {
      const err = new Error("ipc error");
      err.stack = `Error: ipc error\n    at handleRequest (src/daemon-ipc.ts:30)`;
      const result = classifyError(err);
      expect(result.category).toBe("garyclaw-bug");
    });
  });

  // ── classifyError: Project bugs ─────────────────────────────────

  describe("classifyError — project-bug", () => {
    it("classifies 'test failed'", () => {
      const result = classifyError(new Error("test failed: 3 of 10 tests"));
      expect(result.category).toBe("project-bug");
      expect(result.retryable).toBe(false);
    });

    it("classifies 'eslint'", () => {
      const result = classifyError(new Error("eslint found 5 problems"));
      expect(result.category).toBe("project-bug");
    });

    it("classifies 'build failed'", () => {
      const result = classifyError(new Error("build failed with exit code 1"));
      expect(result.category).toBe("project-bug");
    });

    it("classifies 'merge conflict'", () => {
      const result = classifyError(new Error("merge conflict in src/index.ts"));
      expect(result.category).toBe("project-bug");
    });

    it("classifies 'CONFLICT'", () => {
      const result = classifyError(new Error("CONFLICT (content): Merge conflict in file.ts"));
      expect(result.category).toBe("project-bug");
    });

    it("classifies 'tests failed' (plural)", () => {
      const result = classifyError(new Error("tests failed: 5 of 20"));
      expect(result.category).toBe("project-bug");
    });

    it("classifies 'lint error'", () => {
      const result = classifyError(new Error("lint error in src/app.ts"));
      expect(result.category).toBe("project-bug");
    });

    it("classifies 'tsc error'", () => {
      const result = classifyError(new Error("tsc error TS2322: Type 'string' not assignable"));
      expect(result.category).toBe("project-bug");
    });

    it("classifies 'TypeError'", () => {
      const result = classifyError(new Error("TypeError: Cannot read property 'foo'"));
      expect(result.category).toBe("project-bug");
    });

    it("classifies 'compilation failed'", () => {
      const result = classifyError(new Error("compilation failed with 3 errors"));
      expect(result.category).toBe("project-bug");
    });
  });

  // ── classifyError: Skill bugs ───────────────────────────────────

  describe("classifyError — skill-bug", () => {
    it("classifies 'skill failed' in message", () => {
      const result = classifyError(new Error("skill failed: qa"));
      expect(result.category).toBe("skill-bug");
      expect(result.retryable).toBe(false);
    });

    it("classifies 'SKILL.md not found'", () => {
      const result = classifyError(new Error("SKILL.md not found"));
      expect(result.category).toBe("skill-bug");
    });

    it("classifies by stack trace with .claude/skills/", () => {
      const err = new Error("runtime error");
      err.stack = `Error: runtime error\n    at executeSkill (.claude/skills/qa/SKILL.md:10)`;
      const result = classifyError(err);
      expect(result.category).toBe("skill-bug");
    });

    it("classifies 'skill error'", () => {
      const result = classifyError(new Error("skill error: timeout in design-review"));
      expect(result.category).toBe("skill-bug");
    });
  });

  // ── classifyError: Unknown fallback ─────────────────────────────

  describe("classifyError — unknown", () => {
    it("falls back to unknown for unrecognized errors", () => {
      const result = classifyError(new Error("something completely unexpected"));
      expect(result.category).toBe("unknown");
      expect(result.retryable).toBe(false);
      expect(result.suggestion).toContain("Unclassified");
    });

    it("handles empty error message", () => {
      const result = classifyError(new Error(""));
      expect(result.category).toBe("unknown");
    });
  });

  // ── classifyError: Priority ordering ────────────────────────────

  describe("classifyError — priority ordering", () => {
    it("budget-exceeded wins over infra patterns", () => {
      // PerJobCostExceededError.name is checked before message patterns
      const err = new PerJobCostExceededError(2.0, 1.0);
      const result = classifyError(err);
      expect(result.category).toBe("budget-exceeded");
    });

    it("SDK stack wins over GaryClaw stack (SDK rule is higher priority)", () => {
      const err = new Error("unexpected");
      err.stack = `Error: unexpected
    at parse (node_modules/@anthropic-ai/claude-agent-sdk/dist/index.js:42)
    at runSegment (src/orchestrator.ts:80)`;
      const result = classifyError(err);
      expect(result.category).toBe("sdk-bug");
    });

    it("auth wins over project (auth rule is higher priority)", () => {
      // "authentication" appears in auth rule, even though it could vaguely relate to project
      const result = classifyError(new Error("authentication failed for git push"));
      expect(result.category).toBe("auth-issue");
    });
  });

  // ── classifyError: Case insensitivity ───────────────────────────

  describe("classifyError — case insensitivity", () => {
    it("matches ENOSPC case-insensitively", () => {
      const result = classifyError(new Error("enospc: no space left"));
      expect(result.category).toBe("infra-issue");
    });

    it("matches 'Test Failed' with different casing", () => {
      const result = classifyError(new Error("Test Failed: 5 errors"));
      expect(result.category).toBe("project-bug");
    });
  });

  // ── classifyError: Non-Error objects ────────────────────────────

  describe("classifyError — non-Error objects", () => {
    it("handles string throw", () => {
      const result = classifyError("auth verification failed");
      expect(result.category).toBe("auth-issue");
    });

    it("handles number throw", () => {
      const result = classifyError(42);
      expect(result.category).toBe("unknown");
    });

    it("handles undefined", () => {
      const result = classifyError(undefined);
      expect(result.category).toBe("unknown");
    });

    it("handles null", () => {
      const result = classifyError(null);
      expect(result.category).toBe("unknown");
    });
  });

  // ── buildFailureRecord ──────────────────────────────────────────

  describe("buildFailureRecord", () => {
    it("produces complete FailureRecord with all fields", () => {
      const err = new PerJobCostExceededError(1.5, 1.0);
      const record = buildFailureRecord(err, "job-123", ["qa", "ship"], "review-bot");

      expect(record.timestamp).toBeTruthy();
      expect(record.jobId).toBe("job-123");
      expect(record.skills).toEqual(["qa", "ship"]);
      expect(record.category).toBe("budget-exceeded");
      expect(record.retryable).toBe(false);
      expect(record.errorMessage).toContain("Per-job cost limit exceeded");
      expect(record.errorName).toBe("PerJobCostExceededError");
      expect(record.stackTrace).toBeTruthy();
      expect(record.instanceName).toBe("review-bot");
      expect(record.suggestion).toContain("budget");
    });

    it("handles non-Error objects", () => {
      const record = buildFailureRecord("something broke", "job-456", ["qa"]);
      expect(record.errorMessage).toBe("something broke");
      expect(record.errorName).toBeUndefined();
      expect(record.stackTrace).toBeUndefined();
      expect(record.instanceName).toBeUndefined();
    });

    it("truncates stack trace to first 5 lines", () => {
      const err = new Error("test");
      err.stack = Array.from({ length: 20 }, (_, i) => `    at line${i} (file.ts:${i})`).join("\n");
      const record = buildFailureRecord(err, "job-789", ["qa"]);
      const lines = record.stackTrace!.split("\n");
      expect(lines.length).toBe(5);
    });
  });

  // ── appendFailureRecord ─────────────────────────────────────────

  describe("appendFailureRecord", () => {
    it("creates failures.jsonl and appends record", () => {
      const record: FailureRecord = {
        timestamp: "2026-03-27T00:00:00.000Z",
        jobId: "job-test",
        skills: ["qa"],
        category: "unknown",
        retryable: false,
        errorMessage: "test error",
      };

      appendFailureRecord(record, TEST_DIR);

      const filePath = join(TEST_DIR, "failures.jsonl");
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.jobId).toBe("job-test");
    });

    it("appends multiple records as separate lines", () => {
      const record1: FailureRecord = {
        timestamp: "2026-03-27T00:00:00.000Z",
        jobId: "job-1",
        skills: ["qa"],
        category: "auth-issue",
        retryable: true,
        errorMessage: "auth failed",
      };
      const record2: FailureRecord = {
        timestamp: "2026-03-27T00:01:00.000Z",
        jobId: "job-2",
        skills: ["ship"],
        category: "infra-issue",
        retryable: true,
        errorMessage: "ENOSPC",
      };

      appendFailureRecord(record1, TEST_DIR);
      appendFailureRecord(record2, TEST_DIR);

      const filePath = join(TEST_DIR, "failures.jsonl");
      const lines = readFileSync(filePath, "utf-8").trim().split("\n");
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).jobId).toBe("job-1");
      expect(JSON.parse(lines[1]).jobId).toBe("job-2");
    });

    it("creates directory if it does not exist", () => {
      const subDir = join(TEST_DIR, "deep", "nested");
      const record: FailureRecord = {
        timestamp: "2026-03-27T00:00:00.000Z",
        jobId: "job-nested",
        skills: ["qa"],
        category: "unknown",
        retryable: false,
        errorMessage: "test",
      };

      appendFailureRecord(record, subDir);
      expect(existsSync(join(subDir, "failures.jsonl"))).toBe(true);
    });

    it("does not throw on write failure", () => {
      // Pass a path that is not writable (a file, not a dir)
      // appendFailureRecord swallows errors gracefully
      expect(() => {
        appendFailureRecord(
          {
            timestamp: "2026-03-27T00:00:00.000Z",
            jobId: "job-fail",
            skills: ["qa"],
            category: "unknown",
            retryable: false,
            errorMessage: "test",
          },
          "/dev/null/impossible/path",
        );
      }).not.toThrow();
    });
  });

  // ── RULES table integrity ───────────────────────────────────────

  describe("RULES table", () => {
    it("has at least one rule per non-unknown category", () => {
      const categories = new Set(RULES.map((r) => r.category));
      expect(categories.has("budget-exceeded")).toBe(true);
      expect(categories.has("auth-issue")).toBe(true);
      expect(categories.has("infra-issue")).toBe(true);
      expect(categories.has("sdk-bug")).toBe(true);
      expect(categories.has("garyclaw-bug")).toBe(true);
      expect(categories.has("project-bug")).toBe(true);
      expect(categories.has("skill-bug")).toBe(true);
    });

    it("every rule has a non-empty suggestion", () => {
      for (const rule of RULES) {
        expect(rule.suggestion.length).toBeGreaterThan(0);
      }
    });

    it("every rule has at least one matcher defined", () => {
      for (const rule of RULES) {
        const hasErrorNames = rule.errorNames && rule.errorNames.length > 0;
        const hasMessagePatterns = rule.messagePatterns && rule.messagePatterns.length > 0;
        const hasStackPatterns = rule.stackPatterns && rule.stackPatterns.length > 0;
        expect(hasErrorNames || hasMessagePatterns || hasStackPatterns).toBe(true);
      }
    });
  });
});
