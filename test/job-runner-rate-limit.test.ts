import { describe, it, expect } from "vitest";
import {
  isRateLimitError,
  parseRateLimitResetTime,
  RATE_LIMIT_FALLBACK_MS,
} from "../src/job-runner.js";

// ── isRateLimitError ──────────────────────────────────────────────

describe("isRateLimitError", () => {
  it("detects 'rate limit' in message", () => {
    expect(isRateLimitError("Rate limit exceeded")).toBe(true);
    expect(isRateLimitError("You've hit a RATE LIMIT")).toBe(true);
  });

  it("detects 'status 429'", () => {
    expect(isRateLimitError("Request failed with status 429")).toBe(true);
  });

  it("detects 'http 429'", () => {
    expect(isRateLimitError("HTTP 429 Too Many Requests")).toBe(true);
  });

  it("detects 'too many requests'", () => {
    expect(isRateLimitError("Too many requests, please wait")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRateLimitError("Network timeout")).toBe(false);
    expect(isRateLimitError("Authentication failed")).toBe(false);
    expect(isRateLimitError("Out of memory")).toBe(false);
  });
});

// ── parseRateLimitResetTime ───────────────────────────────────────

describe("parseRateLimitResetTime", () => {
  // Use local-time reference to avoid timezone issues with getHours/setHours
  function makeLocalRef(hour: number, minute: number): Date {
    const d = new Date();
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  describe("Pattern 1: resets at HH:MM AM/PM", () => {
    it("parses 'resets at 2:42 AM'", () => {
      const ref = makeLocalRef(1, 0); // 1:00 AM local — 2:42 AM is in the future
      const result = parseRateLimitResetTime("Rate limit resets at 2:42 AM", ref);
      expect(result).not.toBeNull();
      expect(result!.getMinutes()).toBe(42);
      // Result should be in the future relative to ref
      expect(result!.getTime()).toBeGreaterThan(ref.getTime());
    });

    it("parses 'reset at 3:15 PM'", () => {
      const ref = makeLocalRef(14, 0); // 2:00 PM local — 3:15 PM is in the future
      const result = parseRateLimitResetTime("Rate limit reset at 3:15 PM", ref);
      expect(result).not.toBeNull();
      expect(result!.getHours()).toBe(15);
      expect(result!.getMinutes()).toBe(15);
    });

    it("handles 12:00 PM (noon)", () => {
      const ref = makeLocalRef(11, 0);
      const result = parseRateLimitResetTime("resets at 12:00 PM", ref);
      expect(result).not.toBeNull();
      expect(result!.getHours()).toBe(12);
    });

    it("handles 12:00 AM (midnight)", () => {
      const ref = makeLocalRef(23, 0);
      const result = parseRateLimitResetTime("resets at 12:00 AM", ref);
      expect(result).not.toBeNull();
      expect(result!.getHours()).toBe(0);
      // Midnight is after 23:00 → next day
      expect(result!.getTime()).toBeGreaterThan(ref.getTime());
    });

    it("wraps to next day if reset time is in the past", () => {
      const lateRef = makeLocalRef(23, 0);
      const result = parseRateLimitResetTime("resets at 1:00 AM", lateRef);
      expect(result).not.toBeNull();
      // Should be next day (comparing local dates since setHours uses local)
      expect(result!.getTime()).toBeGreaterThan(lateRef.getTime());
      // The gap should be ~2 hours (from 23:00 to next day 01:00)
      const gapHours = (result!.getTime() - lateRef.getTime()) / (60 * 60 * 1000);
      expect(gapHours).toBe(2);
    });
  });

  describe("Pattern 2: try again in N minutes", () => {
    it("parses 'try again in 23 minutes'", () => {
      const ref = makeLocalRef(2, 19);
      const result = parseRateLimitResetTime("Please try again in 23 minutes", ref);
      expect(result).not.toBeNull();
      const expectedMs = ref.getTime() + 23 * 60 * 1000;
      expect(result!.getTime()).toBe(expectedMs);
    });

    it("parses 'wait in 5 min'", () => {
      const ref = makeLocalRef(2, 19);
      const result = parseRateLimitResetTime("wait in 5 min", ref);
      expect(result).not.toBeNull();
      const expectedMs = ref.getTime() + 5 * 60 * 1000;
      expect(result!.getTime()).toBe(expectedMs);
    });

    it("parses 'retry in 10 minutes'", () => {
      const ref = makeLocalRef(2, 19);
      const result = parseRateLimitResetTime("Please retry in 10 minutes", ref);
      expect(result).not.toBeNull();
      const expectedMs = ref.getTime() + 10 * 60 * 1000;
      expect(result!.getTime()).toBe(expectedMs);
    });
  });

  describe("Pattern 3: Retry-After header", () => {
    it("parses 'Retry-After: 60' (seconds)", () => {
      const ref = makeLocalRef(2, 19);
      const result = parseRateLimitResetTime("Headers: Retry-After: 60", ref);
      expect(result).not.toBeNull();
      const expectedMs = ref.getTime() + 60 * 1000;
      expect(result!.getTime()).toBe(expectedMs);
    });

    it("parses 'retry-after: 1800' (case insensitive)", () => {
      const ref = makeLocalRef(2, 19);
      const result = parseRateLimitResetTime("retry-after: 1800", ref);
      expect(result).not.toBeNull();
      const expectedMs = ref.getTime() + 1800 * 1000;
      expect(result!.getTime()).toBe(expectedMs);
    });
  });

  describe("Unparseable messages", () => {
    it("returns null for messages without time info", () => {
      expect(parseRateLimitResetTime("Rate limit exceeded")).toBeNull();
      expect(parseRateLimitResetTime("Too many requests")).toBeNull();
      expect(parseRateLimitResetTime("")).toBeNull();
    });
  });
});

// ── RATE_LIMIT_FALLBACK_MS ────────────────────────────────────────

describe("RATE_LIMIT_FALLBACK_MS", () => {
  it("is 30 minutes in milliseconds", () => {
    expect(RATE_LIMIT_FALLBACK_MS).toBe(30 * 60 * 1000);
  });
});
