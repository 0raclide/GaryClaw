import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OracleMemoryConfig, DomainSection } from "../src/types.js";
import {
  isTopicStale,
  parseDomainSections,
  mergeDomainSections,
  buildResearchPrompt,
  createResearchCanUseTool,
  runResearch,
} from "../src/researcher.js";
import type { ResearchConfig } from "../src/researcher.js";
import { initOracleMemory, writeDomainExpertise } from "../src/oracle-memory.js";

const BASE_DIR = join(tmpdir(), `garyclaw-researcher-${Date.now()}`);
let memConfig: OracleMemoryConfig;

function makeMemConfig(): OracleMemoryConfig {
  return {
    globalDir: join(BASE_DIR, "global", "oracle-memory"),
    projectDir: join(BASE_DIR, "project", ".garyclaw", "oracle-memory"),
  };
}

function makeDomainContent(sections: Partial<DomainSection>[]): string {
  return (
    "# Domain Expertise\n\n" +
    sections
      .map((s) => {
        const topic = s.topic ?? "Test Topic";
        const lastResearched = s.lastResearched ?? new Date().toISOString();
        const searchCount = s.searchCount ?? 5;
        const partial = s.partial ?? false;
        const content = s.content ?? "## Current SOTA\n- Test content";
        return `---\ntopic: ${topic}\nlast_researched: ${lastResearched}\nsearch_count: ${searchCount}\npartial: ${partial}\n---\n\n${content}`;
      })
      .join("\n\n")
  );
}

beforeEach(() => {
  memConfig = makeMemConfig();
  mkdirSync(BASE_DIR, { recursive: true });
  initOracleMemory(memConfig);
});

afterEach(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});

describe("researcher", () => {
  // ── isTopicStale ───────────────────────────────────────────────

  describe("isTopicStale", () => {
    it("returns true when no existing content", () => {
      expect(isTopicStale(null, "WebSockets")).toBe(true);
    });

    it("returns true when topic not found in existing content", () => {
      const content = makeDomainContent([{ topic: "React" }]);
      expect(isTopicStale(content, "WebSockets")).toBe(true);
    });

    it("returns false when topic is fresh (< 14 days)", () => {
      const content = makeDomainContent([{
        topic: "WebSockets",
        lastResearched: new Date().toISOString(),
      }]);
      expect(isTopicStale(content, "WebSockets")).toBe(false);
    });

    it("returns true when topic is stale (> 14 days)", () => {
      const staleDate = new Date(Date.now() - 15 * 86_400_000).toISOString();
      const content = makeDomainContent([{
        topic: "WebSockets",
        lastResearched: staleDate,
      }]);
      expect(isTopicStale(content, "WebSockets")).toBe(true);
    });

    it("respects custom freshness window", () => {
      const content = makeDomainContent([{
        topic: "WebSockets",
        lastResearched: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      }]);
      // 2-day window → stale
      expect(isTopicStale(content, "WebSockets", 2)).toBe(true);
      // 5-day window → fresh
      expect(isTopicStale(content, "WebSockets", 5)).toBe(false);
    });

    it("is case-insensitive for topic matching", () => {
      const content = makeDomainContent([{
        topic: "WebSockets",
        lastResearched: new Date().toISOString(),
      }]);
      expect(isTopicStale(content, "websockets")).toBe(false);
      expect(isTopicStale(content, "WEBSOCKETS")).toBe(false);
    });

    it("returns true for malformed lastResearched date", () => {
      const content = makeDomainContent([{
        topic: "WebSockets",
        lastResearched: "not-a-date",
      }]);
      expect(isTopicStale(content, "WebSockets")).toBe(true);
    });
  });

  // ── parseDomainSections ────────────────────────────────────────

  describe("parseDomainSections", () => {
    it("returns empty array for empty content", () => {
      expect(parseDomainSections("")).toEqual([]);
      expect(parseDomainSections("   ")).toEqual([]);
    });

    it("parses single topic section", () => {
      const content = makeDomainContent([{
        topic: "WebSockets",
        lastResearched: "2026-03-20T10:00:00Z",
        searchCount: 6,
        partial: false,
        content: "## Current SOTA\n- ws is the standard",
      }]);

      const sections = parseDomainSections(content);
      expect(sections).toHaveLength(1);
      expect(sections[0].topic).toBe("WebSockets");
      expect(sections[0].lastResearched).toBe("2026-03-20T10:00:00Z");
      expect(sections[0].searchCount).toBe(6);
      expect(sections[0].partial).toBe(false);
      expect(sections[0].content).toContain("ws is the standard");
    });

    it("parses multiple topic sections", () => {
      const content = makeDomainContent([
        { topic: "WebSockets", searchCount: 6 },
        { topic: "OAuth 2.1", searchCount: 4 },
        { topic: "ARM NEON", searchCount: 3 },
      ]);

      const sections = parseDomainSections(content);
      expect(sections).toHaveLength(3);
      expect(sections.map((s) => s.topic)).toEqual(["WebSockets", "OAuth 2.1", "ARM NEON"]);
    });

    it("handles partial flag correctly", () => {
      const content = makeDomainContent([
        { topic: "Partial Topic", partial: true },
        { topic: "Complete Topic", partial: false },
      ]);

      const sections = parseDomainSections(content);
      expect(sections[0].partial).toBe(true);
      expect(sections[1].partial).toBe(false);
    });

    it("returns empty for content without frontmatter", () => {
      const content = "# Domain Expertise\n\nJust some text without sections.";
      const sections = parseDomainSections(content);
      expect(sections).toEqual([]);
    });

    it("handles adjacent sections without body text", () => {
      // Two frontmatter blocks back-to-back with no body content between them.
      // The parser must detect that the "body" chunk is actually the next
      // section's frontmatter and assign empty content to the first section.
      const content = [
        "# Domain Expertise",
        "",
        "---",
        "topic: WebSockets",
        "last_researched: 2026-03-20T10:00:00Z",
        "search_count: 3",
        "partial: false",
        "---",
        "---",
        "topic: OAuth 2.1",
        "last_researched: 2026-03-21T10:00:00Z",
        "search_count: 5",
        "partial: false",
        "---",
        "",
        "## OAuth Body",
        "OAuth 2.1 content here.",
      ].join("\n");

      const sections = parseDomainSections(content);
      expect(sections).toHaveLength(2);
      expect(sections[0].topic).toBe("WebSockets");
      expect(sections[0].content).toBe(""); // No body — adjacent frontmatter
      expect(sections[1].topic).toBe("OAuth 2.1");
      expect(sections[1].content).toContain("OAuth 2.1 content here.");
    });

    it("handles all sections without body text", () => {
      // Three frontmatter blocks, none with body text.
      const content = [
        "---",
        "topic: Topic A",
        "last_researched: 2026-03-20T10:00:00Z",
        "search_count: 1",
        "partial: true",
        "---",
        "---",
        "topic: Topic B",
        "last_researched: 2026-03-21T10:00:00Z",
        "search_count: 2",
        "partial: true",
        "---",
        "---",
        "topic: Topic C",
        "last_researched: 2026-03-22T10:00:00Z",
        "search_count: 3",
        "partial: true",
        "---",
      ].join("\n");

      const sections = parseDomainSections(content);
      expect(sections).toHaveLength(3);
      expect(sections.map((s) => s.topic)).toEqual(["Topic A", "Topic B", "Topic C"]);
      // All should have empty content since they're all adjacent frontmatter
      expect(sections[0].content).toBe("");
      expect(sections[1].content).toBe("");
      expect(sections[2].content).toBe("");
      // All should be marked partial
      expect(sections.every((s) => s.partial)).toBe(true);
    });
  });

  // ── mergeDomainSections ────────────────────────────────────────

  describe("mergeDomainSections", () => {
    it("appends new topic to empty existing", () => {
      const newSection: DomainSection = {
        topic: "WebSockets",
        lastResearched: "2026-03-26T10:00:00Z",
        searchCount: 5,
        partial: false,
        content: "## Current SOTA\n- ws v8.x",
      };

      const result = mergeDomainSections([], newSection, 20_000);
      expect(result).toContain("WebSockets");
      expect(result).toContain("ws v8.x");
    });

    it("replaces existing topic with fresh data", () => {
      const existing: DomainSection[] = [{
        topic: "WebSockets",
        lastResearched: "2026-03-10T10:00:00Z",
        searchCount: 3,
        partial: false,
        content: "## Current SOTA\n- old info",
      }];

      const newSection: DomainSection = {
        topic: "WebSockets",
        lastResearched: "2026-03-26T10:00:00Z",
        searchCount: 6,
        partial: false,
        content: "## Current SOTA\n- new info",
      };

      const result = mergeDomainSections(existing, newSection, 20_000);
      expect(result).toContain("new info");
      expect(result).not.toContain("old info");

      // Verify only one section for this topic
      const sections = parseDomainSections(result);
      const wsSections = sections.filter((s) => s.topic === "WebSockets");
      expect(wsSections).toHaveLength(1);
    });

    it("appends new topic alongside existing topics", () => {
      const existing: DomainSection[] = [{
        topic: "React",
        lastResearched: "2026-03-20T10:00:00Z",
        searchCount: 4,
        partial: false,
        content: "## Current SOTA\n- React 19",
      }];

      const newSection: DomainSection = {
        topic: "WebSockets",
        lastResearched: "2026-03-26T10:00:00Z",
        searchCount: 5,
        partial: false,
        content: "## Current SOTA\n- ws v8.x",
      };

      const result = mergeDomainSections(existing, newSection, 20_000);
      const sections = parseDomainSections(result);
      expect(sections).toHaveLength(2);
      expect(sections.map((s) => s.topic)).toEqual(["React", "WebSockets"]);
    });

    it("drops oldest topics when over token budget", () => {
      // Create sections with enough content to exceed a small budget
      const existing: DomainSection[] = [
        {
          topic: "Old Topic",
          lastResearched: "2026-01-01T00:00:00Z",
          searchCount: 5,
          partial: false,
          content: "A".repeat(2000),
        },
        {
          topic: "Medium Topic",
          lastResearched: "2026-02-01T00:00:00Z",
          searchCount: 3,
          partial: false,
          content: "B".repeat(2000),
        },
      ];

      const newSection: DomainSection = {
        topic: "New Topic",
        lastResearched: "2026-03-26T10:00:00Z",
        searchCount: 6,
        partial: false,
        content: "C".repeat(2000),
      };

      // Tiny budget forces dropping old topics
      const result = mergeDomainSections(existing, newSection, 800);
      const sections = parseDomainSections(result);

      // Should keep the new section
      expect(sections.some((s) => s.topic === "New Topic")).toBe(true);
      // Old topic should be dropped first
      expect(sections.some((s) => s.topic === "Old Topic")).toBe(false);
    });

    it("handles case-insensitive topic replacement", () => {
      const existing: DomainSection[] = [{
        topic: "WebSockets",
        lastResearched: "2026-03-10T10:00:00Z",
        searchCount: 3,
        partial: false,
        content: "old",
      }];

      const newSection: DomainSection = {
        topic: "websockets",
        lastResearched: "2026-03-26T10:00:00Z",
        searchCount: 6,
        partial: false,
        content: "new",
      };

      const result = mergeDomainSections(existing, newSection, 20_000);
      const sections = parseDomainSections(result);
      expect(sections).toHaveLength(1);
      expect(sections[0].content).toBe("new");
    });
  });

  // ── buildResearchPrompt ────────────────────────────────────────

  describe("buildResearchPrompt", () => {
    it("builds prompt for new topic (no existing knowledge)", () => {
      const prompt = buildResearchPrompt("WebSockets", null);
      expect(prompt).toContain("WebSockets");
      expect(prompt).toContain("WebSearch");
      expect(prompt).toContain("Current SOTA");
      expect(prompt).not.toContain("Existing Knowledge");
    });

    it("includes existing knowledge when provided", () => {
      const prompt = buildResearchPrompt("WebSockets", "ws is the standard library");
      expect(prompt).toContain("Existing Knowledge");
      expect(prompt).toContain("ws is the standard library");
      expect(prompt).toContain("Update this with current information");
    });

    it("handles long topic names", () => {
      const longTopic = "A".repeat(200);
      const prompt = buildResearchPrompt(longTopic, null);
      expect(prompt).toContain(longTopic);
    });
  });

  // ── createResearchCanUseTool ───────────────────────────────────

  describe("createResearchCanUseTool", () => {
    it("allows WebSearch", async () => {
      const result = await createResearchCanUseTool("WebSearch");
      expect(result.behavior).toBe("allow");
    });

    it("allows WebFetch", async () => {
      const result = await createResearchCanUseTool("WebFetch");
      expect(result.behavior).toBe("allow");
    });

    it("allows Read", async () => {
      const result = await createResearchCanUseTool("Read");
      expect(result.behavior).toBe("allow");
    });

    it("denies Edit", async () => {
      const result = await createResearchCanUseTool("Edit");
      expect(result.behavior).toBe("deny");
      expect(result.message).toContain("denied: Edit");
    });

    it("denies Write", async () => {
      const result = await createResearchCanUseTool("Write");
      expect(result.behavior).toBe("deny");
    });

    it("denies Bash", async () => {
      const result = await createResearchCanUseTool("Bash");
      expect(result.behavior).toBe("deny");
    });

    it("denies Glob", async () => {
      const result = await createResearchCanUseTool("Glob");
      expect(result.behavior).toBe("deny");
    });

    it("denies Grep", async () => {
      const result = await createResearchCanUseTool("Grep");
      expect(result.behavior).toBe("deny");
    });
  });

  // ── runResearch (mocked SDK) ───────────────────────────────────

  describe("runResearch", () => {
    function makeResearchConfig(overrides: Partial<ResearchConfig> = {}): ResearchConfig {
      return {
        topic: "WebSockets",
        projectDir: join(BASE_DIR, "project"),
        maxSearches: 10,
        timeoutMs: 300_000,
        force: false,
        oracleMemoryConfig: memConfig,
        ...overrides,
      };
    }

    /** Create a mock SDK segment that yields messages then a result */
    function mockSegment(resultText: string, searchCount = 3) {
      return async function* (_options: any) {
        // Simulate assistant messages with WebSearch tool_use
        for (let i = 0; i < searchCount; i++) {
          yield {
            type: "assistant",
            message: {
              content: [
                { type: "tool_use", name: "WebSearch", input: { query: "test" } },
              ],
            },
          };
        }
        // Final result
        yield {
          type: "result",
          subtype: "success",
          result: resultText,
        };
      };
    }

    it("runs successful research and writes domain-expertise.md", async () => {
      const config = makeResearchConfig({ force: true });
      const resultText = "## Current SOTA\n- ws v8.x is standard\n\n## What Works\n- heartbeat every 30s";

      const result = await runResearch(config, mockSegment(resultText, 5));

      expect(result.topic).toBe("WebSockets");
      expect(result.searchesUsed).toBe(5);
      expect(result.partial).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.sectionsFound).toBeGreaterThanOrEqual(1);
    });

    it("skips research when topic is fresh", async () => {
      // Write fresh content first
      const freshContent = makeDomainContent([{
        topic: "WebSockets",
        lastResearched: new Date().toISOString(),
        content: "## Current SOTA\n- already researched",
      }]);
      writeDomainExpertise(memConfig, freshContent);

      const config = makeResearchConfig({ force: false });

      const result = await runResearch(config, mockSegment("should not be used"));

      expect(result.skipped).toBe(true);
      expect(result.searchesUsed).toBe(0);
    });

    it("forces research even when topic is fresh", async () => {
      // Write fresh content first
      const freshContent = makeDomainContent([{
        topic: "WebSockets",
        lastResearched: new Date().toISOString(),
        content: "## Current SOTA\n- already researched",
      }]);
      writeDomainExpertise(memConfig, freshContent);

      const config = makeResearchConfig({ force: true });

      const result = await runResearch(config, mockSegment("## Current SOTA\n- fresh data", 2));

      expect(result.skipped).toBe(false);
      expect(result.searchesUsed).toBe(2);
    });

    it("handles SDK error gracefully", async () => {
      const config = makeResearchConfig({ force: true });

      async function* failingSegment(_options: any) {
        throw new Error("WebSearch unavailable");
      }

      const result = await runResearch(config, failingSegment);

      expect(result.partial).toBe(true);
      expect(result.skipped).toBe(false);
    });

    it("produces partial result on timeout", async () => {
      const config = makeResearchConfig({ force: true, timeoutMs: 50 });

      // Slow segment that never completes before timeout
      async function* slowSegment(_options: any) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        yield {
          type: "result",
          subtype: "success",
          result: "## Current SOTA\n- late data",
        };
      }

      const result = await runResearch(config, slowSegment);

      expect(result.partial).toBe(true);
      expect(result.skipped).toBe(false);
    });
  });
});
