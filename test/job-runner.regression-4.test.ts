/**
 * Job Runner regression: parsePriorityPickTitle edge cases.
 */

import { describe, it, expect } from "vitest";
import { parsePriorityPickTitle } from "../src/job-runner.js";

describe("parsePriorityPickTitle", () => {
  it("extracts title from standard priority.md format", () => {
    const content = `# Priority Report\n\n## Top Pick: Implement WebSocket reconnection\n\nSome details...`;
    expect(parsePriorityPickTitle(content)).toBe("Implement WebSocket reconnection");
  });

  it("trims whitespace from title", () => {
    const content = `## Top Pick:   Add retry logic  \nMore text`;
    expect(parsePriorityPickTitle(content)).toBe("Add retry logic");
  });

  it("returns null when no Top Pick header exists", () => {
    const content = `# Priority Report\n\nNo pick here.\n## Other Section`;
    expect(parsePriorityPickTitle(content)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(parsePriorityPickTitle("")).toBeNull();
  });

  it("handles 'Backlog Exhausted' as a valid title", () => {
    const content = `## Top Pick: Backlog Exhausted\n\nNothing left to do.`;
    expect(parsePriorityPickTitle(content)).toBe("Backlog Exhausted");
  });

  it("handles title with special characters", () => {
    const content = `## Top Pick: Fix N+1 query in /api/users (perf: ~200ms)\nDetails`;
    expect(parsePriorityPickTitle(content)).toBe("Fix N+1 query in /api/users (perf: ~200ms)");
  });

  it("picks first Top Pick when multiple exist", () => {
    const content = `## Top Pick: First item\n\n## Top Pick: Second item`;
    expect(parsePriorityPickTitle(content)).toBe("First item");
  });
});
